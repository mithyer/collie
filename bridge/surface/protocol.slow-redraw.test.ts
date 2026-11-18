// A box that draws what it is given a little late (a loaded machine, a busy agent): the probe character shows on the
// second read, and so does the Backspace that takes it out again.
//
// Before this test the probe's two halves shared three reads: the character took two, Backspace was left one read, 80 ms
// after the key, and a box that had not redrawn yet ended `refused(probe_failed)` with "Backspace did not give the box
// back as it was." Nothing was typed and the next send went through, which is how a person met it: a red "Not sent"
// that went away on a second tap (a pi pane under load, 4 of 20 probed sends on one day, 2026-11-18).
//
// The pane is a fake like the one of protocol.deaf-box.test.ts: the omp 18.12.6 idle capture with an empty box, a box
// that changes at once in the pane's memory but shows the change `lag` reads later.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { LaunchWindow } from "../launch-window.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
/** omp 18.12.6 idle, an empty box. */
const OMP_UP = readFileSync(join(SURFACE, "omp--v18-12-6-status-row-idle.txt"), "utf8");

/**
 * An omp screen whose box row holds `box` in the pane's memory and `shown` on the screen. A change of the box reaches
 * the screen on the read that comes `lag` reads after it (`lag` 0 draws at once, as the older tests' panes do).
 */
class LaggyPane {
  /** What the box holds. */
  box = "";
  /** What the screen draws of it. */
  shown = "";
  /** The texts that were submitted. */
  submitted: string[] = [];
  /** How many reads a change of the box waits before the screen shows it. */
  lag: number;
  private sinceChange = 0;
  private reads = 0;
  private head: string[] = [];
  private tail: string[] = [];
  private hint = "";
  private hintAt = 0;

  constructor(capture: string, lag: number) {
    this.lag = lag;
    const rows = capture.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const at = rows.findLastIndex((row) => row.startsWith("╰─"));
    if (at < 0) throw new Error("the capture has no box row");
    this.head = rows.slice(0, at);
    this.tail = rows.slice(at + 1);
    const row = rows[at]!;
    const parts = /^╰─ ?(.*?)( {2,}.*)?$/u.exec(row)!;
    this.box = (parts[1] ?? "").trim();
    this.shown = this.box;
    this.hint = (parts[2] ?? "").trim();
    this.hintAt = row.length - (parts[2] ?? "").trimStart().length;
  }

  /** The number of reads of the screen so far. */
  get readCount(): number {
    return this.reads;
  }

  /** The box changed now: the screen shows it `lag` reads from here. */
  private changed(): void {
    this.sinceChange = 0;
  }

  private render(): string {
    const lead = this.shown === "" ? "╰─" : `╰─ ${this.shown}`;
    const row = this.hint === "" ? lead : `${lead.padEnd(Math.max(this.hintAt, lead.length + 2))}${this.hint}`;
    return [...this.head, row, ...this.tail].join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    if (this.shown !== this.box) {
      if (this.sinceChange >= this.lag) this.shown = this.box;
      else this.sinceChange++;
    }
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: 0 }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.box += text;
    this.changed();
    return Promise.resolve(muxAck());
  };

  pasteText = this.typeText;

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if ((key === "Enter" || key === "ctrl+q" || key === "alt+Enter") && this.box.length > 0) {
        this.submitted.push(this.box);
        this.head.splice(this.head.length - 1, 0, ` ${this.box}`);
        this.box = "";
      }
      this.changed();
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-slow-redraw-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol on `pane` for omp 18.12.6 (provisional: every send is probed) with a clock that only the pauses move. */
function rig(pane: LaggyPane) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const window = new LaunchWindow(now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "18.12.6", { log: () => undefined })),
    generation: () => "omp:-",
    starting: (paneId, named) => window.starting("main", paneId, named),
    framed: (paneId, harness) => window.framed("main", paneId, harness),
    deaf: (paneId, harness, typedAt) => window.deaf("main", paneId, harness, typedAt),
    pending: (paneId) => window.pending("main", paneId),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-slow-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "omp" });
  return { send, clock, protocol };
}

describe("a box that draws late", () => {
  test("a box that draws at once is sent to as before", async () => {
    const pane = new LaggyPane(OMP_UP, 0);
    const answer = await rig(pane).send("hello at once");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["hello at once"]);
  });

  test("the probe that shows on the second read and the Backspace that shows on the second read still send the text", async () => {
    const pane = new LaggyPane(OMP_UP, 1);
    const answer = await rig(pane).send("hello a little late");
    // Before the fix: refused(probe_failed), "Backspace did not give the box back as it was."
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["hello a little late"]);
    expect(pane.box).toBe("");
  });

  test("a box that never gives the probe back is still refused, with nothing sent", async () => {
    const pane = new LaggyPane(OMP_UP, 50);
    const answer = await rig(pane).send("hello never");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.submitted).toEqual([]);
  });
});
