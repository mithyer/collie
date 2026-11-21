import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blobRoute, sniffBlobType } from "../server.ts";
import {
  configureInlineBlobs,
  INLINE_BLOB_MAX_AGE_MS,
  INLINE_BLOB_MIN_CHARS,
  inlineBlobDir,
  inlineBlobRef,
  isRasterPicture,
  pruneInlineBlobs,
} from "./inline-blobs.ts";
import { resolveBlobPath, resolveImage, resolveImageUrl } from "./pi.ts";

/** A made-up picture: the real PNG signature, then filler that differs by `seed`, `size` bytes long. */
function picture(size: number, seed: number, head: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]): Buffer {
  const bytes = Buffer.alloc(size, seed % 251);
  bytes.set(head, 0);
  bytes.writeUInt32LE(seed, 16);
  return bytes;
}

const BIG = Math.ceil((INLINE_BLOB_MIN_CHARS * 3) / 4) + 2000;
const ROUTE = /^\/api\/blobs\/[0-9a-f]{64}$/;

let root = "";
let store = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "collie-inline-blobs-"));
  store = join(root, "inline-blobs");
});

afterEach(() => {
  configureInlineBlobs(null);
  rmSync(root, { recursive: true, force: true });
});

describe("a picture a journal carries inline", () => {
  test("stays inline while the store is off", () => {
    const data = `data:image/png;base64,${picture(BIG, 1).toString("base64")}`;
    expect(inlineBlobDir()).toBeNull();
    expect(resolveImageUrl(data)).toBe(data);
    expect(inlineBlobRef(data)).toBeNull();
  });

  test("a big png becomes a short address and its bytes are kept once", () => {
    configureInlineBlobs(store);
    const bytes = picture(BIG, 2);
    const data = `data:image/png;base64,${bytes.toString("base64")}`;
    const url = resolveImageUrl(data);
    expect(url).toMatch(ROUTE);
    // Seen again, it is the same address and still one file.
    expect(resolveImageUrl(data)).toBe(url);
    const name = url!.slice("/api/blobs/".length);
    expect(readdirSync(store)).toEqual([name]);
    expect(readFileSync(join(store, name)).equals(bytes)).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(store, name)).mode & 0o777).toBe(0o600);
  });

  test("bare base64 beside an image mime type is taken the same way", () => {
    configureInlineBlobs(store);
    const text = picture(BIG, 3, [0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    expect(resolveImage(text, "image/jpeg")).toEqual({ url: expect.stringMatching(ROUTE) });
  });

  test("wrapped base64 (line breaks) decodes to the same bytes", () => {
    configureInlineBlobs(store);
    const bytes = picture(BIG, 4);
    const wrapped = bytes.toString("base64").replace(/(.{76})/g, "$1\n");
    const url = resolveImageUrl(`data:image/png;base64,${wrapped}`)!;
    expect(url).toMatch(ROUTE);
    expect(readFileSync(join(store, url.slice("/api/blobs/".length))).equals(bytes)).toBe(true);
  });

  test("a small picture, a vector picture and a non-base64 payload stay as written", () => {
    configureInlineBlobs(store);
    const small = `data:image/png;base64,${picture(2000, 5).toString("base64")}`;
    expect(resolveImageUrl(small)).toBe(small);
    const svg = Buffer.concat([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'>"), Buffer.alloc(BIG, 0x20)]);
    const vector = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    expect(resolveImageUrl(vector)).toBe(vector);
    // The same text again does not decode a second time and still stays inline.
    expect(resolveImageUrl(vector)).toBe(vector);
    const escaped = `data:image/png,${"%89PNG".repeat(INLINE_BLOB_MIN_CHARS)}`;
    expect(resolveImageUrl(escaped)).toBe(escaped);
    expect(readdirSync(store)).toEqual([]);
  });

  test("a write that fails leaves the picture inline", () => {
    configureInlineBlobs(store);
    // The folder turns into a file after set-up: every write now fails.
    rmSync(store, { recursive: true });
    writeFileSync(store, "not a folder");
    const data = `data:image/png;base64,${picture(BIG, 6).toString("base64")}`;
    expect(resolveImageUrl(data)).toBe(data);
  });

  test("the blob route serves it, found beside the agent's own blob folders", async () => {
    configureInlineBlobs(store);
    const bytes = picture(BIG, 7);
    const url = resolveImageUrl(`data:image/png;base64,${bytes.toString("base64")}`)!;
    const hash = url.slice("/api/blobs/".length);
    const sessions = join(root, "agent", "sessions");
    mkdirSync(sessions, { recursive: true });
    expect(await resolveBlobPath(hash, [sessions])).not.toBeNull();
    const answer = await blobRoute(hash, [sessions]);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await answer.arrayBuffer()).equals(bytes)).toBe(true);
    // A hash nobody stored is still a 404, and the store is not searched while it is off.
    expect((await blobRoute("a".repeat(64), [sessions])).status).toBe(404);
    configureInlineBlobs(null);
    expect(await resolveBlobPath(hash, [sessions])).toBeNull();
  });

  test("a store whose folder cannot be made stays off", () => {
    writeFileSync(store, "in the way");
    configureInlineBlobs(join(store, "below"));
    expect(inlineBlobDir()).toBeNull();
  });
});

