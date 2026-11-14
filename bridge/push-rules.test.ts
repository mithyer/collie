import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import type { JsonObject } from "./json.ts";
import { defaultPhoneRules, type PhoneRules, RulesGate, RulesStore } from "./notify-rules.ts";
import { CLEAR_BURST_MS, Push } from "./push.ts";
import type { PushMessage, PushSender, SendOptions } from "./push.ts";

// The seam between push.ts and the per-phone rules: what each subscription is sent, when, and what a
// clear or a newer render cancels. The gate is the real one over a real store; only the clock, the
// sender and the screen are the test's own. The rules themselves are in notify-rules.test.ts.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-push-rules-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A clock the test moves by hand, with the timers due at each step fired in order. */
class ManualClock {
  t = Date.UTC(2026, 10, 14, 12);
  private timers: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  schedule = (fn: () => void, delayMs: number): number => {
    this.timers.push({ at: this.t + delayMs, fn });
    return this.timers.length;
  };
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    // Step timer by timer, so a timer that sets another one is honoured inside the same advance.
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await Bun.sleep(0);
    }
    this.t = target;
    await Bun.sleep(0);
  }
}

type Sent = { endpoint: string; body: JsonObject; options: SendOptions };

/** A Push with the real gate, phones named by endpoint and pairing label, and a recording sender. */
async function rig(
  phones: { endpoint: string; device?: string; rules?: PhoneRules }[],
  options: { bridgeDelayMs?: number; withGate?: boolean; revisions?: number[] } = {},
) {
  const cfg = { ...loadConfig(), stateDir: await tempDir() };
  const store = new RulesStore(cfg);
  const clock = new ManualClock();
  const sent: Sent[] = [];
  const sender: PushSender = (s, payload, sendOptions) => {
    sent.push({ endpoint: s.endpoint, body: JSON.parse(payload), options: sendOptions });
    return Promise.resolve();
  };
  const reads: number[] = [];
  const script = options.revisions ?? [1];
  const gate = new RulesGate({
    store,
    prefs: () => ({ blocked: true, done: true }),
    bridgeDelayMs: options.bridgeDelayMs ?? 30_000,
    revision: () => {
      const next = script[Math.min(reads.length, script.length - 1)];
      reads.push(reads.length);
      return Promise.resolve(next);
    },
    sleep: () => Promise.resolve(),
    now: clock.now,
  });
  const push = new Push(cfg, sender, { clock, gate: options.withGate === false ? undefined : gate });
  // Bracket access reaches Push's private state without an assertion, so the compiler still checks
  // both fields against their real declarations.
  push["_enabled"] = true;
  for (const p of phones) {
    push["subs"].set(p.endpoint, { endpoint: p.endpoint, keys: { p256dh: "p", auth: "a" }, device: p.device });
    if (p.device !== undefined && p.rules !== undefined) await store.set(p.device, p.rules);
  }
  /** What reached one phone as a notification (a clear is silent and not counted). */
  const shown = (endpoint: string) => sent.filter((x) => x.endpoint === endpoint && x.body.title !== undefined);
  return { push, clock, sent, shown, store, reads };
}

/** The defaults with some fields replaced, as a phone's upload would. */
function rules(change: Partial<PhoneRules> = {}): PhoneRules {
  return { ...defaultPhoneRules(), steadySec: 0, ...change };
}

const alert = (tag: string, paneId = "w1:p1", titleCode: PushMessage["titleCode"] = "agent.blocked"): PushMessage => ({
  title: "claude needs you",
  titleCode,
  body: "demo",
  tag,
  paneId,
  badge: 1,
  renotify: true,
});

