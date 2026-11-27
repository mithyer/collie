// The released server gets the Dogr route once, or the build refuses an upstream refactor.
// TEST:scripts/dogr-worktree-stamp.ts[stampDogrWorktreeRoute]
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stampDogrWorktreeRoute } from "./dogr-worktree-stamp.ts";

/** Read upstream's actual server so its changing anchors fail in this test, before a release. */
const source = readFileSync(join(import.meta.dir, "../bridge/server.ts"), "utf8");

describe("Dogr worktree route stamp", () => {
  test("stamps once and preserves the authorization gates", () => {
    const first = stampDogrWorktreeRoute(source);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(first.text).toContain('caller.gate(req.method === "GET" ? "read" : "write")');
    expect(first.text).toContain('searchParams.has("host")');
    expect(stampDogrWorktreeRoute(first.text)).toEqual(first);
  });

  test("refuses changed anchors, duplicates and partially stamped sources", () => {
    expect(stampDogrWorktreeRoute(source.replace("    // ── Structural creates:", "    // ── Changed:" )).ok).toBe(false);
    expect(stampDogrWorktreeRoute(source + '\nimport { dogrWorktreeRoute } from "./dogr-worktree-route.ts";\n').ok).toBe(false);
    const stamped = stampDogrWorktreeRoute(source);
    if (!stamped.ok) throw new Error(stamped.reason);
    expect(stampDogrWorktreeRoute(stamped.text.replace('caller.gate(req.method === "GET" ? "read" : "write")', 'caller.gate("read")')).ok).toBe(false);
  });
});
