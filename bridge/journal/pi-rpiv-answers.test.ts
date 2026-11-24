import { describe, expect, test } from "bun:test";

import { parsePiTranscript } from "./pi.ts";

// rpiv-ask-user-question 2.15.0 on pi 1.6.0: the result rows below have the shape read off a real session on
// 2026-11-24 (a single question, then a multi-select question beside a single one). A multi-select answer
// carries its ticked labels in `selected` and leaves `answer` null; words typed into "Type something" are `answer`.

/** Any JSON document: what a row of the agent's on-disk log is before the adapter parses it. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

/** One log row hanging off its parent, as pi writes them. */
const row = (id: string, parentId: string | null, message: Record<string, JsonValue>) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-24T02:40:00.000Z", message });

/** The question card of the first tool call a log draws, once its result has folded in. */
function cardOf(args: Record<string, JsonValue>, details: Record<string, JsonValue>) {
  const rows = [
    row("a1", null, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ask_user_question", arguments: args }] }),
    row("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "ask_user_question", content: [{ type: "text", text: "answered" }], details }),
  ];
  for (const entry of parsePiTranscript(rows.join("\n"))) for (const part of entry.parts) if (part.kind === "tool") return part.call;
  return undefined;
}

const toppings = { question: "Which toppings?", options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Olives" }] };
const size = { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] };

describe("rpiv-ask-user-question answers", () => {
  test("a multi-select question takes its ticked labels from `selected`, beside a single one", () => {
    const card = cardOf(
      { questions: [toppings, size] },
      {
        answers: [
          { questionIndex: 0, question: "Which toppings?", kind: "multi", answer: null, selected: ["Cheese", "Olives"] },
          { questionIndex: 1, question: "Which size?", kind: "option", answer: "Large" },
        ],
        cancelled: false,
      },
    );
    expect(card).toMatchObject({ kind: "question", answers: [["Cheese", "Olives"], ["Large"]] });
  });

  test("words typed into the multi-select's own row come after the ticked labels, once", () => {
    const card = cardOf(
      { questions: [toppings] },
      { answers: [{ questionIndex: 0, question: "Which toppings?", kind: "multi", answer: "extra anchovies", selected: ["Ham"] }] },
    );
    expect(card).toMatchObject({ kind: "question", answers: [["Ham", "extra anchovies"]] });
    const same = cardOf(
      { questions: [toppings] },
      { answers: [{ questionIndex: 0, question: "Which toppings?", kind: "multi", answer: "Ham", selected: ["Ham"] }] },
    );
    expect(same).toMatchObject({ answers: [["Ham"]] });
  });

  test("a single-choice answer still comes from `answer`, and an empty multi-select leaves the card without answers", () => {
    const one = cardOf({ questions: [size] }, { answers: [{ questionIndex: 0, question: "Which size?", kind: "option", answer: "Small" }] });
    expect(one).toMatchObject({ answers: [["Small"]] });
    const none = cardOf(
      { questions: [toppings] },
      { answers: [{ questionIndex: 0, question: "Which toppings?", kind: "multi", answer: null, selected: [] }] },
    );
    expect(none?.kind === "question" && none.answers).toBeUndefined();
  });
});
