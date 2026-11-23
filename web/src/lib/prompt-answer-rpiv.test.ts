import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A single rpiv-ask-user-question page answered in the person's own words: its last row, `Type something.`, is the
// card's answer field (pi harness, real pi 1.6.0 captures of 2026-11-23). The shared recipe (lib/answer-field.ts)
// reaches it, clears it, types and proves the words; then `Enter`, bound to the read that proved them. The api layer
// is mocked so the mid-flight screens can be sequenced; every screen is a real capture or one row of it changed.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { piAdapter } from "./harness/pi";
import type { PromptModel } from "./harness/prompt-model";
import { submitPromptFeedback, submitPromptOption } from "./prompt-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

const PANES = join(import.meta.dirname, "../fixtures/panes");
const read = (name: string) => readFileSync(join(PANES, `pi--v160-rpiv-single-free-${name}--w200.txt`), "utf8");
const LEFT_EMPTY = read("left-empty");
const LEFT_TYPED = read("left-typed");
const FOCUSED_EMPTY = read("focused-empty");
const FOCUSED_TYPED = read("focused-typed");

function prompt(text: string): PromptModel {
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(text))).find((b) => b.kind === "prompt-select");
  if (block?.kind !== "prompt-select") throw new Error("the capture did not lift as a question card");
  return block.prompt;
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

describe("a single rpiv question answered in words", () => {
  // TEST: ask.test.ts[the input row as an answer field] reads the same captures; the recipe is lib/answer-field.ts, the commit lib/prompt-action.ts (submitPromptAnswer).
  it("an empty row: its digit opens the editor, the words are typed, and one bound Enter answers", async () => {
    script(LEFT_EMPTY, LEFT_EMPTY, FOCUSED_EMPTY, FOCUSED_EMPTY, FOCUSED_TYPED, FOCUSED_TYPED, FOCUSED_TYPED);
    const res = await submitPromptFeedback({ ...base, prompt: prompt(LEFT_EMPTY), text: "purple" });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()[0]).toEqual(["3"]);
    expect(keysSent().at(-1)).toEqual(["Enter"]);
    expect(keysSent().filter((k) => k[0] === "Enter")).toHaveLength(1);
    expect(mockSendReply.mock.calls.map((c) => [c[1], c[2]])).toEqual([["purple", false]]);
    // The Enter is bound to the screen that proved the words, so a key at the terminal after it makes the bridge refuse.
    expect(mockSendKeys.mock.calls.at(-1)![3]).toBeDefined();
  });

  it("a draft the pointer left: walked onto, cleared with the pair of edit keys, then typed over", async () => {
    script(LEFT_TYPED, LEFT_TYPED, FOCUSED_TYPED, FOCUSED_TYPED, FOCUSED_EMPTY, FOCUSED_TYPED, FOCUSED_TYPED);
    const res = await submitPromptFeedback({ ...base, prompt: prompt(LEFT_TYPED), text: "purple" });
    expect(res).toEqual({ status: "sent" });
    // The pointer is on Green, one row above the field: Down opens it with the draft in it, and the draft is cleared first.
    expect(keysSent().slice(0, 2)).toEqual([["Down"], ["ctrl+u", "ctrl+k"]]);
    expect(keysSent()).not.toContainEqual(["3"]);
    expect(keysSent().at(-1)).toEqual(["Enter"]);
  });

  it("words that never show in the editor: an error, and no Enter", async () => {
    script(LEFT_EMPTY, LEFT_EMPTY, FOCUSED_EMPTY);
    const res = await submitPromptFeedback({ ...base, prompt: prompt(LEFT_EMPTY), text: "purple" });
    expect(res.status).toBe("error");
    expect(keysSent()).not.toContainEqual(["Enter"]);
  });

  it("a card option is refused while the editor has the keyboard: the walk would type into the draft", async () => {
    script(FOCUSED_TYPED);
    const model = prompt(FOCUSED_TYPED);
    const red = model.options.find((o) => o.label === "Red")!;
    expect(await submitPromptOption({ ...base, prompt: model, option: red })).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
