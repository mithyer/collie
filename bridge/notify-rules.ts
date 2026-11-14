import type { JsonObject, JsonValue } from "./json.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { NotifyPrefs } from "./notify-prefs.ts";
import type { PushTitleCode } from "./push-titles.ts";

// Per-phone notification rules (the Dogr build, scripts/dogr-stamp.ts).
//
// Collie's notify prefs are bridge-wide: one switch per kind, one debounce, and a push fans out to
// every subscribed device. A person with two phones wants different things from each (quiet hours on
// one, not on the other). The rules here belong to ONE paired device, named by the pairing label of
// its bearer token, the same label that already joins a push subscription to its device
// (`StoredSubscription.device`). The phone is the master copy and uploads its rules whenever it
// connects, so a reinstall or a new pairing only means one more upload.
//
// This file is new and self-contained. It decides; it never sends. `Push.sendRender` asks the gate
// what to do with each render for each subscription (see `RenderGate`), and `index.ts` builds the
// gate. A subscription whose device has uploaded no rules is judged by the bridge-wide prefs and
// debounce, so every other client behaves exactly as before.
//
// TEST: notify-rules.test.ts, push-rules.test.ts

/** The two agent states Collie raises an alert for. */
export type RuleKind = "blocked" | "done";

/** One event kind: whether it pushes at all, and how long the state must hold before it does. */
export interface EventRule {
  on: boolean;
  /** Seconds the state must hold, counted from the moment the agent entered it. */
  waitSec: number;
}

/** A reminder for a "needs you" alert nobody has answered yet. */
export interface RepeatRule {
  on: boolean;
  /** Minutes between two reminders. */
  everyMin: number;
  /** How many reminders at most, after the first alert. */
  count: number;
}

/** A daily window, in the phone's own clock, during which nothing is sent (the alert is dropped). */
export interface QuietRule {
  on: boolean;
  /** Window start, minutes after local midnight. */
  fromMin: number;
  /** Window end, minutes after local midnight; a window may wrap past midnight. */
  toMin: number;
  /** The phone's offset from UTC in minutes, so the window means the same wall clock everywhere. */
  utcOffsetMin: number;
}

/** A pane's own choice. A pane with no entry inherits (alerts on). */
export type PaneChoice = "on" | "off";

/** Everything one phone decides about its pushes. */
export interface PhoneRules {
  blocked: EventRule;
  done: EventRule;
  /** Seconds the pane's screen must stay unchanged before an alert goes out; 0 turns the check off. */
  steadySec: number;
  repeat: RepeatRule;
  quiet: QuietRule;
  /** Per-pane choices, keyed by {@link paneKey}. */
  panes: Record<string, PaneChoice>;
}

/** The ranges every number is clamped into, on the way in and on the way off disk. */
export const RULE_LIMITS = {
  waitSec: { min: 0, max: 600 },
  steadySec: { min: 0, max: 60 },
  everyMin: { min: 1, max: 120 },
  count: { min: 1, max: 5 },
  minuteOfDay: { min: 0, max: 1439 },
  utcOffsetMin: { min: -720, max: 840 },
  /** Pane choices kept per phone. More are cut off: a profile is a few switches, not a log. */
  panes: 200,
  /** Longest pane key accepted. */
  paneKey: 120,
  /** Phones kept; the oldest upload is forgotten first. */
  devices: 50,
} as const;

/** How many times the steadiness check looks again before a screen that never settles gets its push. */
const STEADY_ROUNDS = 20;

/** The rules a phone starts from, and what a missing key in an upload falls back to. */
export function defaultPhoneRules(): PhoneRules {
  return {
    blocked: { on: true, waitSec: 30 },
    done: { on: true, waitSec: 30 },
    steadySec: 10,
    repeat: { on: false, everyMin: 10, count: 3 },
    quiet: { on: false, fromMin: 23 * 60, toMin: 7 * 60, utcOffsetMin: 0 },
    panes: {},
  };
}

function record(raw: JsonValue | undefined): JsonObject {
  return typeof raw === "object" && raw !== null && raw !== undefined && !Array.isArray(raw) ? raw : {};
}

function flag(raw: JsonValue | undefined, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** A whole number inside `[min, max]`; anything that is not a finite number becomes the fallback. */
function whole(raw: JsonValue | undefined, range: { min: number; max: number }, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(raw)));
}

