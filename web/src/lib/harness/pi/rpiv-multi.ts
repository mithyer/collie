// rpiv-ask-user-question's CHECKBOX page (rpiv 2.15.0, `view/components/multi-select-view.ts`), read as one
// multi-select question. The page is a list of numbered rows with a box after the number, one more
// numbered row that is the extension's own text input, and an unnumbered row that moves on:
//
//   ❯ 1. [ ] Cheese            a choice: its digit toggles the box and never moves the pointer
//     melted                   its description, two columns in
//     2. [✔] Ham
//     3. [ ] Type something.   the text input: ALWAYS the last numbered row. It shows the typed words in
//                              place of the label (wrapped rows hang nine columns in) and its box ticks
//                              once it holds words. Its digit, or the pointer standing on it, gives it the
//                              keyboard (the footer then adds `Shift+Enter for newline`, which this reader
//                              never lifts, so the card never shows while it is open).
//       Submit                 the advance row (`Next` on every question but the last): Enter on it commits
//
// What the card may do, and why each key is safe:
//   - a digit TOGGLES its row, whatever row the pointer is on (the router's `digitRow`). Never the input's
//     digit: it is not an option here.
//   - advancing is ONE plan, `Up` as many times as it takes to wrap from the pointed row to the last row
//     (the advance row), then `Enter`. The list wraps (`prevNavOnUp`), so the pointer never crosses the
//     input row on its way, and Enter on an option would only toggle it; the plan therefore ends on the
//     advance row or does nothing harmful. A pointer already on the advance row needs `Enter` alone.
//
// Read from text alone: plain and painted reads lift alike. Fail closed: any row this grammar does not
// know declines the whole page, and the screen stays raw with the Escape card.
// TEST:ask.test.ts[rpiv multi-select]
import type { MultiSelectModel, MultiSelectOption } from "../multi-select-model";

/** The pointer rpiv draws on its focused row, then one space. Every row of the list reserves these two columns. */
const POINTER_GLYPH = "❯";
/** A numbered row: pointer or space, the number, `. `, the box, then the label. The box is `[ ]` or `[✔]`. */
const NUMBERED = /^(❯| ) ([1-9])\. \[([ ✔])\] (\S.*)$/u;
/** The advance row: pointer or space, then its label (no number). */
const ADVANCE = /^(❯| ) (\S.*)$/u;
/** A description row of a choice: two spaces (rpiv's continuation indent), then words. */
const DESCRIPTION = /^ {2}(\S.*)$/;
/** A row the text input wrapped onto: as wide as the `❯ 3. [ ] ` prefix (nine columns), then words. */
const WRAPPED = /^ {9}\S/;
/** How many choices fit: the input takes the next digit, and a tenth row would widen the number column. */
const MAX_CHOICES = 8;

/** What {@link readRpivMulti} found: the rows' places and the facts the model is made of. */
export interface RpivMulti {
  /** The choices, in order, with the row each one stands on. */
  options: (MultiSelectOption & { row: number; pointed: boolean })[];
  /** The first row of the text input (its wrapped rows follow it). */
  otherRow: number;
  /** The row of the advance control. */
  advanceRow: number;
  /** The advance row's own label (`Submit`, `Next`, or the translation the screen printed). */
  advanceLabel: string;
  /** The pointer stands on the advance row, rather than on a choice. */
  advancePointed: boolean;
}

/**
 * Read the rows of rpiv's checkbox page, from its first numbered row to the end of the dialog's body.
 *
 * @param texts the screen's rows as text
 * @param first the index of the first numbered row (`❯ 1. [ ] …`)
 * @param bodyEnd the first row after the body (the bottom rule or the footer), exclusive
 * @returns the page, or null when the rows are not exactly this grammar (also when the text input holds
 *   the pointer: the card never lifts while it has, or can take, the keyboard)
 */
