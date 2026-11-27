// List the linked checkouts of one repository for Dogr's "open worktree" sheet.
// This is a read only: opening one is a separate, guarded write. Never run git through a shell.
// TEST:bridge/dogr-worktree-list.test.ts

import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { gitBinary, runGit } from "./changes.ts";
import { parseWorktreeList } from "./worktree-add.ts";

/** One linked worktree reported by git, including a checkout which is not safe to open yet. */
export interface DogrWorktree {
  /** The absolute path as git reported it. */
  path: string;
  /** The branch without its refs/heads prefix, or null for a detached checkout. */
  branch: string | null;
  /** Git says this entry is locked or may be pruned, or its folder cannot be resolved. */
  unavailable: boolean;
}

/** A read that fails is not an empty list: callers must tell the person the difference. */
export type DogrWorktreeList =
  | { ok: true; worktrees: DogrWorktree[] }
  | { ok: false; reason: "git_unavailable" | "git_failed" };

/** Dependencies that let a test exercise failures without starting git. */
export interface DogrWorktreeListDeps {
  /** Read git's porcelain output, or null if the read failed. */
  read: (repoRoot: string) => Promise<string | null>;
  /** Resolve a path to its real location, or null if it cannot be read. */
  resolve: (path: string) => Promise<string | null>;
}

/**
 * Read the linked worktrees of a known main checkout.
 * @param repoRoot The main checkout's real path, established by the bridge rather than trusted from a phone.
 * @param deps The read-only git and filesystem operations; omitted in production.
 * @returns The linked checkouts or a named read failure; the main checkout itself is omitted.
 */
// TEST:bridge/dogr-worktree-list.test.ts[list excludes main checkout, list failure is not empty]
export async function listDogrWorktrees(repoRoot: string, deps?: DogrWorktreeListDeps): Promise<DogrWorktreeList> {
  const git = deps === undefined ? await gitBinary() : null;
  if (deps === undefined && git === null) return { ok: false, reason: "git_unavailable" };
  const read = deps?.read ?? (async (root: string): Promise<string | null> => {
    if (git === null) return null;
    try {
      // Keep non-ASCII names readable; git may still quote control characters, which resolve to no file and stay unavailable.
      const run = await runGit(git, { workTree: root, gitDir: join(root, ".git") }, ["worktree", "list", "--porcelain"], ["-c", "core.quotepath=false"], 1024 * 1024, { timeoutMs: 10_000 });
      return run.code === 0 && !run.timedOut && !run.capped ? run.stdout.toString("utf8") : null;
    } catch {
      return null;
    }
  });
  const resolve = deps?.resolve ?? (async (path: string): Promise<string | null> => {
    try { return await realpath(path); } catch { return null; }
  });
  const output = await read(repoRoot);
  if (output === null) return { ok: false, reason: "git_failed" };
  const main = await resolve(repoRoot);
  if (main === null) return { ok: false, reason: "git_failed" };
  const worktrees: DogrWorktree[] = [];
  for (const block of parseWorktreeList(output)) {
    const path = await resolve(block.path);
    // Compare real paths so an alias for the main checkout cannot appear as a linked worktree.
    if (path === main || block.bare) continue;
    const prefix = "refs/heads/";
    worktrees.push({
      path: block.path,
      branch: block.branch?.startsWith(prefix) ? block.branch.slice(prefix.length) : block.branch,
      unavailable: path === null || block.locked || block.prunable,
    });
  }
  return { ok: true, worktrees };
}
