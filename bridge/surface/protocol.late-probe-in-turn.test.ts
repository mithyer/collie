// A pi pane whose turn runs and whose process draws a typed key late (2026-11-26). A pi session with a long
// transcript took 0.3 to 1.5 s to draw a key while its turn ran, and 100% of one core: the probe's two
// reads (80 and 240 ms after it) saw an empty box, so every send ended `probe_failed`; the character was
// drawn after that, so every next send found a draft of Collie's own marker and ended `draft_present`.
// The late-probe window (LATE_PROBE) opened only on an idle turn. The lab (a scratch pi on herdr-core,
// stopped and resumed with SIGSTOP and SIGCONT around each send) gave the same receipts: 0 of 8 sends
// reached the agent; with the window open in a queued turn, and a patient Backspace half, 10 of 10.
//
// The screen is a real pi capture (running turn, goal widget over the box, five rows under it); the box
// is drawn from what reached the agent, and a late agent draws every text and key `lateMs` after it
// was written, in order. TEST: the `lateWindowOpens` / `queuedInTurn` rule in protocol.ts.

import { describe, expect, test } from "bun:test";
import { muxAck } from "../mux/types.ts";
import { FakePane, fixture, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

const RUNNING = "pi--v130-powerline-goal-widget-running--w254.txt";
const IDLE = "pi--v130-powerline-goal-widget-idle--w254.txt";

// eslint-disable-next-line no-control-regex
const plain = (row: string): string => row.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "");

interface Clock {
  now: number;
}

/** A pi pane over a capture: its box redrawn from the pane's text; Alt+Enter submits the box. */
function piPane(name: string): FakePane {
  const rows = fixture(name).split(/\r?\n/u);
  const pane = new FakePane();
  pane.afterInput = (p, what) => {
    if (what.startsWith("keys:") && what.includes("alt+Enter")) p.box = "";
  };
  pane.render = () => rows.map((row) => (/^ >(?: |$)/u.test(plain(row)) ? ` > ${pane.box}` : row)).join("\r\n");
  return pane;
}

/**
 * Makes the agent draw late: a write is acknowledged at once, and lands in the box `lateMs` after the
 * rig's clock saw it, in order, at the next read that finds it due.
 */
function drawLate(pane: FakePane, clock: Clock, lateMs: number): void {
  const pending: Array<{ readonly at: number; readonly land: () => void }> = [];
  const due = (): void => {
    while (pending.length > 0 && pending[0]!.at <= clock.now) pending.shift()!.land();
  };
  const { typeText, pasteText, writeKeys, readGrid } = pane;
  pane.typeText = (id, text) => {
    pending.push({ at: clock.now + lateMs, land: () => void typeText(id, text) });
    return Promise.resolve(muxAck());
  };
  pane.pasteText = (id, text) => {
    pending.push({ at: clock.now + lateMs, land: () => void pasteText(id, text) });
    return Promise.resolve(muxAck());
  };
  pane.writeKeys = (id, keys) => {
    pending.push({ at: clock.now + lateMs, land: () => void writeKeys(id, keys) });
    return Promise.resolve(muxAck());
  };
  pane.readGrid = (id, request) => {
    due();
    return readGrid(id, request);
  };
}

function lateRig(name: string, lateMs: number) {
  const clock: Clock = { now: 1_000_000 };
  const pane = piPane(name);
  drawLate(pane, clock, lateMs);
  return rig({ pane, harness: "pi", version: "1.3.0", clock });
}

describe("a pi pane that draws keys late", () => {
  test("a running turn: a probe drawn 600 ms late is seen in the late window, and the send goes on", async () => {
    const r = lateRig(RUNNING, 600);
    const answer = await r.send("Reply with exactly OK-1");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "alt+Enter"] });
  });

  test("a running turn: a probe drawn at once passes on its own reads, and the window never opens", async () => {
    const r = lateRig(RUNNING, 0);
    const answer = await r.send("Reply with exactly OK-2");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    // 80 ms and 240 ms of reads for the character, and no window: far under the window's first read at 1 s.
    expect(answer.receipt?.gapsMs.probe ?? 0).toBeLessThan(1000);
  });

  test("a running turn: a probe that is never drawn ends probe_failed after the window, with no key sent", async () => {
    const r = lateRig(RUNNING, 3_600_000);
    const answer = await r.send("Reply with exactly OK-3");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(answer.receipt?.keys).not.toContain("alt+Enter");
  });

  test("an idle turn keeps its window, as before", async () => {
    const r = lateRig(IDLE, 600);
    const answer = await r.send("Reply with exactly OK-4");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "alt+Enter"] });
  });
});
