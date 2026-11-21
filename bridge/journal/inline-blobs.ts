// Pictures that a journal carries inline, kept on disk and named by a short address instead.
//
// WHY. A pi (or Claude, opencode, muse) session log may hold a picture as base64 text inside one of its
// rows. Until now that text rode in EVERY chat page, history page and live frame that row was part of:
// one screenshot is 0.3 to 3 MB of text, a session with twenty of them made a single first page weigh
// megabytes, and the phone paid for it each time it read the thread (the app's memory crash notes, and
// the read of one picture-heavy turn that took 1.9 MB). pi's own `blob:sha256:` references never had
// that problem: they become `/api/blobs/<hash>` (journal/pi.ts § resolveImage), a short address the
// page fetches only when it draws the picture, and Collie's transcript view draws a tool result's
// picture only once its card is opened.
//
// WHAT. An inline picture of a size worth the trip (at least {@link INLINE_BLOB_MIN_CHARS} of base64
// text) whose bytes are a raster picture is written once to this store under the hash of its text, and
// the journal gets the same `/api/blobs/<hash>` address pi's blobs use. The blob route (server.ts §
// blobRoute) finds it through {@link inlineBlobDir}, because `resolveBlobPath` searches this folder
// beside pi's own `blobs/`. Nothing else changes: the route, its gate (a read), its `no-store` header
// and the phone's two-shape check of an image address are the ones that already serve pi's blobs.
//
// WHAT STAYS INLINE (the old behaviour, so the worst case is exactly what it was):
//   - a store that was never configured (every test, and any caller outside the bridge);
//   - a picture under the size floor, where a second request would cost more than it saves;
//   - bytes that are not PNG, JPEG, GIF or WebP, such as SVG: the blob route sniffs only those four,
//     and an unrecognised type would reach the page as `application/octet-stream` and not draw;
//   - any failure to write (a full disk, a folder that is not writable): the picture is returned
//     inline, never dropped.
//
// SAFETY. The folder lives inside the state folder (mode 0700) and a file in it is 0600, like every
// other file Collie keeps there. The name is the SHA-256 of the picture's base64 text, so a hash that
// does not exist answers 404 and a path can never be chosen by a journal: only a 64-hex name is ever
// built, and `resolveBlobPath` still checks containment with a real path. The store holds only what the
// agent already wrote in its own log, which the same bridge served inline before.
//
// LIFETIME. A picture is kept for {@link INLINE_BLOB_MAX_AGE_MS} and the folder is held to
// {@link INLINE_BLOB_MAX_BYTES}, oldest first, checked when the store is set up and then every
// {@link PRUNE_EVERY} new pictures. A picture pruned while a phone still holds its address answers 404;
// reading the thread again writes it back, because the journal still has the text.
//
// TEST:journal/inline-blobs.test.ts

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The smallest base64 text worth an address: under this the picture rides inline, as before (24 KB of picture). */
export const INLINE_BLOB_MIN_CHARS = 32 * 1024;

/** How long a stored picture is kept: a month of conversation, longer than any thread a phone keeps open. */
export const INLINE_BLOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The most bytes the folder may hold; the oldest pictures go first. */
export const INLINE_BLOB_MAX_BYTES = 1024 * 1024 * 1024;

/** How many new pictures are written between two sweeps of the folder. */
const PRUNE_EVERY = 200;

/** A 64-hex name: what the blob route accepts and the only shape this module ever builds. */
const NAME_RE = /^[0-9a-f]{64}$/;

/** The route that serves the bytes (bridge/server.ts § BLOB_ROUTE), spelled as journal/pi.ts spells it. */
const BLOB_ROUTE_PREFIX = "/api/blobs/";

/** Where the pictures are kept, or null while the store is off (the default, and every test's). */
let directory: string | null = null;

/** Names known to be on disk, so a picture seen again costs one hash and no file access. */
const known = new Set<string>();

/** Names whose bytes are not a raster picture, so they are not decoded a second time. */
const notRaster = new Set<string>();

/** Pictures written since the last sweep. */
let written = 0;

/**
 * Turn the store on at `dir`, or off with null. The folder is made (mode 0700) and swept once; a
 * folder that cannot be made leaves the store off, so the bridge still starts and serves pictures inline.
 *
 * @param dir The folder to keep pictures in, or null to switch the store off.
 * @param now The clock, for the first sweep.
 */
