import { describe, expect, test } from "bun:test";

import type { MuxGrid, MuxGridRequest, MuxOutcome } from "./mux/types.ts";
import {
  ANCHOR_MAX_ROWS,
  BLANK_KEY,
  cut,
  isInformative,
  parseAnchor,
  parseAsk,
  placeOf,
  plainOf,
  rowKey,
  SCROLLBACK_DEFAULT_LIMIT,
  SCROLLBACK_MAX_LIMIT,
  scrollbackRead,
  toRows,
  type ScrollbackAsk,
  type ScrollbackReader,
  type ScrollRow,
} from "./scrollback.ts";

const ESC = String.fromCodePoint(0x1b);
const green = (text: string): string => `${ESC}[32m${text}${ESC}[0m`;

/** A made-up line that tells itself from every other: informative, and never the same twice. */
const line = (n: number): string => `step ${String(n).padStart(4, "0")}: the agent changed file number ${String(n)}`;
const lines = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, at) => line(from + at));
/** The anchor the phone would send for the last rows of a list (four informative rows at the least). */
const anchorOf = (rows: readonly ScrollRow[]): string[] => {
  const keys: string[] = [];
  let informative = 0;
  for (let at = rows.length - 1; at >= 0 && keys.length < ANCHOR_MAX_ROWS && informative < 4; at--) {
    keys.unshift(rows[at]!.k);
    if (rows[at]!.i === 1) informative++;
  }
  return keys;
};

