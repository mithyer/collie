import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import {
  coercePhoneRules,
  defaultPhoneRules,
  type GateRender,
  inQuietHours,
  paneKey,
  parseRulesRequest,
  type PhoneRules,
  RULE_LIMITS,
  renderKind,
  RulesGate,
  RulesStore,
} from "./notify-rules.ts";

// The Dogr build's per-phone notification rules: what an upload may say, what the store keeps, and
// what the gate decides from it. The gate is driven with injected effects, so no test waits for a
// real clock. The seam into push.ts is exercised in push-rules.test.ts.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-rules-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** The defaults with some fields replaced, as a phone's upload would. */
function rules(change: Partial<PhoneRules> = {}): PhoneRules {
  return { ...defaultPhoneRules(), ...change };
}

describe("coercePhoneRules — an upload is clamped, never trusted", () => {
  test("anything that is not an object gives the defaults", () => {
    const garbage: (JsonValue | undefined)[] = [undefined, null, 3, "x", true, [1, 2]];
    for (const raw of garbage) {
      expect(coercePhoneRules(raw)).toEqual(defaultPhoneRules());
    }
  });

  test("a mistyped field falls back to its default and a good neighbour is kept", () => {
    const got = coercePhoneRules({
      blocked: { on: "yes", waitSec: 45 },
      done: { on: false, waitSec: "soon" },
      steadySec: null,
      repeat: { on: true },
    });
    expect(got.blocked).toEqual({ on: true, waitSec: 45 });
    expect(got.done).toEqual({ on: false, waitSec: 30 });
    expect(got.steadySec).toBe(10);
    expect(got.repeat).toEqual({ on: true, everyMin: 10, count: 3 });
  });

  test("every number is clamped into its range and rounded", () => {
    const got = coercePhoneRules({
      blocked: { waitSec: 99_999 },
      done: { waitSec: -5 },
      steadySec: 61.4,
      repeat: { everyMin: 0, count: 50 },
      quiet: { on: true, fromMin: -1, toMin: 5000, utcOffsetMin: 9999 },
    });
    expect(got.blocked.waitSec).toBe(RULE_LIMITS.waitSec.max);
    expect(got.done.waitSec).toBe(RULE_LIMITS.waitSec.min);
    expect(got.steadySec).toBe(RULE_LIMITS.steadySec.max);
    expect(got.repeat.everyMin).toBe(RULE_LIMITS.everyMin.min);
    expect(got.repeat.count).toBe(RULE_LIMITS.count.max);
    expect(got.quiet).toEqual({ on: true, fromMin: 0, toMin: 1439, utcOffsetMin: RULE_LIMITS.utcOffsetMin.max });
    expect(coercePhoneRules({ steadySec: 7.6 }).steadySec).toBe(8);
  });

  test("a number that is not finite is the default, not a clamp", () => {
    // JSON cannot carry NaN or Infinity, but a value built in code can reach the store.
    expect(coercePhoneRules({ steadySec: Number.NaN }).steadySec).toBe(10);
    expect(coercePhoneRules({ steadySec: Number.POSITIVE_INFINITY }).steadySec).toBe(10);
  });

  test("pane choices keep only on/off, usable keys, and at most the limit", () => {
    const many: Record<string, JsonValue> = {};
    for (let i = 0; i < RULE_LIMITS.panes + 40; i++) many[`w1:p${100 + i}`] = "off";
    const got = coercePhoneRules({
      // The first keys are read first, so they are the ones the limit keeps.
      panes: { "w1:p1": "off", "w1:p2": "on", "w1:p3": "maybe", "": "off", "a\nb": "off", [`x${"y".repeat(130)}`]: "off", ...many },
    });
    expect(got.panes["w1:p1"]).toBe("off");
    expect(got.panes["w1:p2"]).toBe("on");
    expect(got.panes["w1:p3"]).toBeUndefined();
    expect(got.panes[""]).toBeUndefined();
    expect(got.panes["a\nb"]).toBeUndefined();
    expect(Object.keys(got.panes).length).toBe(RULE_LIMITS.panes);
  });

  test("a stored copy coerces to itself", () => {
    const first = coercePhoneRules({ blocked: { on: false, waitSec: 5 }, panes: { "w1:p1": "off" } });
    expect(coercePhoneRules(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });
});

describe("parseRulesRequest", () => {
  test("refuses a body that is not an object", () => {
    expect(parseRulesRequest(null)).toBeNull();
    expect(parseRulesRequest([])).toBeNull();
    expect(parseRulesRequest("x")).toBeNull();
    expect(parseRulesRequest(4)).toBeNull();
  });

  test("an empty object is a valid upload of the defaults", () => {
    expect(parseRulesRequest({})).toEqual(defaultPhoneRules());
  });
});

describe("paneKey", () => {
  test("the primary session has the bare pane id and any other is prefixed", () => {
    expect(paneKey("w1:p1")).toBe("w1:p1");
    expect(paneKey("w1:p1", "")).toBe("w1:p1");
    expect(paneKey("w1:p1", "work")).toBe("work:w1:p1");
  });
});

describe("inQuietHours", () => {
  /** Epoch ms of a UTC time on an arbitrary day. */
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 14, h, m);
  const quiet = (fromMin: number, toMin: number, utcOffsetMin = 0, on = true) => ({ on, fromMin, toMin, utcOffsetMin });

  test("off is never quiet", () => {
    expect(inQuietHours(quiet(0, 1439, 0, false), at(3))).toBe(false);
  });

  test("equal ends are an empty window, not all day", () => {
    expect(inQuietHours(quiet(600, 600), at(10))).toBe(false);
  });

  test("a window inside one day includes its start and excludes its end", () => {
    const w = quiet(9 * 60, 17 * 60);
    expect(inQuietHours(w, at(8, 59))).toBe(false);
    expect(inQuietHours(w, at(9))).toBe(true);
    expect(inQuietHours(w, at(16, 59))).toBe(true);
    expect(inQuietHours(w, at(17))).toBe(false);
  });

  test("a window that wraps past midnight covers both sides of it", () => {
    const w = quiet(23 * 60, 7 * 60);
    expect(inQuietHours(w, at(22, 59))).toBe(false);
    expect(inQuietHours(w, at(23))).toBe(true);
    expect(inQuietHours(w, at(3))).toBe(true);
    expect(inQuietHours(w, at(6, 59))).toBe(true);
    expect(inQuietHours(w, at(7))).toBe(false);
    expect(inQuietHours(w, at(12))).toBe(false);
  });

  test("the window is read on the phone's own clock", () => {
    // 15:30 UTC is 23:30 in UTC+8 and 10:30 in UTC-5.
    const w = (offset: number) => quiet(23 * 60, 7 * 60, offset);
    expect(inQuietHours(w(480), at(15, 30))).toBe(true);
    expect(inQuietHours(w(-300), at(15, 30))).toBe(false);
    // The local day rolls over correctly for a negative result (01:00 UTC at UTC-5 is 20:00).
    expect(inQuietHours(quiet(19 * 60, 21 * 60, -300), at(1))).toBe(true);
  });
});

describe("renderKind", () => {
  test("agent alerts map to their event, a mixed summary to its own kind", () => {
    expect(renderKind("agent.blocked")).toBe("blocked");
    expect(renderKind("herd.blocked")).toBe("blocked");
    expect(renderKind("ask.permission")).toBe("blocked");
    expect(renderKind("agent.done")).toBe("done");
    expect(renderKind("herd.done")).toBe("done");
    expect(renderKind("herd.mixed")).toBe("mixed");
  });

  test("a title the operator typed, or any other code, is not judged", () => {
    expect(renderKind(undefined)).toBe("other");
    expect(renderKind("ask.flood")).toBe("other");
  });
});

describe("RulesStore", () => {
  test("a missing file means no phone has uploaded anything", async () => {
    const store = new RulesStore({ stateDir: await tempDir() });
    await store.load();
    expect(store.all()).toEqual([]);
    expect(store.get("pixel")).toBeUndefined();
  });

  test("rules are saved owner-only and read back after a restart", async () => {
    const stateDir = await tempDir();
    const store = new RulesStore({ stateDir });
    await store.set("pixel", rules({ steadySec: 4, panes: { "w1:p1": "off" } }));
    const mode = (await stat(join(stateDir, "notify-rules.json"))).mode & 0o777;
    expect(mode).toBe(0o600);

    const again = new RulesStore({ stateDir });
    await again.load();
    expect(again.get("pixel")).toEqual(rules({ steadySec: 4, panes: { "w1:p1": "off" } }));
  });

  test("a copy handed out cannot change what is stored", async () => {
    const store = new RulesStore({ stateDir: await tempDir() });
    await store.set("pixel", rules());
    const got = store.get("pixel");
    expect(got).toBeDefined();
    if (got === undefined) return;
    got.blocked.on = false;
    got.panes["w1:p1"] = "off";
    expect(store.get("pixel")).toEqual(rules());
    for (const row of store.all()) row.steadySec = 55;
    expect(store.get("pixel")?.steadySec).toBe(10);
  });

  test("a second upload replaces the first", async () => {
    const store = new RulesStore({ stateDir: await tempDir() });
    await store.set("pixel", rules({ steadySec: 4 }));
    await store.set("pixel", rules({ steadySec: 9 }));
    expect(store.all()).toHaveLength(1);
    expect(store.get("pixel")?.steadySec).toBe(9);
  });

  test("forgetting says whether there was anything, and the file follows", async () => {
    const stateDir = await tempDir();
    const store = new RulesStore({ stateDir });
    await store.set("pixel", rules());
    expect(await store.forget("nobody")).toBe(false);
    expect(await store.forget("pixel")).toBe(true);
    const again = new RulesStore({ stateDir });
    await again.load();
    expect(again.all()).toEqual([]);
  });

  test("the oldest upload goes first when more phones than the limit have uploaded", async () => {
    const store = new RulesStore({ stateDir: await tempDir() });
    for (let i = 0; i < RULE_LIMITS.devices + 3; i++) await store.set(`phone-${i}`, rules());
    expect(store.all()).toHaveLength(RULE_LIMITS.devices);
    expect(store.get("phone-0")).toBeUndefined();
    expect(store.get("phone-2")).toBeUndefined();
    expect(store.get("phone-3")).toBeDefined();
    expect(store.get(`phone-${RULE_LIMITS.devices + 2}`)).toBeDefined();
  });

  test("a damaged file is read as empty, and a hand-edited one is clamped", async () => {
    const damaged = await tempDir();
    await writeFile(join(damaged, "notify-rules.json"), "{ not json");
    const a = new RulesStore({ stateDir: damaged });
    await a.load();
    expect(a.all()).toEqual([]);

    const edited = await tempDir();
    await writeFile(
      join(edited, "notify-rules.json"),
      JSON.stringify({ version: 1, devices: { pixel: { steadySec: 500 }, "bad\nkey": {} } }),
    );
    const b = new RulesStore({ stateDir: edited });
    await b.load();
    expect(b.get("pixel")?.steadySec).toBe(RULE_LIMITS.steadySec.max);
    expect(b.get("bad\nkey")).toBeUndefined();
    expect(JSON.parse(await readFile(join(edited, "notify-rules.json"), "utf8")).version).toBe(1);
  });
});

describe("RulesGate", () => {
  /** A gate over a real store, with the bridge's prefs, delay and screen under the test's control. */
  async function rig(options: { bridgeDelayMs?: number; prefs?: { blocked: boolean; done: boolean }; revisions?: (number | undefined)[] } = {}) {
    const store = new RulesStore({ stateDir: await tempDir() });
    const prefs = options.prefs ?? { blocked: true, done: false };
    const script = options.revisions ?? [1];
    const reads: number[] = [];
    const sleeps: number[] = [];
    let clock = 5_000_000;
    const gate = new RulesGate({
      store,
      prefs: () => prefs,
      bridgeDelayMs: options.bridgeDelayMs ?? 30_000,
      revision: () => {
        const next = script[Math.min(reads.length, script.length - 1)];
        reads.push(reads.length);
        return Promise.resolve(next);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => clock,
    });
    return { store, gate, prefs, reads, sleeps, setNow: (t: number) => (clock = t), now: () => clock };
  }

  const blocked = (paneId?: string, session?: string): GateRender => ({ kind: "blocked", paneId, session });
  const done = (paneId?: string): GateRender => ({ kind: "done", paneId });

  test("wants: the machine's own prefs, or any phone that asks", async () => {
    const { store, gate, prefs } = await rig({ prefs: { blocked: false, done: false } });
    expect(gate.wants("blocked")).toBe(false);
    await store.set("pixel", rules({ done: { on: true, waitSec: 30 }, blocked: { on: false, waitSec: 30 } }));
    expect(gate.wants("done")).toBe(true);
    expect(gate.wants("blocked")).toBe(false);
    prefs.blocked = true;
    expect(gate.wants("blocked")).toBe(true);
  });

  test("baseDelayMs: the shortest wait any interested phone asks for, never past the machine's own", async () => {
    const { store, gate } = await rig({ bridgeDelayMs: 30_000 });
    expect(gate.baseDelayMs("blocked")).toBe(30_000);
    await store.set("slow", rules({ blocked: { on: true, waitSec: 120 } }));
    expect(gate.baseDelayMs("blocked")).toBe(30_000);
    await store.set("quick", rules({ blocked: { on: true, waitSec: 5 } }));
    expect(gate.baseDelayMs("blocked")).toBe(5_000);
    // A phone that switched the event off does not shorten anybody's wait.
    await store.set("quick", rules({ blocked: { on: false, waitSec: 1 } }));
    expect(gate.baseDelayMs("blocked")).toBe(30_000);
    await store.set("instant", rules({ done: { on: true, waitSec: 0 } }));
    expect(gate.baseDelayMs("done")).toBe(0);
    expect(gate.baseDelayMs("blocked")).toBe(30_000);
  });

  test("a message that is not an agent alert is never judged", async () => {
    const { store, gate, now } = await rig();
    await store.set("pixel", rules({ blocked: { on: false, waitSec: 30 }, done: { on: false, waitSec: 30 } }));
    expect(gate.judge("pixel", { kind: "other" }, now())).toEqual({ act: "send" });
    expect(await gate.settle("pixel", { kind: "other" })).toBe("send");
    expect(gate.reminder("pixel", { kind: "other" })).toBeNull();
  });

  test("a phone with no upload is judged by the machine's prefs and its own wait", async () => {
    const { store, gate, now } = await rig({ prefs: { blocked: true, done: false }, bridgeDelayMs: 30_000 });
    expect(gate.judge("plain", blocked("w1:p1"), now())).toEqual({ act: "send" });
    expect(gate.judge("plain", done("w1:p1"), now())).toMatchObject({ act: "drop" });
    expect(gate.judge(undefined, blocked("w1:p1"), now())).toEqual({ act: "send" });
    // Another phone asks for 5 s, so the coordinator fires early and this phone waits the difference.
    await store.set("quick", rules({ blocked: { on: true, waitSec: 5 } }));
    expect(gate.judge("plain", blocked("w1:p1"), now())).toMatchObject({ act: "wait", ms: 25_000 });
  });

  test("an event switched off for the phone is dropped", async () => {
    const { store, gate, now } = await rig();
    await store.set("pixel", rules({ blocked: { on: false, waitSec: 30 } }));
    expect(gate.judge("pixel", blocked("w1:p1"), now())).toMatchObject({ act: "drop" });
    expect(gate.judge("pixel", done("w1:p1"), now())).not.toMatchObject({ act: "drop" });
  });

  test("a pane switched off is dropped, and a session's panes are keyed with the session", async () => {
    const { store, gate, now } = await rig();
    await store.set("pixel", rules({ steadySec: 0, panes: { "w1:p1": "off", "work:w1:p2": "off", "w1:p3": "on" } }));
    expect(gate.judge("pixel", blocked("w1:p1"), now())).toMatchObject({ act: "drop" });
    expect(gate.judge("pixel", blocked("w1:p2", "work"), now())).toMatchObject({ act: "drop" });
    // The same pane id in the primary session is another pane.
    expect(gate.judge("pixel", blocked("w1:p2"), now())).toEqual({ act: "send" });
    expect(gate.judge("pixel", blocked("w1:p3"), now())).toEqual({ act: "send" });
    // A summary of several panes names none, so a pane switch cannot silence it.
    expect(gate.judge("pixel", blocked(), now())).toEqual({ act: "send" });
  });

  test("quiet hours drop the alert", async () => {
    const { store, gate, setNow } = await rig();
    await store.set("pixel", rules({ steadySec: 0, quiet: { on: true, fromMin: 23 * 60, toMin: 7 * 60, utcOffsetMin: 0 } }));
    setNow(Date.UTC(2026, 10, 14, 2));
    expect(gate.judge("pixel", blocked("w1:p1"), Date.UTC(2026, 10, 14, 2))).toMatchObject({ act: "drop", why: "quiet hours" });
    expect(gate.judge("pixel", blocked("w1:p1"), Date.UTC(2026, 10, 14, 12))).toEqual({ act: "send" });
  });

  test("the phone's wait is what is left after the machine's, and the still-screen check comes out of it", async () => {
    const { store, gate, now } = await rig({ bridgeDelayMs: 30_000 });
    await store.set("pixel", rules({ blocked: { on: true, waitSec: 60 }, steadySec: 0 }));
    expect(gate.judge("pixel", blocked("w1:p1"), now())).toMatchObject({ act: "wait", ms: 30_000 });
    await store.set("pixel", rules({ blocked: { on: true, waitSec: 60 }, steadySec: 10 }));
    expect(gate.judge("pixel", blocked("w1:p1"), now())).toMatchObject({ act: "wait", ms: 20_000 });
    // The watch alone still asks for a (zero-length) wait so that the screen is read once.
    await store.set("pixel", rules({ blocked: { on: true, waitSec: 30 }, steadySec: 10 }));
    expect(gate.judge("pixel", blocked("w1:p1"), now())).toMatchObject({ act: "wait", ms: 0 });
    // No pane, no screen to watch: a summary is sent when its wait is over.
    expect(gate.judge("pixel", blocked(), now())).toEqual({ act: "send" });
  });

  test("a phone that asks for a shorter wait than the others sends at once", async () => {
    const { store, gate, now } = await rig({ bridgeDelayMs: 30_000 });
    await store.set("quick", rules({ blocked: { on: true, waitSec: 5 }, steadySec: 0 }));
    await store.set("slow", rules({ blocked: { on: true, waitSec: 60 }, steadySec: 0 }));
    expect(gate.judge("quick", blocked("w1:p1"), now())).toEqual({ act: "send" });
    expect(gate.judge("slow", blocked("w1:p1"), now())).toMatchObject({ act: "wait", ms: 55_000 });
  });

  test("a mixed summary is judged as needing you", async () => {
    const { store, gate, now } = await rig();
    await store.set("pixel", rules({ blocked: { on: false, waitSec: 30 } }));
    expect(gate.judge("pixel", { kind: "mixed" }, now())).toMatchObject({ act: "drop" });
  });

  test("settle: waits for the screen to stop changing, then sends", async () => {
    const { store, gate, reads, sleeps } = await rig({ revisions: [1, 2, 3, 3] });
    await store.set("pixel", rules({ steadySec: 4 }));
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("send");
    // One read to start, then a sleep and a read per round until two reads agree.
    expect(reads).toHaveLength(4);
    expect(sleeps).toEqual([4_000, 4_000, 4_000]);
  });

  test("settle: a screen that cannot be read does not hold the alert back", async () => {
    const { store, gate, reads } = await rig({ revisions: [undefined] });
    await store.set("pixel", rules({ steadySec: 4 }));
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("send");
    expect(reads).toHaveLength(1);
  });

  test("settle: a screen that never settles gets its alert after a bounded number of looks", async () => {
    let n = 0;
    const store = new RulesStore({ stateDir: await tempDir() });
    await store.set("pixel", rules({ steadySec: 1 }));
    let slept = 0;
    const gate = new RulesGate({
      store,
      prefs: () => ({ blocked: true, done: true }),
      bridgeDelayMs: 0,
      revision: () => Promise.resolve(n++),
      sleep: () => {
        slept++;
        return Promise.resolve();
      },
      now: () => 0,
    });
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("send");
    expect(slept).toBe(20);
  });

  test("settle: a check of zero seconds, or a summary, reads no screen", async () => {
    const { store, gate, reads } = await rig();
    await store.set("pixel", rules({ steadySec: 0 }));
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("send");
    await store.set("pixel", rules({ steadySec: 10 }));
    expect(await gate.settle("pixel", blocked())).toBe("send");
    expect(reads).toHaveLength(0);
  });

  test("settle: rules changed during the wait are applied before anything goes out", async () => {
    const { store, gate } = await rig({ revisions: [1] });
    await store.set("pixel", rules({ steadySec: 0 }));
    await store.set("pixel", rules({ steadySec: 0, blocked: { on: false, waitSec: 30 } }));
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("drop");
    await store.set("pixel", rules({ steadySec: 0, panes: { "w1:p1": "off" } }));
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("drop");
    await store.forget("pixel");
    // No rules any more: back to the machine's prefs, which want "blocked".
    expect(await gate.settle("pixel", blocked("w1:p1"))).toBe("send");
    expect(await gate.settle("pixel", done("w1:p1"))).toBe("drop");
  });

  test("reminder: only for needs-you alerts, only when the phone asked", async () => {
    const { store, gate } = await rig();
    expect(gate.reminder("pixel", blocked("w1:p1"))).toBeNull();
    await store.set("pixel", rules({ repeat: { on: false, everyMin: 10, count: 3 } }));
    expect(gate.reminder("pixel", blocked("w1:p1"))).toBeNull();
    await store.set("pixel", rules({ repeat: { on: true, everyMin: 10, count: 3 } }));
    expect(gate.reminder("pixel", blocked("w1:p1"))).toEqual({ everyMs: 600_000, count: 3 });
    expect(gate.reminder("pixel", { kind: "mixed" })).toEqual({ everyMs: 600_000, count: 3 });
    expect(gate.reminder("pixel", done("w1:p1"))).toBeNull();
    expect(gate.reminder(undefined, blocked("w1:p1"))).toBeNull();
  });

  test("again: a reminder goes out only while the rules still allow it", async () => {
    const { store, gate } = await rig();
    const day = (h: number) => Date.UTC(2026, 10, 14, h);
    expect(gate.again("pixel", blocked("w1:p1"), day(12))).toBe(false);
    expect(gate.again(undefined, blocked("w1:p1"), day(12))).toBe(false);
    await store.set("pixel", rules({ repeat: { on: true, everyMin: 10, count: 3 }, quiet: { on: true, fromMin: 23 * 60, toMin: 7 * 60, utcOffsetMin: 0 } }));
    expect(gate.again("pixel", blocked("w1:p1"), day(12))).toBe(true);
    expect(gate.again("pixel", blocked("w1:p1"), day(2))).toBe(false);
    await store.set("pixel", rules({ repeat: { on: true, everyMin: 10, count: 3 }, panes: { "w1:p1": "off" } }));
    expect(gate.again("pixel", blocked("w1:p1"), day(12))).toBe(false);
    await store.set("pixel", rules({ repeat: { on: false, everyMin: 10, count: 3 } }));
    expect(gate.again("pixel", blocked("w1:p1"), day(12))).toBe(false);
  });
});
