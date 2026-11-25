import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findReusable,
  holdBlob,
  isReuseAsk,
  parseBlobAsk,
  parseReuseAsk,
  REUSE_MAX_HASHED,
  type ReuseFs,
} from "./upload-reuse.ts";

const MAX = 10 * 1024 * 1024;
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("isReuseAsk", () => {
  test("a JSON body is a question; a multipart form and anything else is an upload", () => {
    expect(isReuseAsk("application/json")).toBe(true);
    expect(isReuseAsk("application/json; charset=utf-8")).toBe(true);
    expect(isReuseAsk(" Application/JSON ")).toBe(true);
    expect(isReuseAsk("multipart/form-data; boundary=x")).toBe(false);
    expect(isReuseAsk("application/jsonp")).toBe(false);
    expect(isReuseAsk(null)).toBe(false);
  });
});

describe("parseReuseAsk", () => {
  const hash = "a".repeat(64);

  test("reads a sha256 and a size, and lowercases the hash", () => {
    expect(parseReuseAsk(JSON.stringify({ sha256: hash.toUpperCase(), size: 1234 }), MAX)).toEqual({ sha256: hash, size: 1234 });
  });

  test("refuses a hash that is not 64 hex characters", () => {
    for (const bad of ["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), 7, null]) {
      expect(parseReuseAsk(JSON.stringify({ sha256: bad, size: 10 }), MAX)).toBeNull();
    }
  });

  test("refuses a size that is not a whole number from 1 up to the cap", () => {
    for (const bad of [0, -1, 1.5, MAX + 1, "10", null, Number.NaN]) {
      expect(parseReuseAsk(JSON.stringify({ sha256: hash, size: bad }), MAX)).toBeNull();
    }
    expect(parseReuseAsk(JSON.stringify({ sha256: hash, size: MAX }), MAX)).not.toBeNull();
  });

  test("refuses text that is not an object, and a body that is too long", () => {
    expect(parseReuseAsk("not json", MAX)).toBeNull();
    expect(parseReuseAsk("[]", MAX)).toBeNull();
    expect(parseReuseAsk("null", MAX)).toBeNull();
    expect(parseReuseAsk(JSON.stringify({ sha256: hash, size: 10, pad: "x".repeat(600) }), MAX)).toBeNull();
  });
});

describe("findReusable", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function folder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "collie-reuse-"));
    dirs.push(dir);
    return dir;
  }
  /** A file under the name the upload route makes, so the lookup considers it. */
  async function upload(dir: string, tag: string, bytes: string): Promise<string> {
    const path = join(dir, `w1_p1-${tag}-0123abcd.png`);
    await writeFile(path, bytes);
    return path;
  }

  test("finds the file whose bytes match and answers its own path", async () => {
    const dir = await folder();
    const path = await upload(dir, "k1", "first picture");
    await upload(dir, "k2", "other picture");
    expect(await findReusable(dir, { sha256: sha("first picture"), size: "first picture".length })).toBe(path);
  });

  test("a file of the same size with other bytes is not a match", async () => {
    const dir = await folder();
    await upload(dir, "k1", "aaaa");
    expect(await findReusable(dir, { sha256: sha("bbbb"), size: 4 })).toBeNull();
  });

  test("the size alone decides which files are read: a file of another size is never hashed", async () => {
    const hashed: string[] = [];
    const fs: ReuseFs = {
      list: async () => ["w1_p1-k1-0123abcd.png", "w1_p1-k2-0123abcd.png"],
      stat: async (path) => ({ size: path.includes("k1") ? 5 : 9, mtimeMs: 1 }),
      sha256: async (path) => {
        hashed.push(path);
        return "f".repeat(64);
      },
      touch: async () => {},
    };
    await findReusable("/u", { sha256: "f".repeat(64), size: 9 }, fs);
    expect(hashed).toEqual(["/u/w1_p1-k2-0123abcd.png"]);
  });

  test("only names the upload route could have made are considered", async () => {
    const dir = await folder();
    await writeFile(join(dir, "notes.png"), "same");
    await writeFile(join(dir, ".hidden"), "same");
    await writeFile(join(dir, "w1_p1-k1-zzzzzzzz.png"), "same");
    expect(await findReusable(dir, { sha256: sha("same"), size: 4 })).toBeNull();
  });

  test("a link is not a file: it is skipped even when it points at matching bytes", async () => {
    const dir = await folder();
    const real = join(dir, "elsewhere.dat");
    await writeFile(real, "target");
    await symlink(real, join(dir, "w1_p1-k1-0123abcd.png"));
    expect(await findReusable(dir, { sha256: sha("target"), size: 6 })).toBeNull();
  });

  test("a folder that does not exist holds nothing", async () => {
    const dir = await folder();
    expect(await findReusable(join(dir, "missing"), { sha256: "0".repeat(64), size: 3 })).toBeNull();
  });

  test("the newest equal-size files are read first, and no more than the limit", async () => {
    const names = Array.from({ length: REUSE_MAX_HASHED + 4 }, (_, i) => `w1_p1-k${i}-0123abcd.png`);
    const hashed: string[] = [];
    const fs: ReuseFs = {
      list: async () => names,
      stat: async (path) => ({ size: 7, mtimeMs: Number(path.match(/k(\d+)-/)?.[1]) }),
      sha256: async (path) => {
        hashed.push(path);
        return null;
      },
      touch: async () => {},
    };
    await findReusable("/u", { sha256: "f".repeat(64), size: 7 }, fs);
    expect(hashed).toHaveLength(REUSE_MAX_HASHED);
    expect(hashed[0]).toBe(`/u/w1_p1-k${names.length - 1}-0123abcd.png`);
  });

  test("a hit refreshes the file's time so the sweep does not take it at once", async () => {
    const dir = await folder();
    const path = await upload(dir, "k1", "keep me");
    const old = new Date(Date.now() - 47 * 60 * 60 * 1000);
    await utimes(path, old, old);
    await findReusable(dir, { sha256: sha("keep me"), size: 7 });
    expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(60 * 1000);
  });

  test("a miss leaves every file's time alone", async () => {
    const dir = await folder();
    const path = await upload(dir, "k1", "leave me");
    const old = new Date(Date.now() - 47 * 60 * 60 * 1000);
    await utimes(path, old, old);
    await findReusable(dir, { sha256: sha("something else"), size: 8 });
    expect(Math.abs((await stat(path)).mtimeMs - old.getTime())).toBeLessThan(2000);
  });
});

