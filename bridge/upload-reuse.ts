import { createHash } from "node:crypto";
import { lstat, readdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";

// Reusing an upload that is already on this machine (Dogr addition, see collie-fork.md).
//
// A client that is about to upload a file can ask first whether this machine already holds the same
// bytes: `POST /api/pane/:id/upload` with a JSON body `{ "sha256": "<64 hex>", "size": <bytes> }`
// instead of the multipart form. The answer is `{ ok: true, found: true, path }` (use that path, send
// nothing) or `{ ok: true, found: false }` (upload as usual).
//
// WHY NO INDEX FILE. The files already sit in `<stateDir>/uploads/` and the sweep (uploads.ts) already
// forgets them with the same 48 hours. So the question is answered by LOOKING: list the folder, keep
// the files whose size equals the asked size, and hash those. Nothing is trusted from a client (a
// client cannot register a wrong path, the machine measures the bytes itself), nothing has to be kept
// in step with the sweep, and a restart loses nothing. A handful of equal sizes is the honest case.
//
// THE PATH KEEPS ITS SHAPE. The harness adapters recognise Collie's own upload by the shape of its
// path (`web/src/lib/upload-path.ts`: `<pane>-<base36 time>-<8 hex>.<ext>`), so the answer is the
// ORIGINAL path, never a new name made from the hash. The pane in the name is the pane that first
// received the file; nothing compares it with the pane that sends it again (checked 2026-11-25).
//
// A hit refreshes the file's modification time, so the sweep does not remove it a moment after the
// client was told to use it.
//
// TEST:upload-reuse.test.ts

/** A request body this large is no honest question (it is two short fields); it is refused unread. */
export const REUSE_ASK_MAX_CHARS = 512;

/**
 * How many files of the asked size are read and hashed for one question. Equal sizes are rare, so the
 * limit only stops a folder of look-alikes from turning one question into a long read.
 */
export const REUSE_MAX_HASHED = 8;

/** The shape of a name the upload route made: `<pane>-<base36 time>-<8 hex>.<ext>`. Nothing else is answered. */
const UPLOAD_NAME = /^[A-Za-z0-9_-]+-[0-9a-z]+-[0-9a-f]{8}\.[a-z0-9]+$/;

/** What a client asks: the SHA-256 (lowercase hex) and the byte size of the file it holds. */
export interface ReuseAsk {
  readonly sha256: string;
  readonly size: number;
}

/** What the route answers. `found: false` means "upload it"; the path is only ever one this machine made. */
export type UploadReuseResponse =
  | { ok: true; found: true; path: string }
  | { ok: true; found: false };

/**
 * Whether a request is a question rather than an upload: its content type is JSON. A multipart form
 * (an upload) and anything else keep going the old way.
 *
 * @param contentType The request's `content-type` header, or null.
 * @returns True when the body should be read as a {@link ReuseAsk}.
 */
export function isReuseAsk(contentType: string | null): boolean {
  return contentType !== null && /^application\/json\b/i.test(contentType.trim());
}

/**
 * Read a question from a request body. Pure: the whole decision of what counts as a valid question.
 *
 * @param text The body text.
 * @param maxBytes The largest file this machine accepts (`cfg.maxUploadBytes`); a larger size cannot be held.
 * @returns The question, or null when the body is not `{ sha256: 64 hex, size: 1…maxBytes }`.
 */
export function parseReuseAsk(text: string, maxBytes: number): ReuseAsk | null {
  if (text.length > REUSE_ASK_MAX_CHARS) return null;
  let body: JsonValue;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { sha256, size } = body;
  if (typeof sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > maxBytes) return null;
  return { sha256: sha256.toLowerCase(), size };
}

/** The slice of the disk the lookup needs, injectable so the decision can be tested without one. */
export interface ReuseFs {
  /** The names in the uploads folder; a folder that does not exist is an empty one. */
  list(dir: string): Promise<string[]>;
  /** The size and mtime of a regular file (never a link), or null for anything else or a vanished file. */
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** The SHA-256 of a file's bytes, lowercase hex, or null when it cannot be read. */
  sha256(path: string): Promise<string | null>;
  /** Set the file's modification time to now; a failure is ignored. */
  touch(path: string): Promise<void>;
}

const realFs: ReuseFs = {
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  async stat(path) {
    try {
      const s = await lstat(path);
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  async sha256(path) {
    try {
      return createHash("sha256").update(await readFile(path)).digest("hex");
    } catch {
      return null;
    }
  },
  async touch(path) {
    const now = new Date();
    try {
      await utimes(path, now, now);
    } catch {
      // A file that vanished, or one we cannot touch, is still a file the client may use now.
    }
  },
};

/**
 * Look for a file in `dir` with these exact bytes.
 *
 * Only names the upload route could have made count, and only regular files (a link someone planted is
 * skipped). The newest files are read first.
 *
 * @param dir The uploads folder (`<stateDir>/uploads`).
 * @param ask The SHA-256 and size to find.
 * @param fs The disk, replaced in tests.
 * @returns The full path of a file whose bytes hash to `ask.sha256`, or null.
 */
export async function findReusable(dir: string, ask: ReuseAsk, fs: ReuseFs = realFs): Promise<string | null> {
  const sameSize: { path: string; mtimeMs: number }[] = [];
  for (const name of await fs.list(dir)) {
    if (!UPLOAD_NAME.test(name)) continue;
    const path = join(dir, name);
    const stat = await fs.stat(path);
    if (stat !== null && stat.size === ask.size) sameSize.push({ path, mtimeMs: stat.mtimeMs });
  }
  sameSize.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of sameSize.slice(0, REUSE_MAX_HASHED)) {
    if ((await fs.sha256(candidate.path)) !== ask.sha256) continue;
    await fs.touch(candidate.path);
    return candidate.path;
  }
  return null;
}