describe("Push with the phones' rules", () => {
  test("without a gate nothing changes: every phone gets the alert at once", async () => {
    const { push, shown } = await rig(
      [
        { endpoint: "a", device: "pixel", rules: rules({ blocked: { on: false, waitSec: 90 } }) },
        { endpoint: "b", device: "mac" },
      ],
      { withGate: false },
    );
    await push.send(alert("collie:herd:p1"));
    expect(shown("a")).toHaveLength(1);
    expect(shown("b")).toHaveLength(1);
  });

  test("a phone with no upload gets the alert at once when nobody asked for less", async () => {
    const { push, shown } = await rig([{ endpoint: "a", device: "pixel" }]);
    await push.send(alert("collie:herd:p1"));
    expect(shown("a")).toHaveLength(1);
  });

  test("each phone waits what it asked for beyond the machine's own wait", async () => {
    const { push, clock, shown } = await rig(
      [
        { endpoint: "quick", device: "pixel", rules: rules({ blocked: { on: true, waitSec: 5 } }) },
        { endpoint: "slow", device: "mac", rules: rules({ blocked: { on: true, waitSec: 60 } }) },
      ],
      { bridgeDelayMs: 30_000 },
    );
    // The coordinator would fire after the shortest wait (5 s); this is the moment it does.
    await push.send(alert("collie:herd:p1"));
    expect(shown("quick")).toHaveLength(1);
    expect(shown("slow")).toHaveLength(0);
    await clock.advance(54_000);
    expect(shown("slow")).toHaveLength(0);
    await clock.advance(1_000);
    expect(shown("slow")).toHaveLength(1);
    expect(shown("slow")[0]!.body.tag).toBe("collie:herd:p1");
  });

  test("an event, a pane or the quiet hours can keep an alert from one phone and not another", async () => {
    const { push, shown } = await rig([
      { endpoint: "eventOff", device: "a", rules: rules({ blocked: { on: false, waitSec: 30 } }) },
      { endpoint: "paneOff", device: "b", rules: rules({ panes: { "w1:p1": "off" } }) },
      // 12:00 UTC is inside a window that runs 11:00 to 13:00 on a UTC clock.
      { endpoint: "quiet", device: "c", rules: rules({ quiet: { on: true, fromMin: 11 * 60, toMin: 13 * 60, utcOffsetMin: 0 } }) },
      { endpoint: "open", device: "d", rules: rules() },
    ]);
    await push.send(alert("collie:herd:p1"));
    expect(shown("eventOff")).toHaveLength(0);
    expect(shown("paneOff")).toHaveLength(0);
    expect(shown("quiet")).toHaveLength(0);
    expect(shown("open")).toHaveLength(1);
  });

  test("a message that is not an agent alert is not held back by the rules", async () => {
    const { push, shown } = await rig([
      { endpoint: "a", device: "pixel", rules: rules({ blocked: { on: false, waitSec: 30 }, done: { on: false, waitSec: 30 } }) },
    ]);
    await push.send({ type: "update", title: "Update available", body: "1.29.0", tag: "collie:update" });
    // A title the operator typed carries no code and passes as well.
    await push.send({ title: "hello", body: "from push-test", tag: "collie:test" });
    expect(shown("a")).toHaveLength(2);
  });

  test("the screen is watched before a waiting alert goes out", async () => {
    const { push, clock, shown, reads } = await rig(
      [{ endpoint: "a", device: "pixel", rules: rules({ steadySec: 5, blocked: { on: true, waitSec: 30 } }) }],
      { revisions: [1, 2, 2] },
    );
    await push.send(alert("collie:herd:p1"));
    expect(shown("a")).toHaveLength(0);
    await clock.advance(0);
    expect(shown("a")).toHaveLength(1);
    // One read to start and two more before two of them agreed.
    expect(reads).toHaveLength(3);
  });

  test("a clear takes back an alert that is still waiting", async () => {
    const { push, clock, shown } = await rig([{ endpoint: "a", device: "pixel", rules: rules({ blocked: { on: true, waitSec: 60 } }) }]);
    await push.send(alert("collie:herd:p1"));
    await clock.advance(10_000);
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    await clock.advance(120_000 + CLEAR_BURST_MS);
    expect(shown("a")).toHaveLength(0);
  });

  test("a newer alert for the slot replaces the one that is waiting", async () => {
    const { push, clock, shown } = await rig([{ endpoint: "a", device: "pixel", rules: rules({ blocked: { on: true, waitSec: 60 } }) }]);
    await push.send({ ...alert("collie:herd:p1"), body: "first" });
    await clock.advance(20_000);
    await push.send({ ...alert("collie:herd:p1"), body: "second" });
    await clock.advance(120_000);
    expect(shown("a").map((x) => x.body.body)).toEqual(["second"]);
  });

  test("rules changed while an alert waits are applied when it is due", async () => {
    const { push, clock, shown, store } = await rig([{ endpoint: "a", device: "pixel", rules: rules({ blocked: { on: true, waitSec: 60 } }) }]);
    await push.send(alert("collie:herd:p1"));
    await clock.advance(10_000);
    await store.set("pixel", rules({ blocked: { on: false, waitSec: 60 } }));
    await clock.advance(60_000);
    expect(shown("a")).toHaveLength(0);
  });

  test("a phone taken off the list while its alert waits is not sent to", async () => {
    const { push, clock, shown } = await rig([{ endpoint: "a", device: "pixel", rules: rules({ blocked: { on: true, waitSec: 60 } }) }]);
    await push.send(alert("collie:herd:p1"));
    push["subs"].delete("a");
    await clock.advance(120_000);
    expect(shown("a")).toHaveLength(0);
  });

  test("reminders go out at the chosen interval, as many times as chosen, and then stop", async () => {
    const { push, clock, shown } = await rig([
      { endpoint: "a", device: "pixel", rules: rules({ repeat: { on: true, everyMin: 10, count: 2 } }) },
      { endpoint: "b", device: "mac", rules: rules() },
    ]);
    await push.send(alert("collie:herd:p1"));
    expect(shown("a")).toHaveLength(1);
    await clock.advance(9 * 60_000);
    expect(shown("a")).toHaveLength(1);
    await clock.advance(60_000);
    expect(shown("a")).toHaveLength(2);
    expect(shown("a")[1]!.body.renotify).toBe(true);
    await clock.advance(10 * 60_000);
    expect(shown("a")).toHaveLength(3);
    await clock.advance(60 * 60_000);
    expect(shown("a")).toHaveLength(3);
    // A phone that did not ask for reminders gets the one alert only.
    expect(shown("b")).toHaveLength(1);
  });

  test("a clear ends the reminders", async () => {
    const { push, clock, shown } = await rig([{ endpoint: "a", device: "pixel", rules: rules({ repeat: { on: true, everyMin: 10, count: 3 } }) }]);
    await push.send(alert("collie:herd:p1"));
    await clock.advance(10 * 60_000);
    expect(shown("a")).toHaveLength(2);
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    await clock.advance(60 * 60_000);
    expect(shown("a")).toHaveLength(2);
  });

  test("a reminder due inside the quiet hours is skipped, and the next one still goes out", async () => {
    // 12:00 UTC now; a window from 12:05 to 12:15 swallows the first reminder (12:10) only.
    const { push, clock, shown } = await rig([
      {
        endpoint: "a",
        device: "pixel",
        rules: rules({
          repeat: { on: true, everyMin: 10, count: 2 },
          quiet: { on: true, fromMin: 12 * 60 + 5, toMin: 12 * 60 + 15, utcOffsetMin: 0 },
        }),
      },
    ]);
    await push.send(alert("collie:herd:p1"));
    expect(shown("a")).toHaveLength(1);
    await clock.advance(10 * 60_000);
    expect(shown("a")).toHaveLength(1);
    await clock.advance(10 * 60_000);
    expect(shown("a")).toHaveLength(2);
  });

  test("a done alert is never repeated", async () => {
    const { push, clock, shown } = await rig([{ endpoint: "a", device: "pixel", rules: rules({ repeat: { on: true, everyMin: 10, count: 3 } }) }]);
    await push.send(alert("collie:herd:p1", "w1:p1", "agent.done"));
    await clock.advance(60 * 60_000);
    expect(shown("a")).toHaveLength(1);
  });
});
