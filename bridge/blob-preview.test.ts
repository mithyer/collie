// The small WebP of a journal picture: the pure module (bridge/blob-preview.ts) on real pictures made with Bun.Image, and the
// route (`blobRoute` with `preview`) against a real blob store on disk.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { canPreview, makePreview, PREVIEW_EDGE, PREVIEW_MAX_PIXELS, PREVIEW_PARALLEL, PREVIEW_TYPE } from "./blob-preview.ts";
import { blobRoute } from "./server.ts";

const HASH = "a".repeat(64);

/** The folders made by a test, removed after it. */
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * One PNG chunk: length, type, data and the checksum of type plus data.
 * @param type The four-letter chunk type.
 * @param data The chunk's data.
 * @returns The bytes of the chunk.
 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A PNG with texture in it, written by hand: Bun.Image has no way in for raw pixels, and a flat colour compresses to nothing, so
 * every format would tie. A gradient with a pseudo-random speckle in the blue channel.
 * @param width Width in pixels.
 * @param height Height in pixels.
 * @returns The PNG file (8-bit RGB, no interlace).
 */
function texturedPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const rows = new Uint8Array((1 + width * 3) * height);
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      rows[row + 1 + x * 3] = (x * 255) / width;
      rows[row + 2 + x * 3] = (y * 255) / height;
      rows[row + 3 + x * 3] = (seed >> 8) & 0xff;
    }
  }
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  head[8] = 8; // bit depth
  head[9] = 2; // colour type: RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", new Uint8Array(deflateSync(rows))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Encode a test picture.
 * @param width Width in pixels.
 * @param height Height in pixels.
 * @param as The format to write.
 * @returns The encoded file.
 */
async function picture(width: number, height: number, as: "png" | "jpeg"): Promise<Uint8Array<ArrayBuffer>> {
  const png = texturedPng(width, height);
  return as === "png" ? png : new Uint8Array(await new Bun.Image(png).jpeg({ quality: 90 }).bytes());
}

/**
 * Read the size of an encoded picture.
 * @param bytes The file.
 * @returns Its format and size.
 */
async function sizeOf(bytes: Uint8Array): Promise<{ width: number; height: number; format: string }> {
  return await new Bun.Image(bytes).metadata();
}

/**
 * A pi-shaped blob store holding one file named by {@link HASH}.
 * @param bytes What the file holds.
 * @returns The roots to pass to `blobRoute`.
 */
async function storeWith(bytes: Uint8Array): Promise<string[]> {
  const base = await mkdtemp(join(tmpdir(), "collie-blob-preview-"));
  made.push(base);
  const sessions = join(base, "sessions");
  const blobs = join(base, "blobs");
  await mkdir(sessions, { recursive: true });
  await mkdir(blobs, { recursive: true });
  await Bun.write(join(blobs, HASH), bytes);
  return [sessions];
}

