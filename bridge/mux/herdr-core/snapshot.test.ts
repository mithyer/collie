import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnsi } from "../../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../../web/src/lib/blocks.ts";
import { stripSgr } from "../../../web/src/lib/surface/plain.ts";
import { styledRead, styledSnapshot } from "./snapshot.ts";

function capture(name = "preview") {
  const path = join(import.meta.dirname, "fixtures", `rpiv-${name}-v015`);
  return { paint: readFileSync(`${path}.paint.ansi`, "utf8"), screen: { text: readFileSync(`${path}.screen.txt`, "utf8"), complete: true } };
}
const size = { cols: 200, rows: 120, reports: 1 };
const visibleRows = (text: string) => splitLines(parseAnsi(text)).map((row) => lineText(row).trimEnd());

describe("a core observer snapshot as an already rendered SGR grid", () => {
  test.each(["preview", "answer"])("%s retains every rendered row and contains SGR, not terminal commands", (name) => {
    const { paint, screen } = capture(name);
    const grid = styledSnapshot(paint, screen, size);
    expect(grid).not.toBeNull();
    expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map((row) => row.trimEnd()));
    expect(grid).toContain("\x1b[");
    expect(stripSgr(grid!)).not.toContain("\x1b");
  });

  test("pending-wrap restoration neither adds a cell nor conceals a different cell or style", () => {
    const { paint, screen } = capture();
    const restore = "\x1b[120;200H\x1b[0m\x1b[38;2;134;134;134mf";
    expect(paint).toContain(restore); // The real first-paint form this regression covers.
    const grid = styledSnapshot(paint, screen, size)!;
    expect(visibleRows(grid).at(-1)).toEndWith("thinking off");
    expect(styledSnapshot(paint.replace(restore, restore.slice(0, -1) + "g"), screen, size)).toBeNull();
    expect(styledSnapshot(paint.replace(restore, "\x1b[120;200H\x1b[0m\x1b[31mf"), screen, size)).toBeNull();
  });

  test("a coalesced live bell does not discard a proved 59-column first paint", () => {
    const { paint, screen } = capture("startup-bell");
    expect(paint).toEndWith("\x07");
    const grid = styledSnapshot(paint, screen, { cols: 59, rows: 40, reports: 1 });
    expect(grid).not.toBeNull();
    expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map(row => row.trimEnd()));
    expect(grid).not.toContain("\x07");
  });

  test("a real coalesced cursor update retains the complete narrow editor and no live controls", () => {
    const { paint, screen } = capture("coalesced-cursor");
    const grid = styledSnapshot(paint, screen, { cols: 59, rows: 40, reports: 1 });
    expect(grid).not.toBeNull();
    expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map(row => row.trimEnd()));
    expect(stripSgr(grid!)).not.toContain("\x1b");
    const caret = parseAnsi(grid!).find((span) => span.inverse);
    expect(caret).toMatchObject({ text: "K", bold: true, inverse: true });
  });

  test("multiline text, leading spaces, emoji and reverse-video cell styling survive conversion", () => {
    const { paint, screen } = capture("answer");
    const grid = styledSnapshot(paint, screen, size)!;
    expect(splitLines(parseAnsi(grid)).map(lineText)).toContain("       Core second 😀\u00a0");
    const caret = parseAnsi(grid).find((span) => span.inverse);
    expect(caret).toMatchObject({ text: "\u00a0", bold: true, inverse: true, bg: "rgb(181,152,189)" });
  });

  // hc 0.1.22 differs from 0.1.15 in two measured ways: its first paint begins with CAN, and both the
  // paint and the plain read stop at the last non-blank row instead of keeping every blank row.
  describe("a first paint from hc 0.1.22", () => {
    const shell = () => {
      const path = join(import.meta.dirname, "fixtures", "shell-colors-v022");
      return { paint: readFileSync(`${path}.paint.ansi`, "utf8"), screen: { text: readFileSync(`${path}.screen.txt`, "utf8"), complete: true } };
    };
    const shellSize = { cols: 200, rows: 120, reports: 0 };

    test("keeps colour, bold, italic, underline and inverse although the screen is shorter than the terminal", () => {
      const { paint, screen } = shell();
      expect(paint.startsWith("\x18\x1b[!p")).toBe(true); // The real leading CAN this regression covers.
      expect(screen.text.split("\n").length).toBeLessThan(shellSize.rows);
      const grid = styledSnapshot(paint, screen, shellSize);
      expect(grid).not.toBeNull();
      expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map((row) => row.trimEnd()));
      expect(stripSgr(grid!)).not.toContain("\x1b");
      const spans = parseAnsi(grid!);
      expect(spans.find((span) => span.text === "red")).toMatchObject({ fg: "var(--ansi-1)" });
      expect(spans.find((span) => span.text === "bold green")).toMatchObject({ fg: "var(--ansi-2)", bold: true });
      expect(spans.find((span) => span.text === "orange")).toMatchObject({ fg: "rgb(255,135,0)" });
      expect(spans.find((span) => span.text === "truecolor")).toMatchObject({ fg: "rgb(255,220,0)", bg: "rgb(30,60,120)" });
      expect(spans.find((span) => span.text === "ital")).toMatchObject({ italic: true });
      expect(spans.find((span) => span.text === "under")).toMatchObject({ underline: true });
      expect(spans.find((span) => span.text === "inverse")).toMatchObject({ inverse: true });
    });

    test("still refuses a CAN anywhere but in the prologue, and a screen that differs from the paint", () => {
      const { paint, screen } = shell();
      expect(styledSnapshot(paint.replace("plain line", "plain \x18line"), screen, shellSize)).toBeNull();
      expect(styledSnapshot(paint, { ...screen, text: screen.text.replace("plain line", "other line") }, shellSize)).toBeNull();
      expect(styledSnapshot(paint, screen, { ...shellSize, rows: 2 })).toBeNull(); // The paint is taller than the terminal.
    });
  });

  test("unsupported SGR cannot manufacture style facts from subparameters or incomplete colours", () => {
    const { paint, screen } = capture();
    for (const sgr of ["4:3", "1;;31", "5", "38;2;255;0", "48;5;256"]) {
      expect(styledSnapshot(paint.replace("Sequential", `\x1b[${sgr}mSequential`), screen, size)).toBeNull();
    }
  });

  test("supported semicolon RGB and indexed colours keep their exact SGR", () => {
    for (const sgr of ["38;2;0;128;255;48;2;255;128;0", "38;5;0;48;5;255"]) {
      const grid = `\x1b[${sgr}mX`;
      const paint = `\x1b[2J\x1b[H${grid}\x1b[1;1H\x1b[?9001l`;
      expect(styledSnapshot(paint, { text: "X", complete: true }, { cols: 1, rows: 1, reports: 0 })).toBe(grid);
    }
  });

  test("Unicode whitespace disagreement is not ASCII formatter padding", () => {
    const { paint, screen } = capture("answer");
    expect(screen.text).toContain("Core second 😀\u00a0");
    const changed = screen.text.replace("Core second 😀\u00a0", "Core second 😀");
    expect(styledSnapshot(paint, { ...screen, text: changed }, size)).toBeNull();
  });

  test("pending-wrap restoration must preserve inverse state, not just resolved colours", () => {
    const paint = "\x1b[2J\x1b[H\x1b[31;44mX\x1b[1;1H\x1b[0;7;34;41mX\x1b[?9001l";
    expect(styledSnapshot(paint, { text: "X", complete: true }, { cols: 1, rows: 1, reports: 0 })).toBeNull();
  });

  test.each([
    ["movement inside the body", (paint: string) => paint.replace("Sequential", "\x1b[3DSequential")],
    ["bare carriage return", (paint: string) => paint.replace("Sequential", "\rSequential")],
    ["a bell inside the grid body", (paint: string) => paint.replace("Sequential", "\x07Sequential")],
    ["unknown prologue", (paint: string) => "unproved" + paint],
    ["unmeasured private mode", (paint: string) => paint.replace("\x1b[H", "\x1b[?9999h\x1b[H")],
    ["screen reverse mode", (paint: string) => paint.replace("\x1b[H", "\x1b[?5h\x1b[H")],
    ["origin mode", (paint: string) => paint.replace("\x1b[H", "\x1b[?6h\x1b[H")],
    ["missing cursor restoration", (paint: string) => paint.slice(0, paint.indexOf("\x1b[120;200H"))],
    ["truncated metadata", (paint: string) => paint.slice(0, -1)],
    ["live output before the metadata boundary", (paint: string) => paint.replace("\x1b[?9001l", "new output\x1b[?9001l")],
  ])("refuses %s rather than interpreting a terminal program", (_name, change) => {
    const { paint, screen } = capture();
    expect(styledSnapshot(change(paint), screen, size)).toBeNull();
  });

  test("drift, incomplete text and changed or invalid bounds cannot prove a styled read", () => {
    const { paint, screen } = capture("answer");
    expect(styledSnapshot(paint, { ...screen, text: screen.text.replace("Core first line", "Changed") }, size)).toBeNull();
    expect(styledSnapshot(paint, { ...screen, complete: false }, size)).toBeNull();
    for (const bounds of [{ cols: 200.5, rows: 120 }, { cols: 199, rows: 120 }, { cols: 200, rows: 119 }, { cols: 0, rows: 120 }]) {
      expect(styledSnapshot(paint, screen, { ...bounds, reports: 1 })).toBeNull();
    }
  });
});

