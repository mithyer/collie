import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import { imageExtFromBytes } from "./uploads.ts";

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
// A SECOND QUESTION, ABOUT A PICTURE THE CHAT ALREADY SHOWS. A picture in a conversation is a blob this
// machine already holds (`/api/blobs/<64 hex>`, `journal/pi.ts` `resolveBlobPath`), so a client that
// wants to attach it to a message should not have to download it and upload it again. It asks
// `{ "blob": "<64 hex>" }` on the same route; the machine copies its own file into the uploads folder
// under a name of the usual shape (or finds the copy it made before) and answers with that path, in the
// same two answers as above. The client only ever names a hash; the machine decides whether it holds
// such a blob, what it is (by its bytes: a picture or nothing), and where the copy goes.
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

/**
 * Read a question about a blob from a request body.
 *
 * @param text The body text.
 * @returns The blob's hash (64 hex, lowercase) when the body is `{ blob: <64 hex> }`, otherwise null.
 *          A body with a `sha256` is the other question and is not a blob question.
 */
export function parseBlobAsk(text: string): string | null {
  if (text.length > REUSE_ASK_MAX_CHARS) return null;
  let body: JsonValue;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { blob } = body;
  if (typeof blob !== "string" || !/^[0-9a-fA-F]{64}$/.test(blob)) return null;
  return blob.toLowerCase();
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

/** What a copy of a blob needs from outside: where to put it, under which pane's name, and how big it may be. */
export interface BlobCopy {
  /** The blob's own file, already resolved and checked to lie inside a blob folder (`resolveBlobPath`). */
  readonly source: string;
  /** The uploads folder (`<stateDir>/uploads`). */
  readonly dir: string;
  /** The pane the client is writing to; it only becomes part of the file name. */
  readonly paneId: string;
  /** The largest file this machine accepts (`cfg.maxUploadBytes`). */
  readonly maxBytes: number;
  /** The clock, in milliseconds; replaced in tests. */
  readonly now?: number;
  /** Eight hex characters for the name; replaced in tests. */
  readonly nonce?: string;
}

/**
 * Make a blob available as an upload: the path of a picture file in the uploads folder with the blob's
 * bytes in it.
 *
 * Only a picture counts, judged by its bytes (the same check the upload route makes), and only one the
 * machine would have accepted as an upload (not empty, not over the size limit); anything else is a
 * miss and the client uploads the bytes it already holds. A copy made earlier is found by its bytes
 * (the same lookup as {@link findReusable}) so asking twice makes one file.
 *
 * @param copy Where the blob is, where the copy goes, and the limits.
 * @param fs The disk for the lookup, replaced in tests.
 * @returns The full path of the file to use, or null when the blob is not an acceptable picture.
 */
export async function holdBlob(copy: BlobCopy, fs: ReuseFs = realFs): Promise<string | null> {
  const meta = await fs.stat(copy.source);
  if (meta === null || meta.size < 1 || meta.size > copy.maxBytes) return null;
  let bytes: Uint8Array;
  try {
    bytes = await readFile(copy.source);
  } catch {
    return null;
  }
  // The file may have changed between the stat and the read; the size we judged must still be true.
  if (bytes.byteLength !== meta.size) return null;
  const ext = imageExtFromBytes(bytes.subarray(0, 16));
  if (ext === null) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const held = await findReusable(copy.dir, { sha256, size: bytes.byteLength }, fs);
  if (held !== null) return held;
  const safePane = copy.paneId.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `${safePane}-${(copy.now ?? Date.now()).toString(36)}-${copy.nonce ?? crypto.randomUUID().slice(0, 8)}.${ext}`;
  const path = join(copy.dir, name);
  try {
    // 0700 / 0600: pictures may hold private things, like every upload (server.ts `uploadPane`).
    await mkdir(copy.dir, { recursive: true, mode: 0o700 });
    // "wx": never overwrite a file that is already there under this name.
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    return null;
  }
  return path;
}
