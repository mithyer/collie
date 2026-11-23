// A bounded extraction of hc's first-paint snapshot (0.1.15, HC_API.md), NOT a VT emulator.
// The core already rendered the cells. Its formatter writes them in row order between home and
// cursor restoration. Accept only that measured form; never interpret movement or live output.
import { parseAnsi } from "../../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../../web/src/lib/blocks.ts";
import { cellsByColumn, displayWidth } from "../../../web/src/lib/text-width.ts";
import { stripSgr } from "../../../web/src/lib/surface/plain.ts";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
// hc 0.1.22 starts its first paint with CAN (0x18) before the soft reset. CAN only cancels a
// half-received escape sequence in the viewer's parser; it draws nothing and moves nothing.
const CAN = String.fromCodePoint(0x18);
// Measured input/reporting and screen-selection modes only. Unknown modes can change the
// meaning of the grid (for example origin or screen reverse); never silently discard those.
const PREFIX_MODE = "(?:1|7|9|25|47|66|100[0-6]|101[56]|104[79]|2004|2026|2031|2048)";
const PREFIX_CONTROL = new RegExp(`${ESC}\\[(?:!p|\\?${PREFIX_MODE}[hl]|=[0-9;]+u|[0-9]*[GgHJ])|${ESC}H|${CAN}`, "g");
const CURSOR = new RegExp(`${ESC}\\[(\\d+);(\\d+)H`);
const METADATA = new RegExp(`${ESC}\\[=[0-9;]+u|${ESC}\\[\\?9001[hl]|${ESC}\\](?:2|7501);[^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
const WIN32_MODE = new RegExp(`${ESC}\\[\\?9001[hl]`);
const STATUS = new RegExp(`${ESC}\\]7501;[^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, "y");

export interface SnapshotSize {
  readonly cols: number;
  readonly rows: number;
  /** Root status plus named records: first_paint appends exactly this many OSC 7501 reports. */
  readonly reports: number;
}

/** The core appends win32 mode and every status record after the formatter's paint. Its outbox
 * can split that paint or coalesce later live output into the same DATA frame. This boundary is
 * independent of DATA frames; bytes after it are not interpreted. Latin-1 input gives byte offsets.
 */
export function firstPaintEnd(paint: string, reports: number): number | null {
  if (!Number.isInteger(reports) || reports < 0) return null;
  const mode = WIN32_MODE.exec(paint);
  if (mode === null) return null;
  let end = mode.index + mode[0].length;
  for (let i = 0; i < reports; i++) {
    STATUS.lastIndex = end;
    if (STATUS.exec(paint) === null) return null;
    end = STATUS.lastIndex;
  }
  return end;
}

// Accept only SGR whose semantics the shared parser represents exactly. In particular, flattening
// colon subparameters can invent attributes (4:3 is not italic), and incomplete colours are unproved.
function provedSgr(text: string): boolean {
  const sgr = new RegExp(`${ESC}\\[([0-9;:]*)m`, "g");
  for (const match of text.matchAll(sgr)) {
    const params = match[1]!;
    if (params.includes(":") || (params !== "" && params.split(";").some((part) => part === ""))) return false;
    const codes = params === "" ? [0] : params.split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 38 || code === 48) {
        const count = codes[i + 1] === 2 ? 3 : codes[i + 1] === 5 ? 1 : 0;
        const colour = codes.slice(i + 2, i + 2 + count);
        if (count === 0 || colour.length !== count || colour.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
        i += count + 1;
      } else if (![0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 39, 49].includes(code) &&
                 !(code >= 30 && code <= 37) && !(code >= 40 && code <= 47) &&
                 !(code >= 90 && code <= 97) && !(code >= 100 && code <= 107)) return false;
    }
  }
  return true;
}

function containsControl(text: string, allowNewline = false): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code < 0x20 && !(allowNewline && code === 0x0a)) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** The rows up to the last one that holds anything; rows are already right-trimmed of ASCII spaces. */
function withoutBlankTail(rows: readonly string[]): readonly string[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1] === "") end -= 1;
  return rows.slice(0, end);
}