function eventRule(raw: JsonValue | undefined, fallback: EventRule): EventRule {
  const o = record(raw);
  return { on: flag(o.on, fallback.on), waitSec: whole(o.waitSec, RULE_LIMITS.waitSec, fallback.waitSec) };
}

/** A pane key that cannot hide control characters or run away in length. */
function usableKey(key: string): boolean {
  if (key === "" || key.length > RULE_LIMITS.paneKey) return false;
  for (const ch of key) if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return false;
  return true;
}

/**
 * Coerce an untrusted parsed value into {@link PhoneRules}: every missing, mistyped or out-of-range
 * field takes its default or the nearest allowed value. Pure and exported for the test.
 */
export function coercePhoneRules(raw: JsonValue | undefined): PhoneRules {
  const base = defaultPhoneRules();
  const o = record(raw);
  const repeat = record(o.repeat);
  const quiet = record(o.quiet);
  const panes: Record<string, PaneChoice> = {};
  for (const [key, choice] of Object.entries(record(o.panes))) {
    if (Object.keys(panes).length >= RULE_LIMITS.panes) break;
    if (usableKey(key) && (choice === "on" || choice === "off")) panes[key] = choice;
  }
  return {
    blocked: eventRule(o.blocked, base.blocked),
    done: eventRule(o.done, base.done),
    steadySec: whole(o.steadySec, RULE_LIMITS.steadySec, base.steadySec),
    repeat: {
      on: flag(repeat.on, base.repeat.on),
      everyMin: whole(repeat.everyMin, RULE_LIMITS.everyMin, base.repeat.everyMin),
      count: whole(repeat.count, RULE_LIMITS.count, base.repeat.count),
    },
    quiet: {
      on: flag(quiet.on, base.quiet.on),
      fromMin: whole(quiet.fromMin, RULE_LIMITS.minuteOfDay, base.quiet.fromMin),
      toMin: whole(quiet.toMin, RULE_LIMITS.minuteOfDay, base.quiet.toMin),
      utcOffsetMin: whole(quiet.utcOffsetMin, RULE_LIMITS.utcOffsetMin, base.quiet.utcOffsetMin),
    },
    panes,
  };
}

/** The body of an upload: a JSON object, anything else is refused. Fields inside are coerced. */
export function parseRulesRequest(raw: JsonValue): PhoneRules | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return coercePhoneRules(raw);
}

/**
 * The key a pane goes by in {@link PhoneRules.panes}: the pane id, prefixed with the session name for
 * every session but the primary (whose alerts carry no session). The phone builds the same string
 * from what it reads in the snapshot.
 */
export function paneKey(paneId: string, session?: string): string {
  return session === undefined || session === "" ? paneId : `${session}:${paneId}`;
}

/** Whether `at` (epoch ms) falls inside the quiet window, on the phone's own clock. */
export function inQuietHours(quiet: QuietRule, at: number): boolean {
  if (!quiet.on || quiet.fromMin === quiet.toMin) return false;
  const minutes = Math.floor(at / 60_000) + quiet.utcOffsetMin;
  const local = ((minutes % 1440) + 1440) % 1440;
  if (quiet.fromMin < quiet.toMin) return local >= quiet.fromMin && local < quiet.toMin;
  // The window wraps past midnight (23:00 to 07:00).
  return local >= quiet.fromMin || local < quiet.toMin;
}

/** What an alert is about, read off the title code the coordinator already put on it. */
export type RenderKind = RuleKind | "mixed" | "other";

/**
 * Which rules apply to a render. Only the agent alerts do; a title the operator typed
 * (`collie push-test`), an update alert and a machine alert carry no code of this family and pass.
 * A summary of both kinds is judged as "blocked", the more urgent of the two.
 */
export function renderKind(code: PushTitleCode | undefined): RenderKind {
  switch (code) {
    case "agent.blocked":
    case "herd.blocked":
    case "ask.permission":
      return "blocked";
    case "agent.done":
    case "herd.done":
      return "done";
    case "herd.mixed":
      return "mixed";
    default:
      return "other";
  }
}

/** One render, as the gate sees it. */
export interface GateRender {
  kind: RenderKind;
  /** The pane an individual alert is about; absent on a summary of several. */
  paneId?: string;
  /** The session the pane lives in; absent for the primary. */
  session?: string;
}

