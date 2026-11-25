// A phone that keeps its own copy of a pane's scrollback (Dogr build).
//
// WHY. "Load older" used to read the screen together with the rows above it, a bigger window each time, and the phone drew the
// whole answer again: every tap re-read rows it already held and the page jumped when the new text replaced the old. Here the
// phone keeps the rows in a file of its own and asks only for what it lacks; this side stays STATELESS (no file, no counter, nothing
// to expire): every answer is worked out from one read of the multiplexer's history.
//
// ONE QUESTION, `GET /api/pane/:id?scrollback=<mode>` (the pane read with one more word, so the access check, the crew link and
// the "seen" stamp are the pane read's own):
//   - `newest`            the newest `limit` settled rows.
//   - `after` + `anchor`  the rows after the place the anchor names (a phone that holds the older ones); the newest `limit`, with
//                         the number of rows between that were left out (`skipped`), or, with `until` too, the `limit` rows next
//                         to the anchor and how many remain before `until` (`remaining`).
//   - `before` + `anchor` up to `limit` rows right above the place the anchor names (a phone that scrolls up).
// The anchor is a run of row KEYS, newest last. A key is a short hash of what the row says (escapes and trailing blanks left out),
// made HERE and only here, so the phone never hashes and the two can never disagree. Each row also says whether it is
// INFORMATIVE (enough words to tell it from its neighbours): an anchor is the last rows up to four informative ones, which found
// one place in 99.8 % of 3600 cuts of nine real panes, and the answer says `found: false` when a run matches no place or two,
// so a wrong join is never made, only a gap.
//
// THE EDGE OF THE SCREEN. A settled row is a row that has left the screen. The multiplexer answers one list, history and screen
// together, with the blank tail cut; the screen read beside it gives the screen's rows, which are the end of that list. The two
// reads are two moments, so the end of the list must equal the screen, else the answer says `moving: true` and the phone asks again.
//
// TEST:bridge/scrollback.test.ts

import { createHash } from "node:crypto";

import type { MuxAdapter, MuxGridRequest, MuxReadHint } from "./mux/types.ts";
import type { PaneReadResponse } from "./types.ts";
import { MAX_READ_LINES } from "./read-limits.ts";
import { redactAnsi } from "./redact.ts";

/** The query word that turns a pane read into a scrollback question. */
export const SCROLLBACK_PARAM = "scrollback";

/** The rows an answer carries when the phone names no limit. */
export const SCROLLBACK_DEFAULT_LIMIT = 100;

/** The most rows one answer may carry (a Load older asks for 500). */
export const SCROLLBACK_MAX_LIMIT = 1000;

/** The longest anchor, in rows. The phone builds it from the end of its rows: four informative rows and what lies between them. */
export const ANCHOR_MAX_ROWS = 64;

/** How many rows are read first when an anchor has to be found; past this the whole history is read once. */
const FIRST_DEPTH = 1500;

/** How many times the two reads are repeated when their ends do not meet (the screen moved between them). */
const MEETING_TRIES = 3;

/** The pause between those tries, in milliseconds. */
const MEETING_PAUSE_MS = 40;

/** Rows read beside the ones asked for by `newest`: the screen is part of the list, and its height is not known before the read. */
const NEWEST_EXTRA = 300;

/** What a row's key is made of: the first eight hex digits of its SHA-256. */
const KEY_LENGTH = 8;

/** The key of a blank row. */
export const BLANK_KEY = "0".repeat(KEY_LENGTH);

/** The fewest characters, and the fewest letters or digits among them, that make a row informative. */
const INFORMATIVE_CHARS = 12;
const INFORMATIVE_WORDS = 6;

/** One row as the phone keeps it: the text with its colours, its key and whether it is informative (1) or not (0). */
export interface ScrollRow {
  /** The row's text, escapes included. */
  s: string;
  /** The row's key. */
  k: string;
  /** 1 when the row has enough words to tell it from its neighbours. */
  i: 0 | 1;
}

/** How the phone asks. */
export type ScrollbackMode = "newest" | "after" | "before";

/** The question, as read off the query string. */
export interface ScrollbackAsk {
  readonly mode: ScrollbackMode;
  /** The keys of the rows the answer is placed by (empty for `newest`). */
  readonly anchor: readonly string[];
  /** For `after`: the keys of the rows the answer must end before (a gap being filled); null otherwise. */
  readonly until: readonly string[] | null;
  /** The most rows to answer. */
  readonly limit: number;
}

