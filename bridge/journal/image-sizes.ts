// The width and height of the pictures a history page names, read off each picture's header on this machine.
//
// WHY. A page that draws a stand-in for a picture (the Dogr app does) wants the picture's real shape before it has
// the picture: the screen text only says how many rows pi kept for it, and a tall or square picture fills the same 30
// rows whatever its width. The bridge holds the bytes, and a header is a few dozen bytes (PNG, WebP) or a few
// kilobytes (JPEG), so it answers in the history page that is read anyway: nothing extra goes over the link, the
// phone asks for no second route, and a bridge that predates this simply leaves the key out.
//
// WHAT IS READ. Only a reference of the form `/api/blobs/<64 hex>` (journal/pi.ts § resolveImage: pi's own blobs and the
// big inline pictures the bridge moved into its store), found through the SAME folders and the SAME containment check
// the blob route uses (`resolveBlobPath`). The first {@link HEAD_BYTES} bytes are read, never the whole file. A small
// inline picture (a `data:` address) is not looked at: it travels in the page itself and shows at once.
//
// NOTHING HERE MAY FAIL A READ. A missing file, an unreadable one and a header that gives no size are all "no size".
// TEST:journal/image-sizes.test.ts[picture sizes]

import { hillImageMime, hillImageSize } from "../hill/media.ts";
import { isBlobHash, resolveBlobPath } from "./pi.ts";
import type { TranscriptEntry } from "./types.ts";

/** The pixel size of a picture. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** How many leading bytes are read per picture: all of a PNG or WebP header, and room for a JPEG's metadata before its frame. */
export const HEAD_BYTES = 64 * 1024;

/** The most pictures one page is asked about; a page of 40 turns holds a handful, so this is only a ceiling. */
export const MAX_LOOKUPS = 64;

/** The folder-and-hash form a picture reference must have to be looked at. */
const BLOB_URL_RE = /^\/api\/blobs\/([0-9a-f]{64})$/;

/** The largest the memory may grow to (hashes are content addresses, so a remembered size never goes stale). */
const MEMORY_MAX = 4000;

/** Sizes already read, by hash; `null` is a file that was found and has no size in its header. */
const memory = new Map<string, ImageSize | null>();

/** Forget every remembered size. Tests call it; a running bridge never needs to.
 * @returns Nothing.
 */
export function clearImageSizeMemory(): void {
  memory.clear();
}

/** The blob references of a list of turns, in the order written and without repeats: image parts and a tool result's picture. */
function blobReferences(entries: readonly TranscriptEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const part of entry.parts) {
      const url = part.kind === "image" ? part.url : part.kind === "tool" ? part.result?.imageUrl : undefined;
      if (url !== undefined && BLOB_URL_RE.test(url)) seen.add(url);
    }
  }
  return [...seen];
}

/** Read the size of one blob, or null when there is none to give. A file that was found is remembered either way. */
async function readSize(hash: string, sessionRoots: readonly string[]): Promise<ImageSize | null> {
  if (memory.has(hash)) return memory.get(hash) ?? null;
  const path = await resolveBlobPath(hash, sessionRoots);
  // A blob that is not there now may be there later, so only a file that was really read is remembered.
  if (path === null) return null;
  let size: ImageSize | null = null;
  try {
    const head = new Uint8Array(await Bun.file(path).slice(0, HEAD_BYTES).arrayBuffer());
    const mime = hillImageMime(head);
    size = mime === null ? null : hillImageSize(head, mime);
  } catch {
    return null;
  }
  if (memory.size >= MEMORY_MAX) memory.clear();
  memory.set(hash, size);
  return size;
}

/**
 * The sizes of the pictures a page of turns names, keyed by the reference exactly as the turn carries it.
 *
 * @param entries The turns of one history page.
 * @param sessionRoots The agent's session folders, the blob route's own argument (its `blobs/` sibling is searched).
 * @returns A reference to its size for every picture whose header gave one; an empty object when none did.
 * TEST:journal/image-sizes.test.ts[picture sizes]
 */
export async function imageSizesOf(
  entries: readonly TranscriptEntry[],
  sessionRoots: readonly string[],
): Promise<Record<string, ImageSize>> {
  const sizes: Record<string, ImageSize> = {};
  try {
    // The newest pictures are the ones the page matches to the screen (it counts from the end), so the ceiling cuts the oldest.
    for (const url of blobReferences(entries).slice(-MAX_LOOKUPS)) {
      const hash = url.slice(url.lastIndexOf("/") + 1);
      if (!isBlobHash(hash)) continue;
      const size = await readSize(hash, sessionRoots);
      if (size !== null) sizes[url] = { width: size.width, height: size.height };
    }
  } catch {
    // A page is never refused because a size could not be read.
  }
  return sizes;
}
