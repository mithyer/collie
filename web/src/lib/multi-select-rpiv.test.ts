import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// rpiv-ask-user-question's multi-select page with its input row (pi harness, real pi 1.6.0 captures of
// 2026-11-23): the answer recipe and the comparators against the pi adapter's own reader. The api layer is
// mocked so the mid-flight screens can be sequenced; every screen is a real capture or one row of it changed.
// What differs from Claude's field (multi-select-action.test.ts): the digit OPENS the editor, `Enter` in the
// editor commits the WHOLE answer, and the box ticks by itself with the words.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MultiSelectModel } from "./blocks";
import { piAdapter } from "./harness/pi";
import { multiSelectEquals, multiSelectIdentity, submitMultiSelectIntent } from "./multi-select-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

const PANES = join(import.meta.dirname, "../fixtures/panes");
const FOCUSED_EMPTY = readFileSync(join(PANES, "pi--v160-rpiv-multi-free-focused-empty--w200.txt"), "utf8");
const FOCUSED_TYPED = readFileSync(join(PANES, "pi--v160-rpiv-multi-free-focused-typed--w200.txt"), "utf8");
const LEFT_TYPED = readFileSync(join(PANES, "pi--v160-rpiv-multi-free-left-typed--w200.txt"), "utf8");
/** The draft's own row, as the page draws it with the pointer away from it and nothing typed. */
const LEFT_EMPTY = LEFT_TYPED.replace("[✔]", "[ ]").replace("extra anchovies", "Type something.");
/** The editor open with the words typed, but the box reading unticked: a screen rpiv never draws. */
const FOCUSED_TYPED_UNTICKED = FOCUSED_TYPED.replace("[✔]", "[ ]");
const WORDS = "extra anchovies";

function model(text: string): MultiSelectModel {
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(text))).find((b) => b.kind === "multi-select");
  if (block?.kind !== "multi-select") throw new Error("the capture did not lift as a multi-select card");
  return block.multi;
}

/** Serve a script of pane states, one per fetch; the last one repeats. */
function script(...texts: string[]) {
  const queue = [...texts];
  mockFetchPane.mockImplementation(async () => ({
    paneId: "w1:p1",
    text: queue.length > 1 ? queue.shift()! : queue[0]!,
    truncated: false,
    revision: 5,
  }));
}

const base = { paneId: "w1:p1", requestedLines: 600, detectedRevision: 5, agent: "pi", sleep: async () => {} };
const keysSent = () => mockSendKeys.mock.calls.map((c) => c[1]);

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockReset();
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("rpiv's input row as the multi-select card's answer field", () => {
  // TEST: ask.test.ts[the multi-select page] reads the same captures; the recipe is in multi-select-action.ts (runTypeAnswer, tickField, isToggleable).
  it("an empty field: its digit opens the editor, the words are typed, no Enter ever, then one Up leaves the field", async () => {
    script(LEFT_EMPTY, LEFT_EMPTY, FOCUSED_EMPTY, FOCUSED_EMPTY, FOCUSED_TYPED, LEFT_TYPED);
    const res = await submitMultiSelectIntent({ ...base, multi: model(LEFT_EMPTY), intent: { kind: "type", text: WORDS } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()[0]).toEqual(["4"]);
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent()).not.toContainEqual(["Down"]);
    expect(mockSendReply.mock.calls.map((c) => [c[1], c[2]])).toEqual([[WORDS, false]]);
  });

  it("a typed field that reads unticked is refused: the one key that would tick it commits the whole answer", async () => {
    script(FOCUSED_EMPTY, FOCUSED_EMPTY, FOCUSED_EMPTY, FOCUSED_TYPED_UNTICKED);
    const res = await submitMultiSelectIntent({ ...base, multi: model(FOCUSED_EMPTY), intent: { kind: "type", text: WORDS } });
    expect(res.status).toBe("error");
    expect(keysSent()).not.toContainEqual(["Enter"]);
  });

  it("the field's digit is no toggle: its box follows its words and its digit opens the editor", async () => {
    script(LEFT_TYPED);
    const res = await submitMultiSelectIntent({ ...base, multi: model(LEFT_TYPED), intent: { kind: "toggle", n: 4 } });
    expect(res.status).not.toBe("sent");
    expect(keysSent()).not.toContainEqual(["4"]);
  });

  it("a choice's digit toggles it with the pointer where it is, the field untouched", async () => {
    script(LEFT_TYPED);
    const res = await submitMultiSelectIntent({ ...base, multi: model(LEFT_TYPED), intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["1"]]);
  });

  it("the page stays the same page through the keyboard and the typing, but the entry guard sees each change", () => {
    const empty = model(FOCUSED_EMPTY);
    const typed = model(FOCUSED_TYPED);
    const left = model(LEFT_TYPED);
    // Mid-recipe: the pointer walks, the keyboard comes and goes, the words arrive; the advance plan follows the
    // pointer (rpiv's `Up` wrap) and is left out of the identity because of it.
    expect(multiSelectIdentity(empty, typed)).toBe(true);
    expect(multiSelectIdentity(typed, left)).toBe(true);
    expect(multiSelectIdentity(model(LEFT_EMPTY), left)).toBe(true);
    // A tick on a choice is another matter: it is the person's answer and drift for a recipe that did not send it.
    expect(multiSelectIdentity(left, model(LEFT_TYPED.replace("[ ]", "[✔]")))).toBe(false);
    // The entry guard compares the plan and the field exactly: a tap made on one screen is refused on the other.
    expect(multiSelectEquals(typed, left)).toBe(false);
    expect(multiSelectEquals(model(LEFT_EMPTY), left)).toBe(false);
    expect(multiSelectEquals(typed, model(FOCUSED_TYPED))).toBe(true);
  });
});
