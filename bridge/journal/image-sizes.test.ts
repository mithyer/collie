import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImageSizeMemory, HEAD_BYTES, imageSizesOf, MAX_LOOKUPS } from "./image-sizes.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

// A PNG header: the signature, then the IHDR chunk with the width and height.
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

// A JPEG: the start marker, a metadata block of `padding` bytes, then a baseline frame header with the size.
function jpeg(width: number, height: number, padding = 0): Uint8Array {
  const meta = new Uint8Array(4 + padding);
  meta.set([0xff, 0xe1, ((padding + 2) >> 8) & 0xff, (padding + 2) & 0xff]);
  const frame = new Uint8Array(19);
  frame.set([0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return new Uint8Array([0xff, 0xd8, ...meta, ...frame]);
}

// A WebP of the lossy kind: RIFF header, "VP8 ", the frame tag and the 14-bit size fields.
function webp(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a]);
  new DataView(b.buffer).setUint16(26, width, true);
  new DataView(b.buffer).setUint16(28, height, true);
  return b;
}

const hashOf = (n: number): string => n.toString(16).padStart(64, "0");
const urlOf = (n: number): string => `/api/blobs/${hashOf(n)}`;

function turn(...urls: string[]): TranscriptEntry {
  return { uuid: "u", ts: "", role: "assistant", parts: urls.map((url): TranscriptPart => ({ kind: "image", url })) };
}

describe("picture sizes", () => {
  let root: string;
  let sessions: string;
  let blobs: string;

  beforeEach(() => {
    clearImageSizeMemory();
    root = mkdtempSync(join(tmpdir(), "image-sizes-"));
    sessions = join(root, "sessions");
    blobs = join(root, "blobs");
    mkdirSync(sessions);
    mkdirSync(blobs);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("reads a png, a jpeg and a webp header by the reference a turn carries", async () => {
    writeFileSync(join(blobs, hashOf(1)), png(600, 600));
    writeFileSync(join(blobs, hashOf(2)), jpeg(300, 500));
    writeFileSync(join(blobs, hashOf(3)), webp(800, 200));
    const sizes = await imageSizesOf([turn(urlOf(1), urlOf(2)), turn(urlOf(3))], [sessions]);
    expect(sizes).toEqual({
      [urlOf(1)]: { width: 600, height: 600 },
      [urlOf(2)]: { width: 300, height: 500 },
      [urlOf(3)]: { width: 800, height: 200 },
    });
  });

  test("finds a jpeg whose metadata is large, as long as the frame header is inside the head that is read", async () => {
    writeFileSync(join(blobs, hashOf(4)), jpeg(1024, 768, 40_000));
    expect(await imageSizesOf([turn(urlOf(4))], [sessions])).toEqual({ [urlOf(4)]: { width: 1024, height: 768 } });
    writeFileSync(join(blobs, hashOf(5)), jpeg(1024, 768, HEAD_BYTES + 10));
    // Past the head the frame is not seen: no size, never a guess.
    expect(await imageSizesOf([turn(urlOf(5))], [sessions])).toEqual({});
  });

  test("reads the picture a tool returned as well as an image part", async () => {
    writeFileSync(join(blobs, hashOf(6)), png(40, 30));
    const entry: TranscriptEntry = {
      uuid: "t",
      ts: "",
      role: "assistant",
      parts: [{ kind: "tool", name: "read", summary: "x", result: { text: "", imageUrl: urlOf(6) } }],
    };
    expect(await imageSizesOf([entry], [sessions])).toEqual({ [urlOf(6)]: { width: 40, height: 30 } });
  });

  test("leaves out what has no size: a missing blob, a file that is no picture, an inline address and a foreign reference", async () => {
    writeFileSync(join(blobs, hashOf(7)), new TextEncoder().encode("not a picture at all, just text that is long enough"));
    const entry = turn(urlOf(7), urlOf(8), "data:image/png;base64,AAAA", "https://example.invalid/x.png", "/api/blobs/../../etc/passwd");
    expect(await imageSizesOf([entry], [sessions])).toEqual({});
  });

  test("a blob that appears later is found later, one that was read is remembered", async () => {
    expect(await imageSizesOf([turn(urlOf(9))], [sessions])).toEqual({});
    writeFileSync(join(blobs, hashOf(9)), png(10, 20));
    expect(await imageSizesOf([turn(urlOf(9))], [sessions])).toEqual({ [urlOf(9)]: { width: 10, height: 20 } });
    // Gone from the disk, still answered: a hash names its bytes, so the size cannot have changed.
    rmSync(join(blobs, hashOf(9)));
    expect(await imageSizesOf([turn(urlOf(9))], [sessions])).toEqual({ [urlOf(9)]: { width: 10, height: 20 } });
  });

  test("asks about the newest pictures when a page holds more than the ceiling", async () => {
    const total = MAX_LOOKUPS + 5;
    const urls: string[] = [];
    for (let n = 100; n < 100 + total; n++) {
      writeFileSync(join(blobs, hashOf(n)), png(n, n));
      urls.push(urlOf(n));
    }
    const sizes = await imageSizesOf([turn(...urls)], [sessions]);
    expect(Object.keys(sizes).length).toBe(MAX_LOOKUPS);
    expect(sizes[urls[total - 1]!]).toBeDefined();
    expect(sizes[urls[0]!]).toBeUndefined();
  });

  test("a folder that cannot be read never fails the page", async () => {
    expect(await imageSizesOf([turn(urlOf(1))], [join(root, "no-such-folder", "sessions")])).toEqual({});
  });
});
