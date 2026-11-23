// rpiv-ask-user-question's TEXT INPUT row (rpiv 2.15.0, `view/components/wrapping-select.ts`): the extension's
// own `Type something.` row, the last numbered row of every page, read as an answer field the phone may type into.
//
//   single page                         checkbox page
//   ❯ 3. purple▮                        ❯ 4. [✔] extra anchovies▮    focused: the pointer is on it, a cursor cell
//        more words                          more words                (a no-break space) ends the text; the
//                                                                      screen's text has lost it with the row's
//                                                                      trailing blanks, an empty row is `❯ 3.`
//     3. purple                           4. [✔] extra anchovies      unfocused: the draft stays, no cursor
//     3. Type something.                  4. [ ] Type something.      empty: the placeholder (localised)
//
// Facts measured on pi 1.6.0 with rpiv 2.15.0 (fixtures pi--v160-rpiv-*-free-*):
//   - the row has the keyboard exactly while the pointer is on it, and the footer then adds
//     `Shift+Enter for newline · Ctrl+U to clear` (and drops `n to add notes`);
//   - the text wraps onto rows hung under the label (five columns on a single page, nine on a checkbox page);
//     a wrap at a space drops the space, a wrap inside a run of Chinese, Japanese or Korean letters has none;
//   - the draft stays visible after the pointer leaves, which is why an unfocused row cannot be told from an
//     option by its words: it is the page's LAST numbered row, which is always the input.
//
// This file only reads rows. What may be sent to them is decided by the recipes (lib/answer-field.ts).
// TEST:ask.test.ts[rpiv typed answer]

/** The cursor cell pi-tui draws at the end of a focused editor row. A row's text is trimmed at the end, which
 *  takes it (a no-break space counts as a blank), so it is only dropped here when a caller kept it. */
const CURSOR = "\u00a0";

/** The placeholder of the input row in every language rpiv 2.15.0 ships (`locales/*.json`, `sentinel.other`). */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "Type something.",
  "Schreibe etwas.",
  "Escribe algo.",
  "Écrivez quelque chose.",
  "Digite algo.",
  "Escreva algo.",
  "Введите что-нибудь.",
  "Введіть щось.",
  "输入内容",
]);

/** What a footer says only while an editor has the keyboard, or only while none has. */
const EDITOR_HINTS = / · (?:Shift\+Enter for newline|Ctrl\+U to clear|n to add notes)/g;

/** A letter that wraps anywhere: a line may break between two of them with no space between. */
const WIDE_LETTER = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

/** The input row as the screen shows it. */
export interface RpivInput {
  /** The page's own number for the row (its digit). */
  n: number;
  /** The row's first line. */
  row: number;
  /** The rows its text wrapped onto. */
  wrapped: number[];
  /** The pointer is on it: the editor has the keyboard. */
  focused: boolean;
  /** The words in it, `""` for the placeholder or an empty editor. */
  text: string;
  /** The checkbox page's box: ticked once the row holds words. Null on a single page. */
  checked: boolean | null;
}

/**
 * Whether every numbered row in `[from, to)` has a description under it (rpiv's options always do).
 *
 * @param texts the screen's rows as text
 * @param from the first numbered row of the page
 * @param to the input row, exclusive
 * @returns true when each numbered row is followed by a row hung at the description's indent
 */
function allDescribed(texts: string[], from: number, to: number): boolean {
  let seen = 0;
  for (let r = from; r < to; r++) {
    if (!/^(❯| ) [1-9]\. \S/u.test(texts[r]!)) continue;
    seen += 1;
    if (!/^ {5}\S/.test(texts[r + 1] ?? "")) return false;
  }
  return seen > 0;
}

/**
 * Join the rows of a wrapped value. A wrap at a space leaves no space on either side, so one is put back; a
 * wrap between two wide letters had none to begin with. A word cut inside a run of narrow letters comes out
 * with a space it never had: the text then differs from what was typed and the recipes refuse, which is safe.
 *
 * @param parts the row texts, first row first, with no cursor cell
 * @returns the value as typed
 */
export function joinWrapped(parts: string[]): string {
  let out = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    const wide = WIDE_LETTER.test(out.slice(-1)) && WIDE_LETTER.test(part.slice(0, 1));
    out += (wide ? "" : " ") + part;
  }
  return out;
}

/**
 * Read the input row of a page: the last numbered row of `[from, to)`, and the rows hung under it.
 *
 * @param texts the screen's rows as text
 * @param from the first numbered row of the page
 * @param to the first row after the body, exclusive (the advance row of a checkbox page is not in it)
 * @param boxed true on a checkbox page, whose numbered rows carry `[ ]` or `[✔]` after the number
 * @returns the row, or null when the rows after the last numbered one are anything but its wrapped text
 */
export function readRpivInput(texts: string[], from: number, to: number, boxed: boolean): RpivInput | null {
  // The label is optional: an empty focused row is `❯ 3.` once its blanks are trimmed.
  const numbered = boxed ? /^(❯| ) ([1-9])\. \[([ ✔])\](?: (.*))?$/u : /^(❯| ) ([1-9])\.(?: (.*))?$/u;
  const hung = boxed ? /^ {9}(\S.*)$/ : /^ {5}(\S.*)$/;
  let first = -1;
  for (let r = from; r < to; r++) if (numbered.test(texts[r]!)) first = r;
  if (first < 0) return null;
  const match = numbered.exec(texts[first]!)!;
  const pointed = match[1] === "❯";
  const wrapped: number[] = [];
  const parts: string[] = [(boxed ? match[4] : match[3]) ?? ""];
  for (let r = first + 1; r < to; r++) {
    const row = texts[r]!;
    if (row === "") continue;
    const more = hung.exec(row);
    // A blank row, then more words, would be a second paragraph: the editor never draws one.
    if (more === null || texts[r - 1] === "") return null;
    wrapped.push(r);
    parts.push(more[1]!);
  }
  // The cursor cell ends the last row of a focused editor and is no part of the words.
  const last = parts.length - 1;
  if (parts[last]!.endsWith(CURSOR)) parts[last] = parts[last]!.slice(0, -1);
  if (parts.some((p) => p.includes(CURSOR))) return null;
  const placeholder = !pointed && parts.length === 1 && PLACEHOLDERS.has(parts[0]!);
  // Words in that row look like any last option, pointed or not. Only a page whose options all carry the
  // description rpiv requires of them (its schema) has an input there; the review page (`Submit answers`,
  // `Cancel`) has none, and its last row is an option, not words.
  if (!boxed && !placeholder && !allDescribed(texts, from, first)) return null;
  return {
    n: Number(match[2]),
    row: first,
    wrapped,
    focused: pointed,
    text: placeholder ? "" : joinWrapped(parts),
    checked: boxed ? match[3] === "✔" : null,
  };
}

/**
 * The footer as an identity: its rows joined, without the hints that come and go with the keyboard. The
 * editor takes the keyboard and gives it back in the middle of an answer, and the dialog must stay the same
 * dialog across that, so the words that change with it are taken out.
 *
 * @param texts the screen's rows as text
 * @param from the footer's first row
 * @param to the footer's last row, inclusive
 * @returns one row of text
 */
export function footerIdentity(texts: string[], from: number, to: number): string {
  return texts
    .slice(from, to + 1)
    .map((t) => t.trim())
    .join(" ")
    .replace(EDITOR_HINTS, "");
}