/** What the phone is told about the place its anchor names and the rows that go with it. */
export interface ScrollbackAnswer {
  /** The rows, oldest first. */
  rows: ScrollRow[];
  /** The anchor names exactly one place in the history this side read. Always true for `newest`, which has no anchor. */
  found: boolean;
  /** `after`: how many settled rows lie between the anchor and the first row sent (they were left out). */
  skipped: number;
  /** `after` with `until`: how many settled rows lie between the last row sent and the place `until` names. Zero when the gap is closed. */
  remaining: number;
  /** `after` with `until`: the place `until` names was found and the rows sent run right up to it (the gap is closed). */
  joined: boolean;
  /** The rows sent begin at the oldest row the multiplexer still holds. */
  head: boolean;
  /** How many settled rows the multiplexer holds in all, as far as this read saw (a lower bound when the read stopped short of the head). */
  total: number;
}

/** The sentence-free words an unanswered question gives instead of an answer. */
export type ScrollbackRefusal = "badanchor" | "badmode";

/** A question read from a request: the ask, or the word saying why it is not one. */
export type ScrollbackQuestion = { readonly ok: true; readonly ask: ScrollbackAsk } | { readonly ok: false; readonly refusal: ScrollbackRefusal };

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
/** CSI, OSC and two-character escapes: the same reading of a styled row as the page's own tokenizer. */
const ESCAPE_RE = new RegExp(`${ESC}\\[[<=>?]*[0-9;:]*[ -/]*[@-~]?|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[\\s\\S]?`, "g");
const KEY_RE = /^[0-9a-f]{8}$/u;

/**
 * What a row says, without its colours and without the blanks at its end.
 * @param row The row as read.
 * @returns The plain text.
 */
export function plainOf(row: string): string {
  return row.replace(ESCAPE_RE, "").trimEnd();
}

/**
 * The key of a row: a short hash of what it says.
 * @param row The row as read (escapes allowed).
 * @returns Eight hex digits; {@link BLANK_KEY} for a blank row.
 */
export function rowKey(row: string): string {
  const plain = plainOf(row);
  if (plain === "") return BLANK_KEY;
  return createHash("sha256").update(plain).digest("hex").slice(0, KEY_LENGTH);
}

/**
 * Whether a row has enough words to tell it from its neighbours: a rule, a box edge or a prompt alone does not.
 * @param row The row as read.
 * @returns True for an informative row.
 */
export function isInformative(row: string): boolean {
  const plain = plainOf(row);
  if (plain.length < INFORMATIVE_CHARS) return false;
  let words = 0;
  for (const char of plain) {
    if (/[\p{L}\p{N}]/u.test(char)) words++;
    if (words >= INFORMATIVE_WORDS) return true;
  }
  return false;
}

/**
 * Rows as the phone keeps them.
 * @param rows The rows as read, oldest first.
 * @returns One {@link ScrollRow} each.
 */
export function toRows(rows: readonly string[]): ScrollRow[] {
  return rows.map((s) => ({ s, k: rowKey(s), i: isInformative(s) ? 1 : 0 }));
}

/**
 * Read an anchor off a query word.
 * @param raw Keys joined by commas.
 * @returns The keys; null when the word is not an anchor (a wrong key, none, or more than {@link ANCHOR_MAX_ROWS}).
 */
export function parseAnchor(raw: string | null): string[] | null {
  if (raw === null || raw === "") return null;
  const keys = raw.split(",");
  if (keys.length > ANCHOR_MAX_ROWS) return null;
  return keys.every((key) => KEY_RE.test(key)) ? keys : null;
}

/**
 * The question in a query string.
 * @param params The URL's query.
 * @returns The question, or the refusal that says what is wrong with it.
 */
export function parseAsk(params: URLSearchParams): ScrollbackQuestion {
  const mode = params.get(SCROLLBACK_PARAM);
  if (mode !== "newest" && mode !== "after" && mode !== "before") return { ok: false, refusal: "badmode" };
  const raw = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, SCROLLBACK_MAX_LIMIT) : SCROLLBACK_DEFAULT_LIMIT;
  if (mode === "newest") return { ok: true, ask: { mode, anchor: [], until: null, limit } };
  const anchor = parseAnchor(params.get("anchor"));
  if (anchor === null) return { ok: false, refusal: "badanchor" };
  if (mode === "before") return { ok: true, ask: { mode, anchor, until: null, limit } };
  const untilWord = params.get("until");
  if (untilWord === null) return { ok: true, ask: { mode, anchor, until: null, limit } };
  const until = parseAnchor(untilWord);
  return until === null ? { ok: false, refusal: "badanchor" } : { ok: true, ask: { mode, anchor, until, limit } };
}

