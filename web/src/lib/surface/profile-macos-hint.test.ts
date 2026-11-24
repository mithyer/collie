// pi on macOS names its edit hint `Option+Up`, where Linux and Windows say `Alt+Up`. The test was one case of
// profile.test.ts, which is at upstream's 100 KB cap on a test file (scripts/test-file-size.test.ts), so it lives here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { rowText } from "./frame";
import { loadProfiles, type SteerWitness } from "./profile";

const FIXTURES = join(import.meta.dirname, "../../fixtures/panes");
/** The rows of a capture as plain text, the way the reader sees them. */
const rowsOf = (name: string, width: string): string[] => splitLines(parseAnsi(readFileSync(join(FIXTURES, `${name}--${width}.txt`), "utf8"))).map((row) => rowText(row).trimEnd());
const witnesses = (id: string): readonly SteerWitness[] => loadProfiles().get(id)!.keys.steerWitness!;

it("pi on macOS names the edit hint `Option+Up`, not `Alt+Up`: the steer witness and the queued row accept both (live capture, pi 1.5.2)", () => {
  const [block] = witnesses("pi");
  const rows = rowsOf("pi--v152-steer-after-macos", "w200");
  // The `Steering:` row stands right over the macOS hint, and the witness finds it.
  const at = rows.findIndex((row) => new RegExp(block!.pattern, "u").exec(row)?.groups?.["text"] === "say banana");
  expect(at).toBeGreaterThan(0);
  expect(rows[at + 1]).toContain("Option+Up");
  expect(new RegExp(block!.hint!, "u").test(rows[at + 1]!)).toBe(true);
  // The same hint, worded for Linux and Windows, still matches, and so does the queued row's.
  expect(new RegExp(block!.hint!, "u").test("↳ Alt+Up to edit all queued messages")).toBe(true);
  const queued = loadProfiles().get("pi")!.keys.queuedRow!;
  expect(["↳ Alt+Up to edit all queued messages", "↳ Option+Up to edit all queued messages"].map((row) => new RegExp(queued.hint, "u").test(row))).toEqual([true, true]);
  // Other keys are not taken for it.
  expect(new RegExp(block!.hint!, "u").test("↳ Ctrl+Up to edit all queued messages")).toBe(false);
});
