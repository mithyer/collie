import { act, render } from "@testing-library/react";
import { vi } from "vitest";

import { TranscriptView } from "./transcript-view";
import { __resetLocale, setLocale, whenLocaleReady } from "@/lib/i18n";
import type { TranscriptEntry } from "@/lib/types";

// A thread of several hundred turns re-renders on every poll, because the newest turn grows while the agent writes.
// Drawing every turn again for that made the cost of an update grow with the length of the thread (about half a
// millisecond per turn on a phone-class CPU), so each row is memoised and a turn that did not change is not drawn
// again. These cases count how often a turn's prose is drawn: that is what a skipped row saves.

const draws = vi.hoisted(() => ({ texts: new Array<string>() }));

vi.mock("./markdown-text", async (importActual) => {
  const actual = await importActual<typeof import("./markdown-text")>();
  return {
    ...actual,
    // The prose of a turn, standing in for the real renderer so that every draw is counted.
    MarkdownText: ({ text }: { text: string }) => {
      draws.texts.push(text);
      return <p>{text}</p>;
    },
  };
});

const turn = (uuid: string, text: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid,
  ts: "2026-07-25T06:22:21.253Z",
  role: "assistant",
  parts: [{ kind: "text", text }],
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  draws.texts.length = 0;
  __resetLocale();
});

describe("TranscriptView: rows that did not change are not drawn again", () => {
  it("draws only the turn that changed when the thread is handed over again", () => {
    const a = turn("a", "first");
    const b = turn("b", "second");
    const c = turn("c", "third");
    const view = render(<TranscriptView entries={[a, b, c]} agent="pi" />);
    expect(draws.texts).toEqual(["first", "second", "third"]);

    draws.texts.length = 0;
    // A new list with the same turn objects and one new object for the turn that grew: the shape of a poll.
    view.rerender(<TranscriptView entries={[a, b, turn("c", "third, longer")]} agent="pi" />);
    expect(draws.texts).toEqual(["third, longer"]);
  });

  it("draws nothing again when the very same turns come back", () => {
    const entries = [turn("a", "first"), turn("b", "second")];
    const view = render(<TranscriptView entries={entries} agent="pi" />);
    draws.texts.length = 0;
    view.rerender(<TranscriptView entries={[...entries]} agent="pi" />);
    expect(draws.texts).toEqual([]);
  });

  it("keeps the speaker grouping when only a later turn changed", () => {
    const entries = [turn("a", "first"), turn("b", "second")];
    const view = render(<TranscriptView entries={entries} agent="pi" />);
    view.rerender(<TranscriptView entries={[entries[0]!, turn("b", "second, longer")]} agent="pi" />);
    // One run of one speaker: its header is drawn once, above the first turn only.
    expect(view.container.querySelectorAll("[data-turn]")).toHaveLength(2);
    expect(view.container.textContent?.match(/pi/g)).toHaveLength(1);
  });

  it("gives a turn its header when a turn goes in front of it", () => {
    const a = turn("a", "first");
    const b = turn("b", "second");
    const view = render(<TranscriptView entries={[a, b]} agent="pi" />);
    // The user turn now leads: the assistant run starts after it, so its first turn (a) must draw a header it did not have.
    view.rerender(<TranscriptView entries={[turn("u", "question", { role: "user" }), a, b]} agent="pi" />);
    expect(view.container.textContent).toContain("You");
    expect(view.container.textContent?.match(/pi/g)).toHaveLength(1);
  });

  it("draws every turn again when the find query changes", () => {
    const entries = [turn("a", "first"), turn("b", "second")];
    const view = render(<TranscriptView entries={entries} agent="pi" />);
    draws.texts.length = 0;
    view.rerender(<TranscriptView entries={entries} agent="pi" query="first" />);
    expect(draws.texts.toSorted()).toEqual(["first", "second"]);
  });

  it("draws every turn again when the language changes", async () => {
    const entries = [turn("a", "first"), turn("b", "second")];
    render(<TranscriptView entries={entries} agent="pi" />);
    draws.texts.length = 0;
    await act(async () => {
      setLocale("de");
      await whenLocaleReady();
    });
    expect(draws.texts.length).toBeGreaterThanOrEqual(2);
  });
});