/** Rendered text + SGR only, or null when the snapshot cannot prove the plain read's whole grid.
 * The separate reads are not atomic: mismatched text or dimensions must not produce styled facts.
 */
export function styledSnapshot(
  paint: string,
  screen: { readonly text: string; readonly complete: boolean },
  size: SnapshotSize,
): string | null {
  if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols <= 0 || size.rows <= 0) return null;
  const paintEnd = firstPaintEnd(paint, size.reports);
  if (paintEnd === null) return null;
  paint = paint.slice(0, paintEnd);
  const clear = paint.indexOf("\x1b[2J");
  const home = clear < 0 ? -1 : paint.indexOf("\x1b[H", clear + 4);
  if (home < 0) return null;
  // Only the reset/mode/tab-stop setup seen before the formatter's home. Unknown setup declines.
  const prefix = paint.slice(0, home).replace(PREFIX_CONTROL, "");
  if (prefix !== "") return null;
  const body = paint.slice(home + 3);
  const cursor = CURSOR.exec(body);
  if (cursor === null || !screen.complete) return null;
  const grid = body.slice(0, cursor.index).replace(/\r\n/g, "\n");
  // Every escape that crosses MuxGrid must be SGR. A cursor command hidden by parseAnsi is not safe.
  if (!provedSgr(grid) || containsControl(stripSgr(grid), true)) return null;
  const rows = splitLines(parseAnsi(grid));
  const textRows = rows.map(lineText);
  const plainRows = screen.text.split("\n").map((row) => row.replace(/ +$/u, ""));
  // hc 0.1.15 kept every blank row below the content in both reads (rows === size.rows); hc 0.1.22
  // drops them from both. Compare the rows up to the last non-blank one, so either form proves the
  // whole grid, and still refuse a read that is taller than the terminal.
  const textTrimmed = withoutBlankTail(textRows.map((row) => row.replace(/ +$/u, "")));
  const plainTrimmed = withoutBlankTail(plainRows);
  if (textRows.length > size.rows || plainRows.length > size.rows || textTrimmed.length !== plainTrimmed.length ||
      textTrimmed.some((row, i) => row !== plainTrimmed[i]) || textRows.some((row) => displayWidth(row) > size.cols)) return null;
  const y = Number(cursor[1]), x = Number(cursor[2]);
  if (y < 1 || y > size.rows || x < 1 || x > size.cols) return null;
  const tail = body.slice(cursor.index + cursor[0].length).replace(METADATA, "");
  const repeated = stripSgr(tail);
  if (!provedSgr(tail) || containsControl(repeated)) return null;
  if (repeated !== "") {
    // Pending wrap is restored by reprinting the SAME last-column grapheme and style. Ignoring
    // that restoration without checking it duplicates a cell, or conceals a different write.
    const cells = cellsByColumn(textRows[y - 1]!);
    const cell = cells.get(x - 1);
    if (cell !== repeated || x - 1 + displayWidth(cell) !== size.cols) return null;
    let offset = 0;
    for (const [column, cluster] of cells) {
      if (column === x - 1) break;
      offset += cluster.length;
    }
    let end = 0;
    const original = rows[y - 1]!.segments.find((span) => { end += span.text.length; return end > offset; });
    const restored = parseAnsi(grid + tail).at(-1);
    const fields = ["fg", "bg", "bold", "dim", "italic", "underline", "strike", "inverse"] as const;
    if (original === undefined || restored === undefined ||
        fields.some((key) => (original[key] || undefined) !== (restored[key] || undefined))) return null;
  }
  return grid;
}

/** Home plus clear screen: how hc 0.1.22 opens the screen part of a first paint, and, when it has scrollback to
 * show, the history part before it as well. */
const CLEAR_SCREEN = `${ESC}[H${ESC}[2J`;

/** Whether a piece of a paint is blank: nothing but spaces once the SGR is gone. */
const blankPiece = (piece: string): boolean => /^ *$/u.test(stripSgr(piece));