// A paint made with `history: N` carries the scrollback in front of the screen part. The capture is a real hc 0.1.22
// first paint of a 200 x 120 terminal that held 127 lines (8 of them scrolled into history), asked with history 50.
describe("a first paint with scrollback from hc 0.1.22", () => {
  const capturePath = join(import.meta.dirname, "fixtures", "history-colors-v022");
  const paint = readFileSync(`${capturePath}.paint.ansi`, "utf8");
  const read = { text: readFileSync(`${capturePath}.read.txt`, "utf8"), complete: true };
  const historySize = { cols: 200, rows: 120, reports: 0 };
  const plainRows = read.text.split("\n").map((row) => row.trimEnd());
  const shownRows = (text: string) => stripSgr(text).split("\n").map((row) => row.trimEnd());

  test("the real capture has the two-part shape this proof depends on", () => {
    expect(paint.split("\x1b[H\x1b[2J")).toHaveLength(3); // The history part and the screen part.
    expect(plainRows).toHaveLength(127);
    expect(plainRows[0]).toBe("row 001 orange  slate");
  });

  test("styles the scrollback rows as well as the screen, with the plain read's rows", () => {
    const styled = styledRead(paint, read, historySize);
    expect(styled).not.toBeNull();
    expect(shownRows(styled!)).toEqual(plainRows);
    expect(stripSgr(styled!)).not.toContain("\x1b");
    const spans = parseAnsi(styled!);
    // `row 001` is in the history part, `row 013` in the screen part: both keep their colour.
    expect(spans.find((span) => span.text === "row 001")).toMatchObject({ fg: "rgb(255,135,0)" });
    expect(spans.find((span) => span.text === " slate ")).toMatchObject({ bg: "rgb(45,59,71)" });
    expect(spans.find((span) => span.text === "row 013")).toMatchObject({ fg: "rgb(255,135,0)" });
    expect(spans.find((span) => span.text === "inverse")).toMatchObject({ inverse: true });
    expect(spans.find((span) => span.text === "struck")).toMatchObject({ strike: true });
  });

  test("a paint without scrollback still goes through the screen proof alone", () => {
    const shellPath = join(import.meta.dirname, "fixtures", "shell-colors-v022");
    const shellPaint = readFileSync(`${shellPath}.paint.ansi`, "utf8");
    const shellScreen = { text: readFileSync(`${shellPath}.screen.txt`, "utf8"), complete: true };
    const shellSize = { cols: 200, rows: 120, reports: 0 };
    expect(styledRead(shellPaint, shellScreen, shellSize)).toBe(styledSnapshot(shellPaint, shellScreen, shellSize));
    expect(styledRead(shellPaint, shellScreen, shellSize)).not.toBeNull();
  });

  test("a style left open at the end of the scrollback does not colour the first screen row", () => {
    const leaky = paint.replace("inverse\x1b[0m\x1b[0m\r\n", "inverse\x1b[0m\x1b[41m\r\n");
    expect(leaky).not.toBe(paint);
    const styled = styledRead(leaky, read, historySize)!;
    expect(styled).not.toBeNull();
    const first = parseAnsi(styled).find((span) => span.text.startsWith("row 009"));
    expect(first?.bg).toBeUndefined();
  });

  test.each([
    ["a scrollback row that differs from the plain read", (text: string) => text.replace("row 003 plain text", "row 003 other text")],
    ["a screen row that differs from the plain read", (text: string) => text.replace("row 100 ", "row 100 changed ")],
    ["a plain read that has fewer rows than the paint", (text: string) => text.split("\n").slice(0, 9).join("\n")],
  ])("refuses %s (the pane scrolled between the two reads)", (_name, change) => {
    expect(styledRead(paint, { ...read, text: change(read.text) }, historySize)).toBeNull();
  });

  test.each([
    ["a cursor movement in a scrollback row", (text: string) => text.replace("row 003 plain text", "\x1b[2Arow 003 plain text")],
    ["an unproved colour in a scrollback row", (text: string) => text.replace("row 003 plain text", "\x1b[38;2;1;2mrow 003 plain text")],
    ["text hidden below the scrollback rows", (text: string) => text.replace("\r\n\n\n", "\r\nhidden\n\n")],
    ["a third home and clear", (text: string) => text.replace("row 100\x1b[0m", "\x1b[H\x1b[2Jrow 100\x1b[0m")],
    ["too few rows to hold a scrollback", (text: string) => text.replace("\r\n\n\n", "\r\n\n")],
  ])("refuses %s", (_name, change) => {
    expect(styledRead(change(paint), read, historySize)).toBeNull();
  });

  test("refuses an incomplete read, changed bounds and a paint with no end marker", () => {
    expect(styledRead(paint, { ...read, complete: false }, historySize)).toBeNull();
    expect(styledRead(paint, read, { ...historySize, rows: 119 })).toBeNull();
    expect(styledRead(paint, read, { ...historySize, cols: 10 })).toBeNull(); // Rows wider than the terminal.
    expect(styledRead(paint.slice(0, -1), read, historySize)).toBeNull();
  });
});