describe("makePreview", () => {
  test("a large PNG becomes a smaller WebP whose long edge is the preview edge", async () => {
    const png = await picture(2000, 1200, "png");
    const small = await makePreview(png, "image/png");
    expect(small).not.toBeNull();
    expect(small!.byteLength).toBeLessThan(png.byteLength);
    const meta = await sizeOf(small!);
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width, meta.height)).toBe(PREVIEW_EDGE);
    // The shape is kept: 2000 x 1200 is 5 : 3.
    expect(Math.abs(meta.width / meta.height - 2000 / 1200)).toBeLessThan(0.02);
  });

  test("a large JPEG becomes a smaller WebP too", async () => {
    const jpeg = await picture(2400, 1600, "jpeg");
    const small = await makePreview(jpeg, "image/jpeg");
    expect(small).not.toBeNull();
    expect(small!.byteLength).toBeLessThan(jpeg.byteLength);
    expect((await sizeOf(small!)).format).toBe("webp");
  });

  test("a picture that is already small is not enlarged", async () => {
    const png = await picture(300, 200, "png");
    const small = await makePreview(png, "image/png");
    // 300 x 200 of noise as a lossy WebP is smaller than the PNG, and it keeps its size.
    expect(small).not.toBeNull();
    const meta = await sizeOf(small!);
    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  test("only a still PNG or JPEG is converted", async () => {
    expect(canPreview("image/png")).toBe(true);
    expect(canPreview("image/jpeg")).toBe(true);
    expect(canPreview("image/gif")).toBe(false);
    expect(canPreview("image/webp")).toBe(false);
    expect(canPreview("application/octet-stream")).toBe(false);
    const png = await picture(1500, 900, "png");
    expect(await makePreview(png, "image/gif")).toBeNull();
    expect(await makePreview(png, "image/webp")).toBeNull();
  });

  test("bytes that are not a picture, or a truncated one, give nothing and do not throw", async () => {
    expect(await makePreview(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "image/png")).toBeNull();
    const png = await picture(1500, 900, "png");
    expect(await makePreview(png.subarray(0, 200), "image/png")).toBeNull();
  });

  test("a canvas over the pixel limit is refused before it is decoded", async () => {
    // A PNG whose header claims 8000 x 6000 (48 million pixels, over the limit) over a few real rows.
    const png = await picture(64, 64, "png");
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    // IHDR starts at byte 8 (length 4 + "IHDR" 4); width at 16, height at 20. The chunk checksum is not checked by the header read.
    view.setUint32(16, 8000);
    view.setUint32(20, 6000);
    expect(8000 * 6000).toBeGreaterThan(PREVIEW_MAX_PIXELS);
    expect(await makePreview(png, "image/png")).toBeNull();
  });

  test("a result that is not smaller than the stored file is not used", async () => {
    // A tiny, already well-compressed JPEG: a WebP of it would be about the same or bigger.
    const tiny = await new Bun.Image(texturedPng(16, 16)).jpeg({ quality: 20 }).bytes();
    const small = await makePreview(tiny, "image/jpeg");
    // Either nothing (the original is served) or something strictly smaller; never a bigger file.
    expect(small === null || small.byteLength < tiny.byteLength).toBe(true);
  });

  test("a thread of pictures is converted without more than the allowed number at once", async () => {
    const png = await picture(1400, 900, "png");
    const answers = await Promise.all(Array.from({ length: PREVIEW_PARALLEL * 3 }, () => makePreview(png, "image/png")));
    expect(answers.every((a) => a !== null && a.byteLength < png.byteLength)).toBe(true);
  });
});

describe("GET /api/blobs/<hash>?view=preview", () => {
  test("without the query the original comes back byte for byte", async () => {
    const png = await picture(1800, 1100, "png");
    const roots = await storeWith(png);
    const res = await blobRoute(HASH, roots);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  test("with the query a large PNG comes back as a smaller WebP", async () => {
    const png = await picture(1800, 1100, "png");
    const roots = await storeWith(png);
    const res = await blobRoute(HASH, roots, { preview: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PREVIEW_TYPE);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBeNull();
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBeLessThan(png.byteLength);
    // RIFF....WEBP
    expect(String.fromCharCode(...body.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...body.subarray(8, 12))).toBe("WEBP");
  });

  test("with the query a file that cannot be made smaller comes back as it is", async () => {
    // Not a decodable picture, but with a PNG signature: the sniffed type says PNG, the conversion fails, the original is served.
    const odd = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const roots = await storeWith(odd);
    const res = await blobRoute(HASH, roots, { preview: true });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(odd);
  });

  test("with the query a GIF comes back as it is", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
    const roots = await storeWith(gif);
    const res = await blobRoute(HASH, roots, { preview: true });
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(gif);
  });

  test("the refusals do not change with the query", async () => {
    const roots = await storeWith(await picture(200, 200, "png"));
    expect((await blobRoute("not-a-hash", roots, { preview: true })).status).toBe(400);
    expect((await blobRoute("b".repeat(64), roots, { preview: true })).status).toBe(404);
  });
});