/** What the gate says about one render for one subscription. */
export type GateVerdict =
  | { act: "send" }
  | { act: "drop"; why: string }
  | { act: "wait"; ms: number; why: string };

/** The seam {@link Push} calls. The class below is the real one; a test may pass a smaller one. */
export interface RenderGate {
  /** First look, when the render reaches the push layer. */
  judge(device: string | undefined, render: GateRender, at: number): GateVerdict;
  /** After a wait: the screen has to hold still, and the quiet window is checked again. */
  settle(device: string | undefined, render: GateRender): Promise<"send" | "drop">;
  /** The reminders to schedule after an alert went out, or null for none. */
  reminder(device: string | undefined, render: GateRender): { everyMs: number; count: number } | null;
  /** Whether a reminder due `at` may still go out. */
  again(device: string | undefined, render: GateRender, at: number): boolean;
}

/** The phones' rules on disk: `notify-rules.json` in the state dir, owner-only, written atomically. */
export class RulesStore {
  private rows = new Map<string, PhoneRules>();
  private readonly file: string;

  constructor(cfg: Pick<Config, "stateDir">) {
    this.file = join(cfg.stateDir, "notify-rules.json");
  }

  /** Read the file; a missing or unreadable file means no phone has uploaded rules. */
  async load(): Promise<void> {
    try {
      const raw = record(await Bun.file(this.file).json());
      const next = new Map<string, PhoneRules>();
      for (const [device, rules] of Object.entries(record(raw.devices))) {
        if (usableKey(device)) next.set(device, coercePhoneRules(rules));
      }
      this.rows = next;
    } catch {
      /* none saved yet */
    }
  }

  /** A copy of one phone's rules, or undefined when it never uploaded any. */
  get(device: string): PhoneRules | undefined {
    const rules = this.rows.get(device);
    return rules === undefined ? undefined : structuredClone(rules);
  }

  /** Every stored profile (copies), for the base delay and the "does anybody want this" question. */
  all(): PhoneRules[] {
    return [...this.rows.values()].map((rules) => structuredClone(rules));
  }

  /** Store a phone's rules (replacing any earlier upload) and persist. */
  async set(device: string, rules: PhoneRules): Promise<void> {
    this.rows.delete(device);
    this.rows.set(device, structuredClone(rules));
    while (this.rows.size > RULE_LIMITS.devices) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
    await this.save();
  }

  /** Forget a phone's rules (it revoked its pairing, or switched notifications off). */
  async forget(device: string): Promise<boolean> {
    const had = this.rows.delete(device);
    if (had) await this.save();
    return had;
  }

