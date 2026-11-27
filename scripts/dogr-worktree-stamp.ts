// Add Dogr's existing-worktree route to a release copy, without committing an edit to upstream's server.
// TEST:scripts/dogr-worktree-stamp.test.ts

/** The unique import next to the existing upstream worktree route. */
const IMPORT_ANCHOR = 'import { parseWorktreeFolderBody, saveWorktreeFolder, worktreeFolderAnswer } from "./worktree-folder-route.ts";';
/** The unique dispatch point beside the upstream workspace-create route. */
const ROUTE_ANCHOR = "    // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──";
/** A marker unique to our injected route. */
const MARKER = "    // Dogr: existing linked worktrees (injected in release builds).";
/** The route lives behind the same read/write device gates and session resolver as upstream. */
const ROUTE = `${MARKER}
    if (pathname === "/api/dogr/worktrees" && (req.method === "GET" || req.method === "POST")) {
      const denied = caller.gate(req.method === "GET" ? "read" : "write");
      if (denied) return denied;
      // A crew route must be allowlisted before it can be forwarded; do not read the wrong host.
      if (new URL(req.url).searchParams.has("host")) return Response.json({ ok: false, code: "unsupported_host" }, { status: 501 });
      const rt = await caller.resolve();
      if (rt instanceof Response) return rt;
      return dogrWorktreeRoute(req, {
        spaces: rt.engine.current().workspaces,
        create: async (createReq) => createWorkspace(rt.herdr, rt.engine, createReq, caller.audit, caller.device(), rt.name, folders, await sessionFolderOf(rt.name), { receipts: launchReceipts }),
      });
    }

`;

/** Whether upstream still has the exact places into which Dogr can safely inject its route. */
export type WorktreeStamped = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Add the route to one copy of Collie's server, refusing an unexpected upstream refactor.
 * @param source The original or already stamped server source.
 * @returns The stamped source, or a reason when the anchors are missing or ambiguous.
 */
// TEST:scripts/dogr-worktree-stamp.test.ts[stamps once, refuses changed anchors]
export function stampDogrWorktreeRoute(source: string): WorktreeStamped {
  const importLine = 'import { dogrWorktreeRoute } from "./dogr-worktree-route.ts";';
  const count = (text: string): number => source.split(text).length - 1;
  const stamped = count(MARKER);
  if (stamped === 1 && count(ROUTE) === 1 && count(importLine) === 1 && count(ROUTE_ANCHOR) === 1 && count(IMPORT_ANCHOR) === 1) return { ok: true, text: source };
  if (stamped !== 0 || count(importLine) !== 0 || count(IMPORT_ANCHOR) !== 1 || count(ROUTE_ANCHOR) !== 1) {
    return { ok: false, reason: "bridge/server.ts: Dogr worktree anchors are missing, duplicated, or partly stamped" };
  }
  return {
    ok: true,
    text: source.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${importLine}`).replace(ROUTE_ANCHOR, `${ROUTE}${ROUTE_ANCHOR}`),
  };
}