/** What looking for an anchor can come to: the place it starts at, none, or more than one. */
export type Place = { readonly kind: "at"; readonly at: number } | { readonly kind: "none" } | { readonly kind: "several" };

/**
 * Where a run of keys sits in a list of rows.
 * @param keys The keys of the rows to look in.
 * @param anchor The run to find.
 * @param from The first row to look at.
 * @returns The one place the run starts at; `none` when it is nowhere; `several` when it is in more than one (never guessed).
 */
export function placeOf(keys: readonly string[], anchor: readonly string[], from = 0): Place {
  let found = -1;
  for (let at = from; at + anchor.length <= keys.length; at++) {
    let same = true;
    for (let k = 0; k < anchor.length; k++) {
      if (keys[at + k] !== anchor[k]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    if (found !== -1) return { kind: "several" };
    found = at;
  }
  return found === -1 ? { kind: "none" } : { kind: "at", at: found };
}

/**
 * Cut the answer out of the settled rows.
 * @param settled The rows that have left the screen, oldest first.
 * @param head Whether the first of them is the oldest row the multiplexer holds.
 * @param ask The question.
 * @returns The answer.
 */
export function cut(settled: readonly ScrollRow[], head: boolean, ask: ScrollbackAsk): ScrollbackAnswer {
  const keys = settled.map((row) => row.k);
  const answer: ScrollbackAnswer = { rows: [], found: false, skipped: 0, remaining: 0, joined: false, head: false, total: settled.length };
  const newest = (): void => {
    const start = Math.max(0, settled.length - ask.limit);
    answer.rows = settled.slice(start);
    answer.head = start === 0 && head;
  };
  if (ask.mode === "newest") {
    answer.found = true;
    newest();
    return answer;
  }
  const place = placeOf(keys, ask.anchor);
  if (place.kind !== "at") {
    // A place that cannot be told is a place never guessed: the phone gets the newest rows and starts a new run of its own.
    if (ask.mode === "after") newest();
    return answer;
  }
  answer.found = true;
  if (ask.mode === "before") {
    const end = place.at;
    const start = Math.max(0, end - ask.limit);
    answer.rows = settled.slice(start, end);
    answer.head = start === 0 && head;
    return answer;
  }
  const begin = place.at + ask.anchor.length;
  if (ask.until === null) {
    const from = Math.max(begin, settled.length - ask.limit);
    answer.rows = settled.slice(from);
    answer.skipped = from - begin;
    return answer;
  }
  // A gap being filled: the rows next to the older end, up to where `until` starts.
  const stop = placeOf(keys, ask.until, begin);
  const end = stop.kind === "at" ? stop.at : settled.length;
  const to = Math.min(end, begin + ask.limit);
  answer.rows = settled.slice(begin, to);
  answer.remaining = end - to;
  answer.joined = stop.kind === "at" && to === end;
  return answer;
}

/** The two reads the answer is made of. */
export type ScrollbackReader = Pick<MuxAdapter, "readGrid">;

/** What {@link scrollbackRead} comes to. */
export type ScrollbackResult =
  | { kind: "answer"; paneId: string; screen: string; revision: number; answer: ScrollbackAnswer }
  /** The ends of the two reads did not meet in {@link MEETING_TRIES} tries: the phone asks again. */
  | { kind: "moving"; paneId: string; screen: string; revision: number }
  /** The multiplexer would not read the history (the agent waits on a person, a read is still running); its sentence. */
  | { kind: "unavailable"; paneId: string; screen: string; revision: number; note: string }
  /** The multiplexer refused the read; its sentence. */
  | { kind: "refused"; detail: string };

/** What the caller gives besides the question. */
export interface ScrollbackOptions {
  /** What the bridge knows about the pane (a blocked pane gets no history read on herdr-core). */
  hint?: MuxReadHint | undefined;
  /** Mask secrets in every row (`COLLIE_REDACT`). */
  redact: boolean;
  /** Waits between the tries when the two reads do not meet; replaced by a test. */
  pause?: (ms: number) => Promise<void>;
}

/**
 * The history read: the rows above the screen too, which is a person's Load older on every multiplexer that tells the two apart.
 * @param lines How many rows to ask for.
 * @param hint What the bridge knows about the pane.
 * @returns The request.
 */
function historyRequest(lines: number, hint: MuxReadHint | undefined): MuxGridRequest {
  const base: MuxGridRequest = { scope: "recent", lines, styling: "preserve", purpose: "older" };
  if (hint === undefined) return base;
  return { ...base, hint };
}

/** The rows of a read, as lines. A read ends in one line break at most, which starts no row. */
function linesOf(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}

/**
 * Whether the end of a list is the screen: the same rows, by what they say.
 * @param list The rows of the history read (screen included).
 * @param screen The rows of the screen read.
 * @returns True when the last rows of `list` are `screen`.
 */
function endsWithScreen(list: readonly string[], screen: readonly string[]): boolean {
  if (screen.length > list.length) return false;
  const offset = list.length - screen.length;
  return screen.every((row, at) => plainOf(row) === plainOf(list[offset + at] ?? ""));
}

/**
 * Answer one scrollback question from the multiplexer's reads.
 * @param mux The adapter to read from.
 * @param paneId The pane.
 * @param ask The question.
 * @param options The bridge's hint, whether to mask, and the pause between tries.
 * @returns The answer, or why there is none.
 */
export async function scrollbackRead(mux: ScrollbackReader, paneId: string, ask: ScrollbackAsk, options: ScrollbackOptions): Promise<ScrollbackResult> {
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const mask = (text: string): string => (options.redact ? redactAnsi(text, true) : text);
  let depth = ask.mode === "newest" ? ask.limit + NEWEST_EXTRA : FIRST_DEPTH;
  for (let tries = 0; ; ) {
    const [screenRead, historyRead] = await Promise.all([
      mux.readGrid(paneId, { scope: "viewport", lines: 1, styling: "preserve" }),
      mux.readGrid(paneId, historyRequest(depth, options.hint)),
    ]);
    if (!screenRead.ok) return { kind: "refused", detail: screenRead.detail };
    if (!historyRead.ok) return { kind: "refused", detail: historyRead.detail };
    const screenText = mask(screenRead.value.text);
    const here = { screen: screenText, revision: historyRead.value.revision };
    if (historyRead.value.olderNote !== undefined) return { kind: "unavailable", paneId, ...here, note: historyRead.value.olderNote };
    const screenRows = linesOf(screenText);
    const list = linesOf(mask(historyRead.value.text));
    if (!endsWithScreen(list, screenRows)) {
      if (++tries >= MEETING_TRIES) return { kind: "moving", paneId, ...here };
      await pause(MEETING_PAUSE_MS);
      continue;
    }
    const settled = toRows(list.slice(0, list.length - screenRows.length));
    // The read held everything the multiplexer has when it answered fewer rows than asked, or said it was partial.
    const head = historyRead.value.partial === true || list.length < depth;
    const answer = cut(settled, head, ask);
    const searching = ask.mode !== "newest" && !answer.found && !head && depth < MAX_READ_LINES;
    if (searching) {
      depth = MAX_READ_LINES;
      continue;
    }
    return { kind: "answer", paneId, ...here, answer };
  }
}

/** What the `scrollback` member of the answer holds. */
export type ScrollbackPayload =
  | ({ state: "rows" } & ScrollbackAnswer)
  /** The ends of the two reads did not meet: ask again. */
  | { state: "moving" }
  /** The multiplexer would not read the history now; its sentence for the phone. */
  | { state: "unavailable"; note: string };

/**
 * The body of `GET /api/pane/:id?scrollback=...`. It is shaped like a pane read (the screen as `text`, so a crew lead masks and
 * forwards it by the same rule) with the rows in `scrollback`. The screen text is the one the rows were cut against, so a phone
 * that joins its rows to this text has no row twice and none missing at the join.
 */
export interface ScrollbackBody extends PaneReadResponse {
  scrollback: ScrollbackPayload;
}

/**
 * The answer body of a read that was not refused.
 * @param result What {@link scrollbackRead} came to (a refusal is an error response, not a body).
 * @returns The body to send.
 */
export function scrollbackBody(result: Exclude<ScrollbackResult, { kind: "refused" }>): ScrollbackBody {
  const base = { paneId: result.paneId, text: result.screen, truncated: true, revision: result.revision };
  if (result.kind === "answer") return { ...base, scrollback: { state: "rows", ...result.answer } };
  if (result.kind === "moving") return { ...base, scrollback: { state: "moving" } };
  return { ...base, scrollback: { state: "unavailable", note: result.note } };
}