export function readRpivMulti(texts: string[], first: number, bodyEnd: number): RpivMulti | null {
  let end = bodyEnd - 1;
  while (end > first && texts[end] === "") end--;
  if (end <= first) return null;
  // The advance row is the last row of the body; a numbered row there is a page with no advance row.
  const advance = ADVANCE.exec(texts[end]!);
  if (advance === null || /^\d+\. /.test(advance[2]!)) return null;
  const rows: { n: number; label: string; checked: boolean; pointed: boolean; row: number; notes: string[]; wrapped: number }[] = [];
  for (let at = first; at < end; at++) {
    const t = texts[at]!;
    const numbered = NUMBERED.exec(t);
    if (numbered !== null) {
      if (Number(numbered[2]) !== rows.length + 1) return null;
      rows.push({ n: rows.length + 1, label: numbered[4]!, checked: numbered[3] === "✔", pointed: numbered[1] === POINTER_GLYPH, row: at, notes: [], wrapped: 0 });
      continue;
    }
    const owner = rows.at(-1);
    if (owner === undefined) return null;
    const description = DESCRIPTION.exec(t);
    if (description !== null) {
      owner.notes.push(description[1]!);
      continue;
    }
    if (WRAPPED.test(t)) {
      owner.wrapped++;
      continue;
    }
    return null;
  }
  // At least one choice and the input row after it.
  if (rows.length < 2 || rows.length - 1 > MAX_CHOICES) return null;
  const other = rows.at(-1)!;
  const choices = rows.slice(0, -1);
  // A description belongs to a choice, a wrapped row to the input and to nothing else.
  if (other.notes.length > 0 || choices.some((r) => r.wrapped > 0)) return null;
  const advancePointed = advance[1] === POINTER_GLYPH;
  const pointers = rows.filter((r) => r.pointed).length + (advancePointed ? 1 : 0);
  if (pointers !== 1 || other.pointed) return null;
  return {
    options: choices.map((r) => {
      const option: MultiSelectOption & { row: number; pointed: boolean } = { n: r.n, label: r.label, checked: r.checked, row: r.row, pointed: r.pointed };
      if (r.notes.length > 0) option.description = r.notes.join(" ");
      return option;
    }),
    otherRow: other.row,
    advanceRow: end,
    advanceLabel: advance[2]!,
    advancePointed,
  };
}

/**
 * The keys that advance this page from where the pointer stands: `Enter` alone on the advance row, and
 * from choice `i` (0-based) `Up` `i + 1` times, which wraps past the first row onto the advance row (the
 * input row is never crossed), then `Enter`.
 *
 * @param page the page as read
 * @returns the key names, in order, for one guarded write
 */
export function rpivAdvanceKeys(page: RpivMulti): string[] {
  if (page.advancePointed) return ["Enter"];
  const at = page.options.findIndex((o) => o.pointed);
  return [...Array.from({ length: at + 1 }, () => "Up"), "Enter"];
}

/**
 * The page's identity text, from `from` to `to` of the screen, with what a tap changes taken out: the
 * pointer glyph on every list row, the box of every numbered row (the input's too) and, in a questionnaire,
 * the answered mark of every chip on the tab strip (a ticked page turns its chip from `□` to `■`). It is what
 * the guard compares while a toggle flips boxes, so it holds the labels, the descriptions and the footer only.
 *
 * @param texts the screen's rows as text
 * @param from the first row of the region (the top rule)
 * @param to the last row of the region, inclusive
 * @param page the page as read
 * @param stripRow the row of the tab strip, null when the dialog has one question only
 * @returns the region with the pointer, the boxes and the answered marks replaced by their blank forms
 */
export function rpivMultiSignature(texts: string[], from: number, to: number, page: RpivMulti, stripRow: number | null = null): string {
  const listRows = new Set<number>([page.advanceRow, page.otherRow, ...page.options.map((o) => o.row)]);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const t = texts[i]!;
    if (listRows.has(i)) out.push(t.replace(/^❯/u, " ").replace(/^( {2}[1-9]\. )\[[ ✔]\]/u, "$1[ ]"));
    else if (i === stripRow) out.push(t.replace(/[■▣]/gu, (m) => (m === "■" ? "□" : "▢")));
    else out.push(t);
  }
  return out.join("\n");
}

/**
 * The model of a read page: toggles by digit, advances by the plan of {@link rpivAdvanceKeys}.
 *
 * @param page the page as read
 * @param question the question's words (the header rows)
 * @param signature the identity text from {@link rpivMultiSignature}
 * @param regionSignature the literal region text a write binds to
 * @returns the checkbox model
 */
export function rpivMultiModel(page: RpivMulti, question: string, signature: string, regionSignature: string): MultiSelectModel {
  return {
    phase: "checkbox",
    question,
    options: page.options.map(({ n, label, description, checked }) => (description === undefined ? { n, label, checked } : { n, label, description, checked })),
    // rpiv's Escape cancels the whole dialog, which a digit cannot send: the card has no "chat about this".
    escape: null,
    pointer: page.advancePointed ? "advance" : "option",
    // Digit mode never reads the numbered row the pointer stands on.
    pointerRow: null,
    // The card shows the page the dialog is on; moving between the questions stays with the terminal.
    steps: null,
    advanceLabel: page.advanceLabel,
    advanceKeys: rpivAdvanceKeys(page),
    toggle: "digit",
    signature,
    regionSignature,
  };
}
