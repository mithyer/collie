// A lead that masks must mask the rows of a member's scrollback answer too (Dogr build, bridge/scrollback.ts), and it must refuse an
// answer whose rows it cannot read as text, because a row it passed over would go to the phone in clear.
// Placeholders only: the fake key is built at run time, so no key shape sits in this file.
import { describe, expect, test } from "bun:test";

import { maskPaneRead } from "../answer-mask.ts";
import { rowKey, type ScrollbackBody } from "../scrollback.ts";
import { maskForwardedAnswer } from "./mask.ts";

const key = `sk-test-placeholder-${"0".repeat(40)}`;

/** A member's scrollback answer with one row that holds the key. */
const answer: ScrollbackBody = {
  paneId: "w1:p1",
  text: "$ ",
  truncated: true,
  revision: 3,
  scrollback: {
    state: "rows",
    rows: [
      { s: "the agent looked at the file", k: rowKey("the agent looked at the file"), i: 1 },
      { s: `export OPENAI_API_KEY=${key}`, k: rowKey(`export OPENAI_API_KEY=${key}`), i: 1 },
    ],
    found: true,
    skipped: 0,
    remaining: 0,
    joined: false,
    head: false,
    total: 2,
  },
};

describe("the lead's mask of a scrollback answer", () => {
  test("masks every row, by the same function as the member's own route", () => {
    const out = maskForwardedAnswer("pane", JSON.stringify(answer));
    expect(out).toBe(JSON.stringify(maskPaneRead(answer)));
    expect(out).not.toContain(key);
  });

  test("an answer with no rows to mask (the phone must ask again, or the history is unavailable) goes through", () => {
    const moving = { ...answer, scrollback: { state: "moving" } };
    expect(maskForwardedAnswer("pane", JSON.stringify(moving))).not.toBeNull();
    const unavailable = { ...answer, scrollback: { state: "unavailable", note: "The agent waits for you." } };
    expect(maskForwardedAnswer("pane", JSON.stringify(unavailable))).not.toBeNull();
  });

  test("an answer whose rows are not text is refused, never passed on", () => {
    const broken = { ...answer, scrollback: { ...answer.scrollback, rows: [{ s: 7, k: "00000000", i: 1 }] } };
    expect(maskForwardedAnswer("pane", JSON.stringify(broken))).toBeNull();
    const notRows = { ...answer, scrollback: { state: "rows", rows: "no" } };
    expect(maskForwardedAnswer("pane", JSON.stringify(notRows))).toBeNull();
    const notObject = { ...answer, scrollback: "rows" };
    expect(maskForwardedAnswer("pane", JSON.stringify(notObject))).toBeNull();
  });
});
