import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { clearImageSizeMemory } from "./journal/image-sizes.ts";
import { LiveWindows } from "./journal/live.ts";
import { buildJournalRegistry } from "./journal/registry.ts";
import { TranscriptStore } from "./journal/store.ts";
import { declareCapabilities } from "./mux/capabilities.ts";
import { muxGone } from "./mux/types.ts";
import { paneChat } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView, PaneChatResponse } from "./types.ts";

// GET /api/pane/:id/chat through the shipped route function, over a real pi session log whose pictures are blobs on
// disk: the answer carries the size of each picture its turns name (journal/image-sizes.ts, as the history route does),
// so a page can hold the place of a picture before it has the picture; with no sized picture the answer has no key.
// TEST for bridge/server.ts[paneChat]

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A PNG header with the given size: the signature, then the IHDR chunk. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** One pi message row. */
function row(id: string, message: Record<string, string | { type: string; data: string; mimeType: string }[]>): string {
  return JSON.stringify({ type: "message", id, parentId: "p0", timestamp: "2026-07-29T10:00:00.000Z", message });
}

const bases: string[] = [];
afterEach(async () => {
  clearImageSizeMemory();
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

/** A pi session folder with one log (a prompt and a picture turn per hash given) and a blob folder beside it. */
async function world(hashes: readonly string[]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-chat-sizes-")));
  bases.push(base);
  const sessions = join(base, "sessions");
  const blobs = join(base, "blobs");
  await mkdir(join(sessions, "repo"), { recursive: true });
  await mkdir(blobs, { recursive: true });
  const log = join(sessions, "repo", "2026-07-29T10-00-00-000Z_019f1827-bf99-7927-9684-76318de905b5.jsonl");
  const rows = [
    JSON.stringify({ type: "session", version: 3, id: "019f1827-bf99-7927-9684-76318de905b5", timestamp: "2026-07-29T10:00:00.000Z", cwd: "/repo" }),
    // A prompt before each picture, so every picture is a turn of its own and a page of one turn holds one of them.
    ...hashes.flatMap((hash, n) => [
      row(`u${String(n)}`, { role: "user", content: `show picture ${String(n)}` }),
      row(`m${String(n)}`, { role: "assistant", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] }),
    ]),
  ];
  await writeFile(log, `${rows.join("\n")}\n`);
  const cfg = loadConfig({ HOME: base, COLLIE_STATE_DIR: join(base, "state"), COLLIE_HOST: "127.0.0.1", COLLIE_PI_ROOT: sessions });
  // The shipped registry over the configured roots: pi reads the folder named above.
  const journals = buildJournalRegistry(cfg.journalRoots);
  const live = new LiveWindows(new TranscriptStore());
  const pane: AgentView = {
    paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Main", workspaceNumber: 1, tabId: "w1:t1",
    agent: "pi", status: "idle", cwd: "/repo", focused: false, agentSession: { kind: "path", value: log },
  };
  const partial: Partial<StateEngine> = { current: () => ({ agents: [pane], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }) };
  // SAFETY: paneChat reaches only current() (for the pane lookup) on the paths read here, as in the other route tests.
  const engine = partial as StateEngine;
  const mux = {
    capabilities: declareCapabilities({ supports: ["paneGrid"], topologyLatency: { kind: "push" } }),
    readGrid: async () => muxGone("no screen"),
    foregroundProcesses: async () => muxGone("no process"),
  };
  const chat = async (query = ""): Promise<PaneChatResponse> => {
    const url = new URL(`http://127.0.0.1/api/pane/w1:p1/chat${query}`);
    const res = await paneChat(cfg, journals, live, engine, mux, "w1:p1", url, new Request(url));
    // SAFETY: the shipped route's own JSON.
    return (await res.json()) as PaneChatResponse;
  };
  return { blobs, chat };
}

describe("chat answer carries the size of the pictures its turns name", () => {
  test("a blob on disk gets its size, keyed by the reference the turn carries", async () => {
    const w = await world([HASH_A, HASH_B]);
    await Bun.write(join(w.blobs, HASH_A), png(600, 600));
    await Bun.write(join(w.blobs, HASH_B), png(300, 500));
    const body = await w.chat();
    if (!body.available) throw new Error("chat must be available");
    expect(body.imageSizes).toEqual({
      [`/api/blobs/${HASH_A}`]: { width: 600, height: 600 },
      [`/api/blobs/${HASH_B}`]: { width: 300, height: 500 },
    });
    // The sizes are an addition: the turns themselves are what they always were.
    expect(JSON.stringify(body.upserts)).toContain(`/api/blobs/${HASH_A}`);
  });

  test("an older page carries sizes too", async () => {
    const w = await world([HASH_A, HASH_B]);
    await Bun.write(join(w.blobs, HASH_A), png(600, 600));
    await Bun.write(join(w.blobs, HASH_B), png(300, 500));
    const live = await w.chat("?limit=1&turns=1");
    if (!live.available || live.page !== "live") throw new Error("a live page is expected");
    // The page before the second prompt holds the first picture.
    const second = live.upserts.find((entry) => entry.uuid === "u1");
    if (second === undefined) throw new Error("the second prompt is in the window");
    const older = await w.chat(`?limit=10&turns=1&before=${String(second.seq)}:${second.uuid}`);
    if (!older.available) throw new Error("chat must be available");
    // Whatever the older page holds is sized by the same rule: every reference in it has its size.
    let pictures = 0;
    for (const entry of older.upserts) {
      for (const part of entry.parts) {
        if (part.kind !== "image") continue;
        pictures += 1;
        expect(older.imageSizes?.[part.url]).toBeDefined();
      }
    }
    // Not vacuous: the page really held a picture.
    expect(pictures).toBeGreaterThan(0);
  });

  test("a picture the bridge cannot find leaves its size out, and an answer with none carries no key", async () => {
    const w = await world([HASH_A]);
    const body = await w.chat();
    if (!body.available) throw new Error("chat must be available");
    expect("imageSizes" in body).toBe(false);
    expect(body.upserts.length).toBeGreaterThan(0);
  });
});
