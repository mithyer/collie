// Tests for the read-only worktree list that Dogr uses before offering to open a checkout.
// TEST:bridge/dogr-worktree-list.ts[listDogrWorktrees]
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDogrWorktrees, type DogrWorktreeListDeps } from "./dogr-worktree-list.ts";

/** A git answer with a main checkout, a linked checkout and entries that cannot safely be opened. */
const porcelain = [
  "worktree /repo\nHEAD a\nbranch refs/heads/main",
  "worktree /work/feature\nHEAD b\nbranch refs/heads/feature/a",
  "worktree /work/locked\nHEAD c\ndetached\nlocked preparing",
  "worktree /work/gone\nHEAD d\nbranch refs/heads/gone\nprunable missing",
].join("\n\n") + "\n";

/** A controlled filesystem and git read: no real user's repository is touched. */
function deps(output: string | null): DogrWorktreeListDeps {
  return {
    read: async () => output,
    resolve: async (path) => path === "/work/gone" ? null : path,
  };
}

describe("Dogr's worktree list", () => {
  test("list excludes main checkout and marks unsafe entries", async () => {
    expect(await listDogrWorktrees("/repo", deps(porcelain))).toEqual({
      ok: true,
      worktrees: [
        { path: "/work/feature", branch: "feature/a", unavailable: false },
        { path: "/work/locked", branch: null, unavailable: false },
        { path: "/work/gone", branch: "gone", unavailable: true },
      ],
    });
  });

  test("list failure is not empty", async () => {
    expect(await listDogrWorktrees("/repo", deps(null))).toEqual({ ok: false, reason: "git_failed" });
    expect(await listDogrWorktrees("/repo", { ...deps(porcelain), resolve: async () => null })).toEqual({ ok: false, reason: "git_failed" });
  });

  test("reads a real scratch repository with a non-ASCII checkout path", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dogr-worktrees-"));
    const repo = join(scratch, "repo");
    const checkout = join(scratch, "测试 folder");
    /** Run git in this throw-away folder only, without touching the owner's repositories. */
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd: scratch, stdio: "pipe" }); };
    try {
      git("init", repo);
      git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "test");
      git("-C", repo, "worktree", "add", "-b", "feature", checkout);
      expect(await listDogrWorktrees(repo)).toEqual({ ok: true, worktrees: [{ path: realpathSync(checkout), branch: "feature", unavailable: false }] });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("an alias of the main checkout is never offered", async () => {
    const alias = porcelain.replace("worktree /repo", "worktree /alias");
    const filesystem = { ...deps(alias), resolve: async (path: string) => path === "/alias" ? "/repo" : path };
    const result = await listDogrWorktrees("/repo", filesystem);
    expect(result.ok && result.worktrees.some((worktree) => worktree.path === "/alias")).toBe(false);
  });
});