  /** Atomic, owner-only write: a fresh temp file (mode 0600), then a rename over the target. */
  private async save(): Promise<void> {
    await mkdir(this.file.slice(0, this.file.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const devices = Object.fromEntries(this.rows);
    await writeFile(tmp, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/** What the gate needs from the bridge. Every effect comes through here, so a test needs no clock. */
export interface GateDeps {
  store: RulesStore;
  /** The bridge-wide prefs, read live: they judge a subscription whose phone uploaded no rules. */
  prefs: () => Pick<NotifyPrefs, "blocked" | "done">;
  /** The bridge's own debounce ({@link NotificationCoordinator}'s delay), which such a phone keeps. */
  bridgeDelayMs: number;
  /** A number that changes whenever the pane's screen changes, or undefined when it cannot be read. */
  revision: (session: string | undefined, paneId: string) => Promise<number | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * The real {@link RenderGate}: applies the per-phone rules, or the bridge-wide prefs for a phone that
 * has none.
 *
 * The coordinator's debounce is shared by all phones, so it is lowered to the shortest wait any phone
 * asks for ({@link baseDelayMs}); every other subscription then waits out the difference here. That
 * is what lets one phone ask for 10 seconds and another for 60 without either being a lie.
 */
export class RulesGate implements RenderGate {
  constructor(private readonly deps: GateDeps) {}

  /** The kind a render is judged as; "other" never reaches the rules. */
  private ruleKind(kind: RenderKind): RuleKind | null {
    if (kind === "other") return null;
    return kind === "mixed" ? "blocked" : kind;
  }

  /**
   * Whether any phone, or the bridge-wide prefs, wants alerts of this kind. The coordinator arms its
   * debounce only for a kind somebody wants, so this is OR-ed into its `isNotifiable`.
   */
  wants(kind: RuleKind): boolean {
    if (this.deps.prefs()[kind]) return true;
    return this.deps.store.all().some((rules) => rules[kind].on);
  }

  /**
   * The delay the coordinator should use for this kind: the shortest wait any interested subscription
   * asks for, never longer than the bridge's own. Read when an alert is armed.
   */
  baseDelayMs(kind: RuleKind): number {
    let base = this.deps.bridgeDelayMs;
    for (const rules of this.deps.store.all()) {
      if (rules[kind].on) base = Math.min(base, rules[kind].waitSec * 1000);
    }
    return base;
  }

  judge(device: string | undefined, render: GateRender, at: number): GateVerdict {
    const kind = this.ruleKind(render.kind);
    if (kind === null) return { act: "send" };
    const base = this.baseDelayMs(kind);
    const rules = device === undefined ? undefined : this.deps.store.get(device);
    if (rules === undefined) {
      // No upload from this device: the bridge-wide switches and the bridge's own debounce.
      if (!this.deps.prefs()[kind]) return { act: "drop", why: `${kind} alerts are off on this machine` };
      const extra = this.deps.bridgeDelayMs - base;
      return extra > 0 ? { act: "wait", ms: extra, why: "the machine's own wait" } : { act: "send" };
    }
    if (!rules[kind].on) return { act: "drop", why: `${kind} alerts are off for this phone` };
    if (render.paneId !== undefined && rules.panes[paneKey(render.paneId, render.session)] === "off") {
      return { act: "drop", why: "this pane is switched off" };
    }
    if (inQuietHours(rules.quiet, at)) return { act: "drop", why: "quiet hours" };
    // The steadiness check spends its own seconds after the wait, so they come off the wait.
    const steady = render.paneId !== undefined && rules.steadySec > 0;
    const wait = Math.max(0, rules[kind].waitSec * 1000 - base - (steady ? rules.steadySec * 1000 : 0));
    if (wait > 0 || steady) return { act: "wait", ms: wait, why: steady ? "waiting for a still screen" : "the phone's wait" };
    return { act: "send" };
  }

  async settle(device: string | undefined, render: GateRender): Promise<"send" | "drop"> {
    const rules = device === undefined ? undefined : this.deps.store.get(device);
    const kind = this.ruleKind(render.kind);
    if (rules !== undefined && kind !== null && render.paneId !== undefined && rules.steadySec > 0) {
      let last = await this.deps.revision(render.session, render.paneId);
      // A screen that cannot be read is no reason to hold an alert back.
      if (last !== undefined) {
        for (let round = 0; round < STEADY_ROUNDS; round++) {
          await this.deps.sleep(rules.steadySec * 1000);
          const next = await this.deps.revision(render.session, render.paneId);
          if (next === undefined || next === last) break;
          last = next;
        }
      }
    }
    // The wait took time, and the phone may have changed its rules meanwhile: look again.
    return this.judgeAgain(device, render, this.deps.now()) ? "send" : "drop";
  }

  /** Whether the render may still go out at `at`, ignoring any wait (rules read fresh). */
  private judgeAgain(device: string | undefined, render: GateRender, at: number): boolean {
    const kind = this.ruleKind(render.kind);
    if (kind === null) return true;
    const rules = device === undefined ? undefined : this.deps.store.get(device);
    if (rules === undefined) return this.deps.prefs()[kind];
    if (!rules[kind].on) return false;
    if (render.paneId !== undefined && rules.panes[paneKey(render.paneId, render.session)] === "off") return false;
    return !inQuietHours(rules.quiet, at);
  }

  reminder(device: string | undefined, render: GateRender): { everyMs: number; count: number } | null {
    if (device === undefined || this.ruleKind(render.kind) !== "blocked") return null;
    const rules = this.deps.store.get(device);
    if (rules === undefined || !rules.repeat.on) return null;
    return { everyMs: rules.repeat.everyMin * 60_000, count: rules.repeat.count };
  }

  again(device: string | undefined, render: GateRender, at: number): boolean {
    if (device === undefined) return false;
    const rules = this.deps.store.get(device);
    if (rules === undefined || !rules.repeat.on) return false;
    return this.judgeAgain(device, render, at);
  }
}