export function configureInlineBlobs(dir: string | null, now: number = Date.now()): void {
  known.clear();
  notRaster.clear();
  written = 0;
  directory = null;
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  directory = dir;
  pruneInlineBlobs(now);
}

/**
 * The folder the store keeps pictures in, or null when it is off. The blob route searches it beside
 * pi's own blob folders.
 *
 * @returns The folder, or null.
 */
export function inlineBlobDir(): string | null {
  return directory;
}

/** Whether the first bytes are a PNG, a JPEG, a GIF or a WebP: the four types the blob route can name. */
export function isRasterPicture(head: Uint8Array): boolean {
  const at = (offset: number, bytes: readonly number[]): boolean =>
    bytes.every((byte, i) => head[offset + i] === byte);
  return (
    at(0, [0x89, 0x50, 0x4e, 0x47]) ||
    at(0, [0xff, 0xd8, 0xff]) ||
    at(0, [0x47, 0x49, 0x46]) ||
    (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]))
  );
}

/**
 * The short address of an inline picture, writing its bytes into the store the first time it is seen.
 *
 * @param data A journal image value: a `data:image/...;base64,` URL or bare base64 text.
 * @returns `/api/blobs/<hash>` when the picture now lives in the store, or null when it must stay
 *   inline (store off, too small, not base64, not a raster picture, or a write that failed).
 */
export function inlineBlobRef(data: string): string | null {
  const dir = directory;
  if (dir === null) return null;
  let payload = data;
  if (data.startsWith("data:")) {
    // Only the base64 form has bytes to store; a percent-encoded data URL is left as written.
    const comma = data.indexOf(";base64,");
    if (comma < 0 || comma > 128) return null;
    payload = data.slice(comma + ";base64,".length);
  }
  if (payload.length < INLINE_BLOB_MIN_CHARS) return null;
  const name = createHash("sha256").update(payload).digest("hex");
  if (known.has(name)) return `${BLOB_ROUTE_PREFIX}${name}`;
  if (notRaster.has(name)) return null;
  try {
    const path = join(dir, name);
    if (!fileExists(path)) {
      const bytes = Buffer.from(payload, "base64");
      if (!isRasterPicture(bytes.subarray(0, 12))) {
        notRaster.add(name);
        return null;
      }
      // Written beside its final name and moved in, so a reader never sees half a picture and a
      // crash leaves at worst a `.tmp` file that the next sweep removes.
      const staged = join(dir, `${name}.${process.pid}.tmp`);
      writeFileSync(staged, bytes, { mode: 0o600 });
      renameSync(staged, path);
      written += 1;
      if (written >= PRUNE_EVERY) {
        written = 0;
        pruneInlineBlobs(Date.now());
      }
    }
    if (known.size > 5000) known.clear();
    known.add(name);
    return `${BLOB_ROUTE_PREFIX}${name}`;
  } catch {
    return null;
  }
}

/** Whether a file is there, without reading it. */
function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweep the folder: remove stray `.tmp` files and pictures past their age, then the oldest pictures
 * until the folder is within its size limit. Every failure is swallowed: a sweep never breaks a read.
 *
 * @param now The clock, in milliseconds.
 * @param maxBytes The size limit; a parameter so a test can use a small one.
 * @returns How many files were removed.
 */
export function pruneInlineBlobs(now: number, maxBytes: number = INLINE_BLOB_MAX_BYTES): number {
  const dir = directory;
  if (dir === null) return 0;
  let removed = 0;
  try {
    const kept: { path: string; at: number; size: number }[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      try {
        // A staging file left by a crash is ours to remove. A name that is not a 64-hex hash was
        // never written by this module, so it is left alone.
        if (entry.endsWith(".tmp")) {
          rmSync(path, { force: true });
          removed += 1;
          continue;
        }
        if (!NAME_RE.test(entry)) continue;
        const info = statSync(path);
        if (now - info.mtimeMs > INLINE_BLOB_MAX_AGE_MS) {
          rmSync(path, { force: true });
          removed += 1;
          continue;
        }
        kept.push({ path, at: info.mtimeMs, size: info.size });
      } catch {
        // A file that vanished or cannot be read is skipped.
      }
    }
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    kept.sort((a, b) => a.at - b.at);
    for (const file of kept) {
      if (total <= maxBytes) break;
      rmSync(file.path, { force: true });
      total -= file.size;
      removed += 1;
    }
  } catch {
    // The folder cannot be listed: nothing to sweep.
  }
  // Names the sweep may have removed are no longer known to be there.
  known.clear();
  return removed;
}