describe("a row's key", () => {
  test("is the same for the styled and the plain row, and for trailing blanks", () => {
    expect(rowKey(green("hello there, friend"))).toBe(rowKey("hello there, friend"));
    expect(rowKey("hello there, friend   ")).toBe(rowKey("hello there, friend"));
    expect(rowKey(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ text`)).toBe(rowKey("link text"));
  });
  test("tells two rows apart and is eight hex digits; a blank row has the blank key", () => {
    expect(rowKey("one")).not.toBe(rowKey("two"));
    expect(rowKey("one")).toMatch(/^[0-9a-f]{8}$/u);
    expect(rowKey("")).toBe(BLANK_KEY);
    expect(rowKey(`${ESC}[0m   `)).toBe(BLANK_KEY);
    expect(plainOf(`${ESC}[1mbold${ESC}[0m  `)).toBe("bold");
  });
});

describe("an informative row", () => {
  test("has enough words; a rule, a box edge, a prompt or a short word has not", () => {
    expect(isInformative("the agent changed file number 3")).toBe(true);
    expect(isInformative(green("the agent changed file number 3"))).toBe(true);
    expect(isInformative("────────────────────────────────")).toBe(false);
    expect(isInformative("│                              │")).toBe(false);
    expect(isInformative("$ ls")).toBe(false);
    expect(isInformative("")).toBe(false);
    expect(isInformative("short line")).toBe(false);
  });
});

describe("the question", () => {
  const ask = (query: string) => parseAsk(new URLSearchParams(query));
  const key = "0123abcd";
  test("newest needs no anchor and clamps its limit", () => {
    expect(ask("scrollback=newest")).toEqual({ ok: true, ask: { mode: "newest", anchor: [], until: null, limit: SCROLLBACK_DEFAULT_LIMIT } });
    expect(ask("scrollback=newest&limit=50")).toMatchObject({ ask: { limit: 50 } });
    expect(ask("scrollback=newest&limit=999999")).toMatchObject({ ask: { limit: SCROLLBACK_MAX_LIMIT } });
    expect(ask("scrollback=newest&limit=-4")).toMatchObject({ ask: { limit: SCROLLBACK_DEFAULT_LIMIT } });
  });
  test("after and before need an anchor of keys; until is optional on after", () => {
    expect(ask(`scrollback=after&anchor=${key},${BLANK_KEY}`)).toEqual({ ok: true, ask: { mode: "after", anchor: [key, BLANK_KEY], until: null, limit: SCROLLBACK_DEFAULT_LIMIT } });
    expect(ask(`scrollback=after&anchor=${key}&until=${BLANK_KEY}`)).toMatchObject({ ask: { until: [BLANK_KEY] } });
    expect(ask(`scrollback=before&anchor=${key}`)).toMatchObject({ ask: { mode: "before", anchor: [key] } });
    expect(ask("scrollback=after")).toEqual({ ok: false, refusal: "badanchor" });
    expect(ask("scrollback=before&anchor=zz")).toEqual({ ok: false, refusal: "badanchor" });
    expect(ask(`scrollback=after&anchor=${key}&until=nope`)).toEqual({ ok: false, refusal: "badanchor" });
  });
  test("a word that is no mode is refused", () => {
    expect(ask("scrollback=sideways")).toEqual({ ok: false, refusal: "badmode" });
    expect(ask("scrollback=")).toEqual({ ok: false, refusal: "badmode" });
  });
  test("an anchor has at most ANCHOR_MAX_ROWS keys", () => {
    expect(parseAnchor(Array.from({ length: ANCHOR_MAX_ROWS }, () => key).join(","))).toHaveLength(ANCHOR_MAX_ROWS);
    expect(parseAnchor(Array.from({ length: ANCHOR_MAX_ROWS + 1 }, () => key).join(","))).toBeNull();
    expect(parseAnchor("")).toBeNull();
    expect(parseAnchor(null)).toBeNull();
  });
});

describe("the place of an anchor", () => {
  const keys = ["a", "b", "c", "a", "b", "d"];
  test("is the one place it starts at, none, or several (never a guess)", () => {
    expect(placeOf(keys, ["b", "c"])).toEqual({ kind: "at", at: 1 });
    expect(placeOf(keys, ["c", "z"])).toEqual({ kind: "none" });
    expect(placeOf(keys, ["a", "b"])).toEqual({ kind: "several" });
    expect(placeOf(keys, ["a", "b"], 2)).toEqual({ kind: "at", at: 3 });
    expect(placeOf(keys, ["d"])).toEqual({ kind: "at", at: 5 });
    expect(placeOf([], ["d"])).toEqual({ kind: "none" });
  });
});

describe("the cut", () => {
  const settled = toRows(lines(0, 300));
  const mode = (over: Partial<ScrollbackAsk>): ScrollbackAsk => ({ mode: "newest", anchor: [], until: null, limit: 100, ...over });

  test("newest is the last rows, and says whether the first of them is the oldest the multiplexer holds", () => {
    const some = cut(settled, true, mode({ limit: 100 }));
    expect(some.rows).toHaveLength(100);
    expect(some.rows[0]!.s).toBe(line(200));
    expect(some.head).toBe(false);
    expect(some.total).toBe(300);
    const all = cut(settled, true, mode({ limit: 500 }));
    expect(all.rows).toHaveLength(300);
    expect(all.head).toBe(true);
    expect(cut(settled, false, mode({ limit: 500 })).head).toBe(false);
  });

  test("after brings the rows since the anchor, and the newest of them with the number left out when there are too many", () => {
    const anchor = anchorOf(settled.slice(0, 250));
    const some = cut(settled, true, mode({ mode: "after", anchor, limit: 100 }));
    expect(some.found).toBe(true);
    expect(some.rows.map((r) => r.s)).toEqual(lines(250, 300));
    expect(some.skipped).toBe(0);
    const early = anchorOf(settled.slice(0, 100));
    const many = cut(settled, true, mode({ mode: "after", anchor: early, limit: 60 }));
    expect(many.rows.map((r) => r.s)).toEqual(lines(240, 300));
    expect(many.skipped).toBe(140);
  });

  test("after with an anchor at the very end brings nothing, and is still found", () => {
    const anchor = anchorOf(settled);
    const none = cut(settled, true, mode({ mode: "after", anchor }));
    expect(none.found).toBe(true);
    expect(none.rows).toEqual([]);
  });

  test("an anchor that is nowhere gives the newest rows and found: false, so the phone starts a run of its own", () => {
    const stranger = anchorOf(toRows(lines(900, 910)));
    const answer = cut(settled, true, mode({ mode: "after", anchor: stranger, limit: 40 }));
    expect(answer.found).toBe(false);
    expect(answer.rows.map((r) => r.s)).toEqual(lines(260, 300));
    expect(cut(settled, true, mode({ mode: "before", anchor: stranger })).rows).toEqual([]);
  });

  test("an anchor that fits two places is not guessed", () => {
    const twice = toRows([...lines(0, 20), ...lines(0, 20)]);
    const anchor = anchorOf(toRows(lines(0, 20)));
    const answer = cut(twice, true, mode({ mode: "after", anchor, limit: 10 }));
    expect(answer.found).toBe(false);
    expect(cut(twice, true, mode({ mode: "before", anchor })).rows).toEqual([]);
  });

  test("before brings the rows right above the anchor, and says when they reach the oldest row", () => {
    const anchor = anchorOf(toRows(lines(150, 160)).slice(-5)).slice(-3);
    const upper = cut(settled, true, mode({ mode: "before", anchor: settled.slice(150, 153).map((r) => r.k), limit: 100 }));
    expect(upper.found).toBe(true);
    expect(upper.rows.map((r) => r.s)).toEqual(lines(50, 150));
    expect(upper.head).toBe(false);
    const top = cut(settled, true, mode({ mode: "before", anchor: settled.slice(30, 33).map((r) => r.k), limit: 100 }));
    expect(top.rows.map((r) => r.s)).toEqual(lines(0, 30));
    expect(top.head).toBe(true);
    expect(cut(settled, false, mode({ mode: "before", anchor: settled.slice(30, 33).map((r) => r.k), limit: 100 })).head).toBe(false);
    expect(anchor.length).toBeGreaterThan(0);
  });

  test("a gap being filled gives the rows next to its older end, how many remain, and whether it closed", () => {
    const from = settled.slice(0, 100).map((r) => r.k).slice(-3);
    const until = settled.slice(200, 203).map((r) => r.k);
    const part = cut(settled, true, mode({ mode: "after", anchor: from, until, limit: 60 }));
    expect(part.rows.map((r) => r.s)).toEqual(lines(100, 160));
    expect(part.remaining).toBe(40);
    expect(part.joined).toBe(false);
    const whole = cut(settled, true, mode({ mode: "after", anchor: from, until, limit: 500 }));
    expect(whole.rows.map((r) => r.s)).toEqual(lines(100, 200));
    expect(whole.remaining).toBe(0);
    expect(whole.joined).toBe(true);
    const gone = cut(settled, true, mode({ mode: "after", anchor: from, until: [rowKey("not there at all, nothing")], limit: 500 }));
    expect(gone.joined).toBe(false);
    expect(gone.rows.map((r) => r.s)).toEqual(lines(100, 300));
  });
});

/**
 * A multiplexer that holds one document and shows its last rows as the screen; the history read answers the last N rows of it, and
 * `partial` when asked for more than it holds (what herdr-core does).
 */
function reader(document: () => string[], screenRows: number, seen: MuxGridRequest[] = []): ScrollbackReader {
  return {
    readGrid: async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
      seen.push(request);
      const rows = document();
      if (request.scope === "viewport") return { ok: true, value: { paneId, text: rows.slice(-screenRows).join("\n"), truncated: false, revision: 7 } };
      const slice = rows.slice(-request.lines);
      if (request.lines > rows.length) return { ok: true, value: { paneId, text: slice.join("\n"), truncated: false, revision: 7, partial: true } };
      return { ok: true, value: { paneId, text: slice.join("\n"), truncated: false, revision: 7 } };
    },
  };
}

const noPause = async (): Promise<void> => undefined;
const newest = (limit: number): ScrollbackAsk => ({ mode: "newest", anchor: [], until: null, limit });

describe("reading the answer from the multiplexer", () => {
  test("newest leaves the screen out: those rows have not settled", async () => {
    const doc = lines(0, 200);
    const result = await scrollbackRead(reader(() => doc, 40), "w1:p1", newest(50), { redact: false, pause: noPause });
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.answer.rows.map((r) => r.s)).toEqual(lines(110, 160));
    expect(result.screen).toBe(lines(160, 200).join("\n"));
    expect(result.revision).toBe(7);
    expect(result.answer.total).toBe(160);
    expect(result.answer.head).toBe(false);
  });

  test("a pane with little history says it reached the head", async () => {
    const doc = lines(0, 60);
    const result = await scrollbackRead(reader(() => doc, 40), "w1:p1", newest(100), { redact: false, pause: noPause });
    expect(result.kind === "answer" && result.answer.head).toBe(true);
    expect(result.kind === "answer" && result.answer.rows).toHaveLength(20);
  });

  test("after finds its place in a history deeper than the first read, by reading the whole history once", async () => {
    const doc = lines(0, 3000);
    const seen: MuxGridRequest[] = [];
    const anchor = anchorOf(toRows(lines(0, 100)));
    const result = await scrollbackRead(reader(() => doc, 40, seen), "w1:p1", { mode: "after", anchor, until: null, limit: 200 }, { redact: false, pause: noPause });
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.answer.found).toBe(true);
    // 2960 settled rows, the anchor ends at row 100, the newest 200 are sent: 2760 - 100 rows were left out.
    expect(result.answer.skipped).toBe(2660);
    expect(result.answer.rows.map((r) => r.s)).toEqual(lines(2760, 2960));
    const deep = seen.filter((request) => request.scope === "recent").map((request) => request.lines);
    expect(deep).toEqual([1500, 10_000]);
  });

  test("after with an anchor near the end needs one read only", async () => {
    const doc = lines(0, 3000);
    const seen: MuxGridRequest[] = [];
    const anchor = anchorOf(toRows(lines(0, 2900)));
    const result = await scrollbackRead(reader(() => doc, 40, seen), "w1:p1", { mode: "after", anchor, until: null, limit: 200 }, { redact: false, pause: noPause });
    expect(result.kind === "answer" && result.answer.rows.map((r) => r.s)).toEqual(lines(2900, 2960));
    expect(seen.filter((request) => request.scope === "recent")).toHaveLength(1);
  });

  test("an anchor the multiplexer no longer holds is found: false after the whole history was read", async () => {
    const doc = lines(1000, 1400);
    const seen: MuxGridRequest[] = [];
    const anchor = anchorOf(toRows(lines(0, 100)));
    const result = await scrollbackRead(reader(() => doc, 40, seen), "w1:p1", { mode: "after", anchor, until: null, limit: 30 }, { redact: false, pause: noPause });
    expect(result.kind === "answer" && result.answer.found).toBe(false);
    expect(result.kind === "answer" && result.answer.rows).toHaveLength(30);
    // The first read already held everything (fewer rows than asked): no second read.
    expect(seen.filter((request) => request.scope === "recent")).toHaveLength(1);
  });

  test("the history read is the Load older kind and carries the bridge's hint", async () => {
    const seen: MuxGridRequest[] = [];
    const hint = { blocked: true } as const;
    await scrollbackRead(reader(() => lines(0, 100), 40, seen), "w1:p1", newest(10), { redact: false, hint, pause: noPause });
    const history = seen.find((request) => request.scope === "recent")!;
    expect(history.purpose).toBe("older");
    expect(history.styling).toBe("preserve");
    expect(history.hint).toEqual(hint);
  });

  test("when the screen moves between the two reads the answer says so, after a few tries", async () => {
    let calls = 0;
    const flaky: ScrollbackReader = {
      readGrid: async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
        calls++;
        const text = request.scope === "viewport" ? lines(500, 540).join("\n") : lines(0, 300).join("\n");
        return { ok: true, value: { paneId, text, truncated: false, revision: 1 } };
      },
    };
    const result = await scrollbackRead(flaky, "w1:p1", newest(20), { redact: false, pause: noPause });
    expect(result.kind).toBe("moving");
    expect(calls).toBe(6);
  });

  test("a screen that settles on the second try gives an answer", async () => {
    let round = 0;
    const doc = lines(0, 200);
    const inner = reader(() => doc, 40);
    const once: ScrollbackReader = {
      readGrid: async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
        const answer = await inner.readGrid(paneId, request);
        if (request.scope === "viewport" && round++ === 0 && answer.ok) return { ok: true, value: { ...answer.value, text: lines(300, 340).join("\n") } };
        return answer;
      },
    };
    const result = await scrollbackRead(once, "w1:p1", newest(10), { redact: false, pause: noPause });
    expect(result.kind).toBe("answer");
  });

  test("a history the multiplexer would not read comes back as its sentence, not as an empty history", async () => {
    const waiting: ScrollbackReader = {
      readGrid: async (paneId: string): Promise<MuxOutcome<MuxGrid>> => ({ ok: true, value: { paneId, text: "screen", truncated: true, revision: 3, olderNote: "The agent waits for you." } }),
    };
    const result = await scrollbackRead(waiting, "w1:p1", newest(10), { redact: false, pause: noPause });
    expect(result).toMatchObject({ kind: "unavailable", note: "The agent waits for you.", screen: "screen" });
  });

  test("a refused read is passed on", async () => {
    const refusing: ScrollbackReader = {
      readGrid: async (): Promise<MuxOutcome<MuxGrid>> => ({ ok: false, reason: "gone", detail: "no such pane" }),
    };
    const result = await scrollbackRead(refusing, "w1:p1", newest(10), { redact: false, pause: noPause });
    expect(result).toEqual({ kind: "refused", detail: "no such pane" });
  });

  test("a secret is masked in every row and in the screen, and the keys follow the masked rows", async () => {
    const secret = ["sk-ant-api03-", "placeholder", "0".repeat(40)].join("");
    const doc = [...lines(0, 80), `token is ${secret} keep it safe`, ...lines(80, 120)];
    const masked = await scrollbackRead(reader(() => doc, 20), "w1:p1", newest(100), { redact: true, pause: noPause });
    const open = await scrollbackRead(reader(() => doc, 20), "w1:p1", newest(100), { redact: false, pause: noPause });
    if (masked.kind !== "answer" || open.kind !== "answer") throw new Error("no answer");
    expect(JSON.stringify(masked.answer.rows)).not.toContain(secret);
    expect(JSON.stringify(open.answer.rows)).toContain(secret);
    const hidden = masked.answer.rows.find((row) => row.s.includes("token is"))!;
    expect(hidden.s.length).toBe(`token is ${secret} keep it safe`.length);
  });
});
