import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { uploadPane } from "./server.ts";

// POST /api/pane/:id/upload with a JSON body, through the shipped route function over real folders: the question
// "do you already hold these bytes?" ({ sha256, size }) and the question about a picture of the conversation
// ({ blob }), which the machine answers by copying its own blob file into the uploads folder (upload-reuse.ts).
// TEST for bridge/server.ts[uploadPane] and bridge/upload-reuse.ts[holdBlob]

const HASH = "c".repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5, 4, 3, 2]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** What the route answers to a question (a refusal has no JSON body, so its fields are all absent). */
interface Reply {
  ok?: boolean;
  found?: boolean;
  path?: string;
}

/** The status and the parsed body of one answer. */
interface Answer {
  status: number;
  body: Reply;
}

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

/** A pi-shaped sessions folder with a blob folder beside it, a state folder, and a way to ask the route. */
async function world(blobs: Readonly<Record<string, Uint8Array>>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-upload-blob-")));
  bases.push(base);
  const sessions = join(base, "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(base, "blobs"), { recursive: true });
  for (const [hash, bytes] of Object.entries(blobs)) await writeFile(join(base, "blobs", hash), bytes);
  const cfg = loadConfig({ HOME: base, COLLIE_STATE_DIR: join(base, "state"), COLLIE_HOST: "127.0.0.1", COLLIE_PI_ROOT: sessions });
  const audited: { action?: string; detail?: { blob?: boolean } }[] = [];
  const audit = new AuditLog((line) => void audited.push(JSON.parse(line)), { now: () => 1 });
  const ask = async (body: { blob?: string; sha256?: string; size?: number; nothing?: number }): Promise<Answer> => {
    const req = new Request("http://127.0.0.1/api/pane/w1:p1/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await uploadPane(cfg, "w1:p1", req, audit, null, "s1");
    const text = await res.text();
    try {
      // SAFETY: the shipped route's own JSON.
      return { status: res.status, body: JSON.parse(text) as Reply };
    } catch {
      // A refusal is plain text, not JSON.
      return { status: res.status, body: {} };
    }
  };
  return { cfg, ask, audited, uploads: join(cfg.stateDir, "uploads") };
}

describe("a question to the upload route", () => {
  test("a blob the machine holds is copied into the uploads folder and its path answered", async () => {
    const w = await world({ [HASH]: PNG });
    const answer = await w.ask({ blob: HASH });
    expect(answer.status).toBe(200);
    expect(answer.body.found).toBe(true);
    const path = answer.body.path ?? "";
    expect(path.startsWith(w.uploads)).toBe(true);
    expect(path.slice(w.uploads.length + 1)).toMatch(/^w1_p1-[0-9a-z]+-[0-9a-f]{8}\.png$/);
    expect(sha(new Uint8Array(await Bun.file(path).arrayBuffer()))).toBe(sha(PNG));
    expect(w.audited.some((line) => line.action === "upload" && line.detail?.blob === true)).toBe(true);
  });

  test("asking again makes no second file, and the sha256 question then finds the same copy", async () => {
    const w = await world({ [HASH]: PNG });
    const first = await w.ask({ blob: HASH });
    const second = await w.ask({ blob: HASH });
    expect(second.body).toEqual(first.body);
    expect(await readdir(w.uploads)).toHaveLength(1);
    const held = await w.ask({ sha256: sha(PNG), size: PNG.byteLength });
    expect(held.body).toEqual(first.body);
  });

  test("a blob nobody holds, and one that is not a picture, are answered found: false and nothing is written", async () => {
    const w = await world({ [HASH]: new TextEncoder().encode("plain words, not a picture") });
    expect((await w.ask({ blob: "d".repeat(64) })).body).toEqual({ ok: true, found: false });
    expect((await w.ask({ blob: HASH })).body).toEqual({ ok: true, found: false });
    await expect(stat(w.uploads)).rejects.toBeDefined();
  });

  test("a blob larger than the upload limit is a miss: the client then uploads what it holds", async () => {
    const w = await world({ [HASH]: PNG });
    const small = { ...w.cfg, maxUploadBytes: PNG.byteLength - 1 };
    const req = new Request("http://127.0.0.1/api/pane/w1:p1/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: HASH }),
    });
    const res = await uploadPane(small, "w1:p1", req, new AuditLog(() => {}, { now: () => 1 }), null, "s1");
    expect(await res.json()).toEqual({ ok: true, found: false });
  });

  test("a body that is neither question is a 400, and a name that is not a hash never reaches the disk", async () => {
    const w = await world({ [HASH]: PNG });
    expect((await w.ask({ blob: "../../etc/passwd" })).status).toBe(400);
    expect((await w.ask({ nothing: 1 })).status).toBe(400);
  });
});
