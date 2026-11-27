// Dogr's read and open routes for existing linked Git worktrees.
// The dispatcher must run the same device gate as the ordinary workspace routes before calling these.
// TEST:bridge/dogr-worktree-route.test.ts

import { realpath } from "node:fs/promises";
import { listDogrWorktrees, type DogrWorktreeList } from "./dogr-worktree-list.ts";

/** The snapshot facts this route needs; no path supplied by the phone identifies a repository. */
export interface DogrWorktreeSpace {
  /** The multiplexer-assigned workspace identifier. */
  workspaceId: string;
  /** Main checkout of this workspace's repository, when known. */
  repoRoot?: string;
  /** The workspace's own folder, when known. */
  folder?: string;
}

/** External operations, narrowed so a test can check that invalid input never creates a space. */
export interface DogrWorktreeRouteDeps {
  /** The latest snapshot of this session. */
  spaces: readonly DogrWorktreeSpace[];
  /** Read this main checkout's linked worktrees. */
  list?: (root: string) => Promise<DogrWorktreeList>;
  /** Resolve a path for comparison; null means it cannot be used. */
  resolve?: (path: string) => Promise<string | null>;
  /** The ordinary workspace route, with its receipt and audit handling. */
  create: (request: Request) => Promise<Response>;
}

/** An answer without paths in logs or redirects; browsers must not cache repository contents. */
function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Resolve one folder without making a filesystem error the whole route's error. */
async function resolvePath(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}

/**
 * List a workspace's linked checkouts or open one after verifying that Git lists it for that workspace's repository.
 * @param req The gated request; GET has a workspace query, POST has workspace, path and requestId in JSON.
 * @param deps The session snapshot and the existing workspace-create handler.
 * @returns A JSON response, or the existing create route's response for a new workspace.
 */
// TEST:bridge/dogr-worktree-route.test.ts
export async function dogrWorktreeRoute(req: Request, deps: DogrWorktreeRouteDeps): Promise<Response> {
  let fields: Record<string, unknown>;
  if (req.method === "GET") {
    fields = { workspace: new URL(req.url).searchParams.get("workspace") };
  } else if (req.method === "POST") {
    try {
      const body: unknown = await req.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) return answer({ ok: false, code: "bad_request" }, 400);
      fields = body as Record<string, unknown>;
    } catch {
      return answer({ ok: false, code: "bad_request" }, 400);
    }
  } else {
    return answer({ ok: false, code: "method_not_allowed" }, 405);
  }
  if (typeof fields.workspace !== "string" || fields.workspace.length === 0) return answer({ ok: false, code: "bad_request" }, 400);
  const space = deps.spaces.find((candidate) => candidate.workspaceId === fields.workspace);
  if (space === undefined) return answer({ ok: false, code: "workspace_gone" }, 404);
  if (space.repoRoot === undefined || space.repoRoot === "") return answer({ ok: false, code: "not_a_repo" }, 400);
  const result = await (deps.list ?? listDogrWorktrees)(space.repoRoot);
  if (!result.ok) return answer({ ok: false, code: result.reason }, 503);
  const resolve = deps.resolve ?? resolvePath;
  if (req.method === "GET") {
    const opened = new Map<string, string>();
    for (const candidate of deps.spaces) {
      if (candidate.folder === undefined) continue;
      const path = await resolve(candidate.folder);
      if (path !== null && !opened.has(path)) opened.set(path, candidate.workspaceId);
    }
    const worktrees = await Promise.all(result.worktrees.map(async (worktree) => {
      const path = await resolve(worktree.path);
      return { ...worktree, openWorkspaceId: path === null ? null : opened.get(path) ?? null };
    }));
    return answer({ ok: true, worktrees });
  }
  if (typeof fields.path !== "string" || fields.path.length === 0 || typeof fields.requestId !== "string") {
    return answer({ ok: false, code: "bad_request" }, 400);
  }
  const target = await resolve(fields.path);
  if (target === null) return answer({ ok: false, code: "worktree_not_found" }, 404);
  // An arbitrary folder is never enough: git must still list it as a usable linked checkout of this repo.
  let matched = false;
  for (const worktree of result.worktrees) {
    if (!worktree.unavailable && await resolve(worktree.path) === target) { matched = true; break; }
  }
  if (!matched) return answer({ ok: false, code: "worktree_not_found" }, 404);
  for (const candidate of deps.spaces) {
    if (candidate.folder !== undefined && await resolve(candidate.folder) === target) {
      return answer({ ok: true, alreadyOpen: true, workspaceId: candidate.workspaceId });
    }
  }
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  // Reuse Collie's ordinary create, including its request-id receipt and unknown-outcome handling.
  const createRequest = new Request(req.url, { method: "POST", headers, body: JSON.stringify({ cwd: target, requestId: fields.requestId }) });
  return deps.create(createRequest);
}