// hc 0.1.22 cuts the paint with scrollback and the plain read at different rows (measured 2026-11-24 against a real session and a
// throw-away one): both captures are neutral, made with a throw-away script, and the paint was asked for one screen more scrollback
// than the plain read (as HcClient does), which is why the paint holds more rows than the plain read.
describe("a paint and a plain read that are not cut at the same row (hc 0.1.22)", () => {
  const dir = join(import.meta.dirname, "fixtures");
  const bounds = { cols: 200, rows: 120, reports: 0 };
  const shown = (text: string) => stripSgr(text).split("\n").map((row) => row.trimEnd());
  const rowsOf = (text: string) => text.split("\n").map((row) => row.trimEnd());

  test("scrollback that ends in empty rows: the paint leaves them out, the plain read keeps them", () => {
    const paint = readFileSync(join(dir, "history-trailing-empty-v022.paint.ansi"), "utf8");
    const plain = readFileSync(join(dir, "history-trailing-empty-v022.read.txt"), "utf8");
    // The shape this relies on: 40 rows of text in the scrollback, then the empty rows the plain read keeps.
    expect(rowsOf(plain)).toHaveLength(170);
    expect(rowsOf(plain)[0]).toBe("row 022 truecolor blue  slate");
    const styled = styledRead(paint, { text: plain, complete: true }, bounds);
    expect(styled).not.toBeNull();
    expect(shown(styled!)).toEqual(rowsOf(plain));
    // Rows keep their colour at both ends: the first row of the plain read, and the last row of the screen.
    const spans = parseAnsi(styled!);
    expect(spans.find((span) => span.text === "row 040 orange")).toMatchObject({ fg: "rgb(255,135,0)" });
    expect(spans.find((span) => span.text === " slate ")).toMatchObject({ bg: "rgb(45,59,71)" });
  });

  test("the plain read starts higher than the paint's boundary: the screen ends in an empty cursor row", () => {
    const paint = readFileSync(join(dir, "history-cursor-row-v022.paint.ansi"), "utf8");
    const plain = readFileSync(join(dir, "history-cursor-row-v022.read.txt"), "utf8");
    expect(rowsOf(plain)).toHaveLength(130);
    expect(rowsOf(plain)[0]).toBe("row 132 orange plain text");
    const styled = styledRead(paint, { text: plain, complete: true }, bounds);
    expect(styled).not.toBeNull();
    // The paint holds rows from `row 001`; the answer starts where the plain read does, and nothing is left over.
    expect(shown(styled!)).toEqual(rowsOf(plain));
    expect(parseAnsi(styled!).find((span) => span.text === "row 132 orange")).toMatchObject({ fg: "rgb(255,135,0)" });
  });

  test.each([
    ["trailing-empty", "row 040 orange plain text", "row 040 other plain text"],
    ["cursor-row", "row 150 orange plain text", "row 150 other plain text"],
  ])("refuses a row of the plain read that the paint does not have (%s)", (name, from, to) => {
    const paint = readFileSync(join(dir, `history-${name === "cursor-row" ? "cursor-row" : "trailing-empty"}-v022.paint.ansi`), "utf8");
    const plain = readFileSync(join(dir, `history-${name === "cursor-row" ? "cursor-row" : "trailing-empty"}-v022.read.txt`), "utf8");
    expect(plain).toContain(from);
    expect(styledRead(paint, { text: plain.replace(from, to), complete: true }, bounds)).toBeNull();
  });

  test("refuses a plain read that goes on after the paint's last row, or lacks a text row the paint has", () => {
    const paint = readFileSync(join(dir, "history-cursor-row-v022.paint.ansi"), "utf8");
    const plain = readFileSync(join(dir, "history-cursor-row-v022.read.txt"), "utf8");
    expect(styledRead(paint, { text: `${plain.trimEnd()}\nrow 261 orange plain text`, complete: true }, bounds)).toBeNull();
    // Only empty rows may be missing from the paint; a text row missing from the plain read is a pane that moved.
    const lacking = plain.replace("row 140 orange plain text\n", "");
    expect(lacking).not.toBe(plain);
    expect(styledRead(paint, { text: lacking, complete: true }, bounds)).toBeNull();
  });
});