describe("parseBlobAsk", () => {
  const hash = "b".repeat(64);

  test("reads a blob hash and lowercases it", () => {
    expect(parseBlobAsk(JSON.stringify({ blob: hash.toUpperCase() }))).toBe(hash);
  });

  test("refuses anything that is not a 64-hex blob name", () => {
    for (const bad of ["", "abc", "../".repeat(22), "g".repeat(64), "b".repeat(63), 7, null, ["b".repeat(64)]]) {
      expect(parseBlobAsk(JSON.stringify({ blob: bad }))).toBeNull();
    }
    expect(parseBlobAsk("not json")).toBeNull();
    expect(parseBlobAsk(JSON.stringify([hash]))).toBeNull();
    expect(parseBlobAsk(JSON.stringify({ blob: hash, pad: "x".repeat(600) }))).toBeNull();
  });

  test("the other question is not a blob question", () => {
    expect(parseBlobAsk(JSON.stringify({ sha256: hash, size: 10 }))).toBeNull();
  });
});

describe("holdBlob", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

  async function setup(bytes: Uint8Array): Promise<{ root: string; source: string; dir: string }> {
    const root = await mkdtemp(join(tmpdir(), "hold-blob-"));
    dirs.push(root);
    const source = join(root, "blob");
    await writeFile(source, bytes);
    return { root, source, dir: join(root, "uploads") };
  }

  test("copies a picture into the uploads folder under a name of the upload shape, owner-only", async () => {
    const { source, dir } = await setup(PNG);
    const path = await holdBlob({ source, dir, paneId: "t1", maxBytes: MAX, now: 1_700_000_000_000, nonce: "0a1b2c3d" });
    expect(path).toBe(join(dir, `t1-${(1_700_000_000_000).toString(36)}-0a1b2c3d.png`));
    expect(sha(new Uint8Array(await Bun.file(path ?? "").arrayBuffer()))).toBe(sha(PNG));
    expect(((await stat(path ?? "")).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe("700");
  });

  test("asking twice makes one file: the second answer is the first copy", async () => {
    const { source, dir } = await setup(PNG);
    const first = await holdBlob({ source, dir, paneId: "t1", maxBytes: MAX });
    const second = await holdBlob({ source, dir, paneId: "t2", maxBytes: MAX });
    expect(second).toBe(first);
  });

  test("a file that is not a picture by its bytes is a miss", async () => {
    const { source, dir } = await setup(new TextEncoder().encode("just some words in a file"));
    expect(await holdBlob({ source, dir, paneId: "t1", maxBytes: MAX })).toBeNull();
  });

  test("an empty file and one over the size limit are misses", async () => {
    const empty = await setup(new Uint8Array());
    expect(await holdBlob({ source: empty.source, dir: empty.dir, paneId: "t1", maxBytes: MAX })).toBeNull();
    const big = await setup(PNG);
    expect(await holdBlob({ source: big.source, dir: big.dir, paneId: "t1", maxBytes: PNG.byteLength - 1 })).toBeNull();
  });

  test("a source that is not there is a miss", async () => {
    const { root, dir } = await setup(PNG);
    expect(await holdBlob({ source: join(root, "nothing"), dir, paneId: "t1", maxBytes: MAX })).toBeNull();
  });

  test("the pane only becomes part of the name after its odd characters are replaced", async () => {
    const { source, dir } = await setup(PNG);
    const path = await holdBlob({ source, dir, paneId: "../x y", maxBytes: MAX, nonce: "deadbeef" });
    expect(path === null ? "" : path.slice(dir.length + 1)).toMatch(/^___x_y-[0-9a-z]+-deadbeef\.png$/);
  });
});
