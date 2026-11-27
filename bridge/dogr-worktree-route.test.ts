// Check the worktree route's repository boundary and duplicate-open behavior without opening a real workspace.
// TEST:bridge/dogr-worktree-route.ts[dogrWorktreeRoute]
import { describe, expect, test } from "bun:test";
import { dogrWorktreeRoute, type DogrWorktreeRouteDeps } from "./dogr-worktree-route.ts";

/** A workspace and one Git-confirmed linked worktree. */
function fixture(): { deps: DogrWorktreeRouteDeps; created: Request[] } {
  const created: Request[] = [];
  return {
    created,
    deps: {
      spaces: [{ workspaceId: "w1", repoRoot: "/repo", folder: "/repo" }],
      list: async () => ({ ok: true, worktrees: [{ path: "/worktree", branch: "feature", unavailable: false }] }),
      resolve: async (path) => path === "/alias" ? "/worktree" : path,
      create: async (request) => { created.push(request); return Response.json({ ok: true }); },
    },
  };
}

/** Make a write request without any credentials or real computer path. */
function opening(path: string): Request {
  return new Request("http://localhost/api/dogr/worktrees", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: "w1", path, requestId: "request-1" }),
  });
}

describe("Dogr worktree route", () => {
  test("lists worktrees and marks an already open alias", async () => {
    const { deps } = fixture();
    deps.spaces = [...deps.spaces, { workspaceId: "w2", folder: "/alias" }];
    const response = await dogrWorktreeRoute(new Request("http://localhost/api/dogr/worktrees?workspace=w1"), deps);
    expect(await response.json()).toEqual({ ok: true, worktrees: [{ path: "/worktree", branch: "feature", unavailable: false, openWorkspaceId: "w2" }] });
  });

  test("rejects a folder outside the repository without creating a workspace", async () => {
    const { deps, created } = fixture();
    const response = await dogrWorktreeRoute(opening("/unrelated"), deps);
    expect(response.status).toBe(404);
    expect(created).toHaveLength(0);
  });

  test("opens an existing space rather than creating a duplicate", async () => {
    const { deps, created } = fixture();
    deps.spaces = [...deps.spaces, { workspaceId: "w2", folder: "/worktree" }];
    const response = await dogrWorktreeRoute(opening("/alias"), deps);
    expect(await response.json()).toEqual({ ok: true, alreadyOpen: true, workspaceId: "w2" });
    expect(created).toHaveLength(0);
  });

  test("passes a verified path and the original request id to ordinary creation", async () => {
    const { deps, created } = fixture();
    const response = await dogrWorktreeRoute(opening("/alias"), deps);
    expect(response.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(await created[0]?.json()).toEqual({ cwd: "/worktree", requestId: "request-1" });
  });

  test("a missing source workspace or failed git read never creates a workspace", async () => {
    const { deps, created } = fixture();
    expect((await dogrWorktreeRoute(new Request("http://localhost/api/dogr/worktrees?workspace=missing"), deps)).status).toBe(404);
    deps.list = async () => ({ ok: false, reason: "git_failed" });
    expect((await dogrWorktreeRoute(opening("/worktree"), deps)).status).toBe(503);
    expect(created).toHaveLength(0);
  });
});