/**
 * A styled read of what the plain read returned, for the screen alone or with the scrollback above it.
 *
 * A first paint made with `history: 0` is the screen part only, and {@link styledSnapshot} proves it. A paint made
 * with `history: N` (hc 0.1.22, measured 2026-11-23) holds a history part in front of that screen part:
 * `prologue, home+clear, the K history rows, home+clear, setup, home, screen grid, cursor, metadata`. The history
 * rows are separated by CR LF and followed by `size.rows` bare line feeds, which push them off the viewer's screen
 * into its scrollback (so `K = pieces - 1 - size.rows`). Dropping the history part and the second home+clear
 * leaves exactly the screen-only form, so the screen part goes through {@link styledSnapshot} unchanged and the
 * history rows go through the same SGR and text proof. Both parts are proved against the plain read, row by row,
 * and the result has the plain read's rows (K styled history rows, then the screen grid).
 *
 * Anything this does not recognise (no pair, a third pair, no history rows, a row that differs from the plain
 * read, an unproved escape) answers `null` and the caller keeps the plain text.
 *
 * TEST:snapshot.test.ts[a first paint with scrollback from hc 0.1.22]
 *
 * @param paint The first paint as decoded UTF-8 text; whatever follows its end marker is cut off here.
 * @param read The plain read of the same terminal (`terminal.read` with the same `lines`).
 * @param size The terminal's size and status report count, as the attach reply and `terminal.get` agree on them.
 * @returns The styled text with the plain read's rows, or `null` when it cannot be proved.
 */
export function styledRead(
  paint: string,
  read: { readonly text: string; readonly complete: boolean },
  size: SnapshotSize,
): string | null {
  const paintEnd = firstPaintEnd(paint, size.reports);
  if (paintEnd === null) return null;
  paint = paint.slice(0, paintEnd);
  const first = paint.indexOf(CLEAR_SCREEN);
  const second = first < 0 ? -1 : paint.indexOf(CLEAR_SCREEN, first + CLEAR_SCREEN.length);
  // No pair, or one: the screen part alone (this is also every paint made without history).
  if (second < 0) return styledSnapshot(paint, read, size);
  if (paint.indexOf(CLEAR_SCREEN, second + CLEAR_SCREEN.length) >= 0 || !read.complete) return null;
  if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols <= 0 || size.rows <= 0) return null;
  const history = paint.slice(first + CLEAR_SCREEN.length, second).replace(/\r\n/g, "\n");
  // The same rule as the screen grid: every escape that crosses MuxGrid is SGR, and nothing else draws.
  if (!provedSgr(history) || containsControl(stripSgr(history), true)) return null;
  const pieces = history.split("\n");
  const count = pieces.length - 1 - size.rows;
  if (count < 1 || !pieces.slice(count).every(blankPiece)) return null;
  const historyPaint = pieces.slice(0, count).join("\n");
  const historyRows = splitLines(parseAnsi(historyPaint)).map(lineText);
  const plainRows = read.text.split("\n").map((row) => row.replace(/ +$/u, ""));
  if (historyRows.length !== count || plainRows.length <= count ||
      historyRows.some((row, i) => row.replace(/ +$/u, "") !== plainRows[i] || displayWidth(row) > size.cols)) return null;
  // The screen part, as a screen-only paint, against the rest of the plain read.
  const screenPaint = paint.slice(0, first + CLEAR_SCREEN.length) + paint.slice(second + CLEAR_SCREEN.length);
  const screen = styledSnapshot(screenPaint, { text: plainRows.slice(count).join("\n"), complete: true }, size);
  if (screen === null) return null;
  // The reset keeps a style left open at the end of the history rows from leaking into the first screen row.
  const styled = `${historyPaint}${ESC}[0m\n${screen}`;
  const shown = withoutBlankTail(stripSgr(styled).split("\n").map((row) => row.replace(/ +$/u, "")));
  const proved = withoutBlankTail(plainRows);
  if (shown.length !== proved.length || shown.some((row, i) => row !== proved[i])) return null;
  return styled;
}