describe("what the store keeps and for how long", () => {
  const named = (n: number): string => n.toString(16).padStart(64, "0");

  test("a stray staging file and a stale picture go, a foreign name stays", () => {
    configureInlineBlobs(store);
    const now = Date.now();
    writeFileSync(join(store, `${named(1)}.123.tmp`), "half");
    writeFileSync(join(store, named(2)), "fresh");
    writeFileSync(join(store, named(3)), "old");
    writeFileSync(join(store, "notes.txt"), "not ours");
    const old = new Date(now - INLINE_BLOB_MAX_AGE_MS - 60_000);
    utimesSync(join(store, named(3)), old, old);
    expect(pruneInlineBlobs(now)).toBe(2);
    expect(readdirSync(store).toSorted()).toEqual([named(2), "notes.txt"].toSorted());
  });

  test("the oldest pictures go first when the folder is over its limit", () => {
    configureInlineBlobs(store);
    const now = Date.now();
    for (const [n, age] of [[1, 3000], [2, 2000], [3, 1000]] as const) {
      writeFileSync(join(store, named(n)), "x".repeat(100));
      const at = new Date(now - age);
      utimesSync(join(store, named(n)), at, at);
    }
    expect(pruneInlineBlobs(now, 250)).toBe(1);
    expect(existsSync(join(store, named(1)))).toBe(false);
    expect(existsSync(join(store, named(2)))).toBe(true);
    expect(existsSync(join(store, named(3)))).toBe(true);
  });

  test("a picture removed by a sweep is written again when the journal shows it again", () => {
    configureInlineBlobs(store);
    const data = `data:image/png;base64,${picture(BIG, 8).toString("base64")}`;
    const url = resolveImageUrl(data)!;
    rmSync(join(store, url.slice("/api/blobs/".length)));
    pruneInlineBlobs(Date.now());
    expect(resolveImageUrl(data)).toBe(url);
    expect(readdirSync(store)).toEqual([url.slice("/api/blobs/".length)]);
  });
});

describe("isRasterPicture", () => {
  const heads: readonly (readonly [string, number[], boolean])[] = [
    ["png", [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0], true],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0], true],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0], true],
    ["webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], true],
    ["a wave file (RIFF without WEBP)", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], false],
    ["svg text", [0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0x6e, 0x73, 0x3d, 0x27], false],
    ["empty", [], false],
  ];

  test.each(heads)("%s", (_name, head, expected) => {
    const bytes = new Uint8Array(head);
    expect(isRasterPicture(bytes)).toBe(expected);
    // The blob route answers a real image type for exactly the heads this module accepts.
    expect(sniffBlobType(bytes) !== "application/octet-stream").toBe(expected);
  });
});
