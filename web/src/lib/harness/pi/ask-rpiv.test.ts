// rpiv-ask-user-question's pages (the multi-select page, the input row as an answer field, the footer
// under the bottom rule). They lived in ask.test.ts until upstream's 100 KB cap on a test file (scripts/test-file-size.test.ts)
// asked a new case to go in a new file next to the old one; the rest of the pi corpus is still there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { multiSelectEquals, multiSelectIdentity, type MultiSelectModel } from "../multi-select-model";
import { promptsSameIdentity, type PromptModel } from "../prompt-model";
import { detectPiQuestion } from "./ask";
import { piAdapter } from "./index";
import { idleFor, readScreen } from "../../../test/surface-corpus";
import { liftDialog } from "../../surface/lift";
import { askOf, modalWord } from "../../surface/surface";

const PANES = join(import.meta.dirname, "../../../fixtures/panes");
const raw = (name: string) => readFileSync(join(PANES, name), "utf8");
const linesOf = (text: string) => splitLines(parseAnsi(text));
const load = (name: string) => linesOf(raw(name));

function prompt(lines: StyledLine[]): PromptModel {
  const question = detectPiQuestion(lines);
  if (question?.kind !== "prompt-select") throw new Error("no prompt-select lifted");
  return question.model;
}

describe("rpiv-ask-user-question: the multi-select page (pi 1.5.2 plain read, pi 1.6.0 styled reads)", () => {
  // TEST: pi--v160-rpiv-multi*.txt and pi--v160-rpiv-tabs-multi*.txt are styled reads of a real dialog; pi--v152-rpiv-multi--w200.txt is the plain read the mutations below start from.
  const PLAIN = "pi--v152-rpiv-multi--w200.txt";
  const multi = (lines: StyledLine[]): MultiSelectModel => {
    const question = detectPiQuestion(lines);
    if (question?.kind !== "multi-select") throw new Error("no multi-select lifted");
    return question.model;
  };
  const rowsOf = (name: string) => raw(name).replace(/\n$/, "").split("\n");
  /** The plain page with one row replaced, found by its text, so a mutation names what it breaks. */
  const without = (find: string, to: string | null) =>
    rowsOf(PLAIN).flatMap((row) => (row.includes(find) ? (to === null ? [] : [row.replace(find, to)]) : [row]));
  const read = (rows: string[]) => detectPiQuestion(linesOf(rows.join("\n")));

  it("lifts the checkbox page: the choices with their descriptions, the input row left out, the advance row named", () => {
    const model = multi(load("pi--v160-rpiv-multi--w200.txt"));
    expect(model.phase).toBe("checkbox");
    if (model.phase !== "checkbox") return;
    expect(model.question).toBe("Which toppings do you want?");
    expect(model.options).toEqual([
      { n: 1, label: "Cheese", description: "melted cheese", checked: false },
      { n: 2, label: "Ham", description: "smoked ham", checked: false },
      { n: 3, label: "Olives", description: "green olives", checked: false },
    ]);
    expect(model.toggle).toBe("digit");
    expect(model.advanceLabel).toBe("Submit");
    expect(model.pointer).toBe("option");
    // rpiv's Escape cancels the whole dialog and a card key is a digit, so there is no escape row. The input row is
    // the card's answer field: its digit opens the editor, and its Enter commits the whole answer.
    expect(model.escape).toBeNull();
    expect(model.field).toEqual({
      n: 4,
      focused: false,
      text: "",
      checked: false,
      pointer: "above",
      lines: 1,
      digitOpens: true,
      commitsOnEnter: true,
    });
  });

  it("reads the ticks, and a plain read of the same dialog reads the same", () => {
    const ticked = multi(load("pi--v160-rpiv-multi-checked--w200.txt"));
    if (ticked.phase !== "checkbox") throw new Error("not a checkbox page");
    expect(ticked.options.map((o) => o.checked)).toEqual([true, false, true]);
    const plain = multi(load(PLAIN));
    if (plain.phase !== "checkbox") throw new Error("not a checkbox page");
    expect(plain.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Olives"]);
  });

  it("advances by the keys that wrap past the first row, so the pointer never crosses the input row", () => {
    const keys = (name: string) => {
      const model = multi(load(name));
      return model.phase === "checkbox" ? model.advanceKeys : undefined;
    };
    expect(keys("pi--v160-rpiv-multi--w200.txt")).toEqual(["Up", "Enter"]);
    expect(keys("pi--v160-rpiv-multi-third--w200.txt")).toEqual(["Up", "Up", "Up", "Enter"]);
    expect(keys("pi--v160-rpiv-multi-typed--w200.txt")).toEqual(["Up", "Up", "Up", "Enter"]);
    expect(keys("pi--v160-rpiv-multi-submit-row--w200.txt")).toEqual(["Enter"]);
  });

  it("names the advance row as the screen printed it: Next on a page of a questionnaire", () => {
    const model = multi(load("pi--v160-rpiv-tabs-multi--w200.txt"));
    expect(model.phase === "checkbox" && model.advanceLabel).toBe("Next");
    expect(model.phase === "checkbox" && model.question).toBe("Which toppings do you want?");
  });

  it("never takes the typed row for a choice", () => {
    const model = multi(load("pi--v160-rpiv-multi-typed--w200.txt"));
    expect(model.phase === "checkbox" && model.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Olives"]);
  });

  it("keeps one identity while boxes flip and the pointer moves, and breaks it on a different page", () => {
    const sig = (name: string) => multi(load(name)).signature;
    const region = (name: string) => multi(load(name)).regionSignature;
    const first = sig("pi--v160-rpiv-multi--w200.txt");
    expect(sig("pi--v160-rpiv-multi-checked--w200.txt")).toBe(first);
    expect(sig("pi--v160-rpiv-multi-third--w200.txt")).toBe(first);
    expect(sig("pi--v160-rpiv-multi-submit-row--w200.txt")).toBe(first);
    // The literal text a write binds to does change with a tick: a stale tap is refused.
    expect(region("pi--v160-rpiv-multi-checked--w200.txt")).not.toBe(region("pi--v160-rpiv-multi--w200.txt"));
    // The questionnaire's chip turns from □ to ■ when its page gets a tick: still the same page.
    expect(sig("pi--v160-rpiv-tabs-multi-checked--w200.txt")).toBe(sig("pi--v160-rpiv-tabs-multi--w200.txt"));
    expect(sig("pi--v160-rpiv-tabs-multi--w200.txt")).not.toBe(first);
    // Typed words, the box they tick and the keyboard they hold are the field's state, not the page's identity.
    expect(sig("pi--v160-rpiv-multi-typed--w200.txt")).toBe(first);
    const empty = sig("pi--v160-rpiv-multi-free-focused-empty--w200.txt");
    expect(sig("pi--v160-rpiv-multi-free-focused-typed--w200.txt")).toBe(empty);
    expect(sig("pi--v160-rpiv-multi-free-left-typed--w200.txt")).toBe(empty);
  });

  it("makes models that differ only by a tick unequal, and equal on a re-read", () => {
    const a = multi(load("pi--v160-rpiv-multi--w200.txt"));
    const again = multi(load("pi--v160-rpiv-multi--w200.txt"));
    const ticked = multi(load("pi--v160-rpiv-multi-checked--w200.txt"));
    expect(multiSelectEquals(a, again)).toBe(true);
    expect(multiSelectEquals(a, ticked)).toBe(false);
    expect(multiSelectIdentity(a, ticked)).toBe(false);
  });

  it("lifts through the adapter as a multi-select block", () => {
    const blocks = piAdapter.buildBlocks(load("pi--v160-rpiv-multi--w200.txt"));
    expect(blocks.some((b) => b.kind === "multi-select")).toBe(true);
  });

  it("reads the input row with the keyboard as the focused field, with no advance plan from there", () => {
    const empty = multi(load("pi--v160-rpiv-multi-free-focused-empty--w200.txt"));
    const typed = multi(load("pi--v160-rpiv-multi-free-focused-typed--w200.txt"));
    for (const model of [empty, typed]) {
      expect(model.phase === "checkbox" && model.pointer).toBe("field");
      expect(model.phase === "checkbox" && model.advanceKeys).toBeUndefined();
    }
    expect(empty.phase === "checkbox" && empty.field).toMatchObject({ n: 4, focused: true, text: "", checked: false, pointer: "on" });
    expect(typed.phase === "checkbox" && typed.field).toMatchObject({ n: 4, focused: true, text: "extra anchovies", checked: true, pointer: "on" });
  });

  it("reads the draft the pointer left: its words and its tick, the pointer on an option", () => {
    const left = multi(load("pi--v160-rpiv-multi-free-left-typed--w200.txt"));
    expect(left.phase === "checkbox" && left.field).toMatchObject({ focused: false, text: "extra anchovies", checked: true, pointer: "above" });
    expect(left.phase === "checkbox" && left.pointer).toBe("option");
    // The draft's tick is the field's: the three choices stay unticked.
    expect(left.phase === "checkbox" && left.options.map((o) => o.checked)).toEqual([false, false, false]);
  });

  it("stays raw when the pointer stands on the input row without the editor open", () => {
    const onInput = without("❯ 1. [ ] Cheese", "  1. [ ] Cheese").map((row) => row.replace("  4. [ ] Type something.", "❯ 4. [ ] Type something."));
    expect(read(onInput)).toBeNull();
  });

  it("declines a page whose footer does not say the boxes toggle, or that has no advance row", () => {
    expect(read(without("Space to toggle · ", ""))).toBeNull();
    expect(read(without("  Submit", null))).toBeNull();
    // Without the pointer anywhere the page cannot say where an advance would start.
    expect(read(without("❯ 1. [ ] Cheese", "  1. [ ] Cheese"))).toBeNull();
  });

  it("declines rows it does not know: a stray row between the choices, a gap in the numbers, too many choices", () => {
    expect(read(without("  smoked", "     a stray row"))).toBeNull();
    expect(read(without("  2. [ ] Ham", "  3. [ ] Ham"))).toBeNull();
    const many = rowsOf(PLAIN);
    const at = many.findIndex((r) => r.includes("Type something."));
    const extra = Array.from({ length: 8 }, (_, i) => `  ${i + 4}. [ ] Extra ${i + 1}`);
    many.splice(at, 0, ...extra);
    many[at + extra.length] = "  12. [ ] Type something.";
    expect(read(many)).toBeNull();
  });

  it("reads the typed words that wrapped under the input row, and keeps the choices' own rows apart from them", () => {
    const rows = rowsOf(PLAIN).map((row) => (row.includes("Type something.") ? "  4. [✔] a long answer that the dialog wrapped" : row));
    const at = rows.findIndex((r) => r.includes("a long answer"));
    rows.splice(at + 1, 0, "         onto a second row");
    const model = read(rows);
    expect(model?.kind).toBe("multi-select");
    // A wrapped row under a choice, not under the input, is a row the page does not have.
    const under = rowsOf(PLAIN);
    under.splice(under.findIndex((r) => r.includes("1. [ ] Cheese")) + 1, 0, "         wrapped under a choice");
    expect(read(under)).toBeNull();
  });
});

describe("rpiv-ask-user-question: the input row as an answer field (pi 1.5.2 plain, pi 1.6.0 styled reads)", () => {
  // TEST: pi--v160-rpiv-single-free-*.txt and pi--v160-rpiv-multi-free-*.txt are styled reads of a real dialog (2026-11-23); pi--v152-rpiv-free-*.txt are plain reads of an older one.
  const SINGLE = {
    focusedEmpty: "pi--v160-rpiv-single-free-focused-empty--w200.txt",
    focusedTyped: "pi--v160-rpiv-single-free-focused-typed--w200.txt",
    leftEmpty: "pi--v160-rpiv-single-free-left-empty--w200.txt",
    leftTyped: "pi--v160-rpiv-single-free-left-typed--w200.txt",
    wrapped: "pi--v160-rpiv-single-free-wrapped--w200.txt",
    wrappedWords: "pi--v160-rpiv-single-free-wrapped-words--w200.txt",
  };
  const feedback = (name: string) => prompt(load(name)).feedback;

  it("reads the input row in each state it has: focused or left, empty or with words", () => {
    expect(feedback(SINGLE.focusedEmpty)).toEqual({ key: "3", focused: true, text: "", purpose: "answer", pointer: "on" });
    expect(feedback(SINGLE.focusedTyped)).toEqual({ key: "3", focused: true, text: "purple", purpose: "answer", pointer: "on" });
    expect(feedback(SINGLE.leftEmpty)).toEqual({ key: "3", focused: false, text: "", purpose: "answer", pointer: "above" });
    expect(feedback(SINGLE.leftTyped)).toEqual({ key: "3", focused: false, text: "purple", purpose: "answer", pointer: "above" });
  });

  it("reads the plain captures of pi 1.5.2 too, and takes the typed row for no option", () => {
    expect(feedback("pi--v152-rpiv-free-focused--w200.txt")).toMatchObject({ focused: true, text: "" });
    expect(feedback("pi--v152-rpiv-free-typed--w200.txt")).toMatchObject({ focused: true, text: "purp" });
    for (const name of Object.values(SINGLE)) {
      expect(prompt(load(name)).options.map((o) => o.label).filter((l) => l !== "Cancel"), name).toEqual(["Red", "Green"]);
    }
  });

  it("keeps one identity through the keyboard, the typing and the pointer's walk", () => {
    const models = [SINGLE.focusedEmpty, SINGLE.focusedTyped, SINGLE.leftEmpty, SINGLE.leftTyped].map((n) => prompt(load(n)));
    for (const model of models) expect(promptsSameIdentity(model, models[0]!)).toBe(true);
    // The question is another one: the identity breaks.
    const other = rowsFor(SINGLE.leftEmpty).map((row) => row.replace("Which color do you like?", "Which size do you want?"));
    expect(promptsSameIdentity(prompt(linesOf(other.join("\n"))), models[0]!)).toBe(false);
  });

  it("joins a wrapped value: a space where a Latin word wrapped, none between two wide letters", () => {
    const alphabet = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
    expect(feedback(SINGLE.wrappedWords)?.text).toBe(`${alphabet} ${alphabet}`);
    const mixed = feedback(SINGLE.wrapped)?.text ?? "";
    expect(mixed.startsWith("I would like purple because it matches the sky at dusk")).toBe(true);
    // The Chinese letters came out as typed: no space was put between them where their row wrapped.
    expect(mixed.endsWith("更多的字更多的字更多的字更多的字更多的字更多的字更多的字")).toBe(true);
    expect(mixed).not.toMatch(/[\u4e00-\u9fff] [\u4e00-\u9fff]/u);
  });

  it("leaves the review page alone: its last row is an option, even with the pointer on it", () => {
    for (const name of ["pi--v152-rpiv-submit--w200.txt", "pi--v152-rpiv-submit-moved--w200.txt"]) {
      const model = prompt(load(name));
      expect(model.feedback, name).toBeUndefined();
      expect(model.options.map((o) => o.label).slice(0, 2), name).toEqual(["Submit answers", "Cancel"]);
    }
  });

  it("declines a row it cannot place: words under the input that are not its wrapped text", () => {
    const rows = rowsFor(SINGLE.leftTyped);
    const at = rows.findIndex((r) => r.includes("3. purple"));
    rows.splice(at + 1, 0, "   a stray row");
    expect(detectPiQuestion(linesOf(rows.join("\n")))).toBeNull();
  });

  it("declines an editor that is the notes box's, and a focused row whose footer has no editor hint", () => {
    expect(detectPiQuestion(load("pi--v152-rpiv-notes--w200.txt"))).toBeNull();
    const noHint = rowsFor(SINGLE.focusedTyped).map((row) => row.replace(/ · Shift\+Enter for newline · Ctrl\+U to clear/, ""));
    expect(detectPiQuestion(linesOf(noHint.join("\n")))).toBeNull();
  });

  it("reads the same input row in the localised placeholder, as empty", () => {
    for (const placeholder of ["Schreibe etwas.", "输入内容", "Escribe algo."]) {
      const rows = rowsFor(SINGLE.leftEmpty).map((row) => row.replace("Type something.", placeholder));
      expect(prompt(linesOf(rows.join("\n"))).feedback, placeholder).toMatchObject({ focused: false, text: "" });
    }
  });

  function rowsFor(name: string): string[] {
    return raw(name).replace(/\n$/, "").split("\n");
  }
});

describe("rpiv-ask-user-question: the footer under the bottom rule (pi 1.5.2 through herdr-core)", () => {
  // TEST: the fixtures pi--v152-rpiv-*--w200.txt are plain reads, so the rows carry no colour and the frame is found by its rules.
  const SINGLE = "pi--v152-rpiv-single--w200.txt";
  const rowsOf = (name: string) => raw(name).replace(/\n$/, "").split("\n");
  const labelsAndKeys = (model: PromptModel) => model.options.map((o) => [o.label, o.keys]);

  it("lifts a one-question dialog: the chip row is the caption, the pointer row sends Enter, the others walk down", () => {
    const model = prompt(load(SINGLE));
    expect(model.question).toBe("Which color do you like?");
    expect(model.caption).toBe("Color");
    expect(labelsAndKeys(model)).toEqual([
      ["Red", ["Enter"]],
      ["Green", ["Down", "Enter"]],
      ["Cancel", ["Escape"]],
    ]);
  });

  it("walks the pointer: with it on option 2, option 1 is one Up away", () => {
    const model = prompt(load("pi--v152-rpiv-single-moved--w200.txt"));
    expect(labelsAndKeys(model)).toEqual([
      ["Red", ["Up", "Enter"]],
      ["Green", ["Enter"]],
      ["Cancel", ["Escape"]],
    ]);
  });

  it("lifts both pages of a tabbed dialog, the tab strip standing where the chip row stood", () => {
    expect(prompt(load("pi--v152-rpiv-tabs-first--w200.txt")).question).toBe("Which color do you like?");
    const second = prompt(load("pi--v152-rpiv-tabs-second--w200.txt"));
    expect(second.question).toBe("Which size do you want?");
    expect(labelsAndKeys(second).map(([label]) => label)).toEqual(["Small", "Large", "Cancel"]);
  });

  it("lifts the review page as a select of Submit answers and Cancel, with no bottom rule to find", () => {
    const model = prompt(load("pi--v152-rpiv-submit--w200.txt"));
    expect(model.question).toBe("Ready to submit your answers?");
    expect(labelsAndKeys(model)[0]).toEqual(["Submit answers", ["Enter"]]);
    expect(labelsAndKeys(model)[1]).toEqual(["Cancel", ["Down", "Enter"]]);
  });

  it("gives a screen the same identity on two reads, and a different one on the next page", () => {
    const first = liftDialog(piAdapter.buildBlocks(load("pi--v152-rpiv-tabs-first--w200.txt")));
    const again = liftDialog(piAdapter.buildBlocks(load("pi--v152-rpiv-tabs-first--w200.txt")));
    const next = liftDialog(piAdapter.buildBlocks(load("pi--v152-rpiv-tabs-second--w200.txt")));
    expect(first?.hash).toBeDefined();
    expect(again?.hash).toBe(first?.hash);
    expect(next?.hash).not.toBe(first?.hash);
  });

  it("reads as an ask on the Surface with the harness's own words for each option", () => {
    const read = readScreen(load(SINGLE), "pi", idleFor("pi"));
    expect(modalWord(read.surface.modal)).toBe("ask");
    expect(askOf(read.surface.modal)?.options.map((o) => o.label)).toEqual(["Red", "Green", "Cancel"]);
  });

  it("keeps the notes box raw: the editor that has the keyboard is not the input row's", () => {
    expect(detectPiQuestion(load("pi--v152-rpiv-notes--w200.txt"))).toBeNull();
  });

  it("declines a dialog whose footer does not name Escape, or that has prose between the options and the rule", () => {
    const rows = rowsOf(SINGLE);
    const footer = rows.findIndex((r) => r.includes("Enter to select"));
    const noEscape = [...rows];
    noEscape[footer] = " Enter to select · ↑/↓ to navigate · n to add notes · Ctrl+] to collapse";
    expect(detectPiQuestion(linesOf(noEscape.join("\n")))).toBeNull();
    const rule = rows.findIndex((r, at) => at > 0 && r.startsWith("─") && at < footer);
    const prose = [...rows.slice(0, rule), "an extra row of prose here", ...rows.slice(rule)];
    expect(detectPiQuestion(linesOf(prose.join("\n")))).toBeNull();
  });

  it("declines the same rows once the status rows under the footer are gone", () => {
    const rows = rowsOf(SINGLE);
    const footer = rows.findIndex((r) => r.includes("Enter to select"));
    expect(detectPiQuestion(linesOf(rows.slice(0, footer + 1).join("\n")))).toBeNull();
  });

  it("stays raw when the dialog is quoted in the agent's prose above pi's own editor", () => {
    // The dialog's rows stop before its footer, as when an agent quotes them, and pi's real editor follows.
    const footer = rowsOf(SINGLE).findIndex((r) => r.includes("Enter to select"));
    const quoted = [...linesOf(rowsOf(SINGLE).slice(0, footer).join("\n")), ...load("pi--v110-idle.txt")];
    expect(detectPiQuestion(quoted)).toBeNull();
    expect(piAdapter.composerReady?.(quoted)).toBe(true);
  });
});
