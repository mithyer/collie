import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hostFor } from "../bridge/host.ts";
import { type FakeFiles, fakeExec, fakeFiles } from "./fakes.ts";
import { refreshRunner, RUNNER_IDENTIFIER, runnerPath } from "./stable-runner.ts";

// The stable copy exists so macOS keeps its per-program privacy answers across an update: a program
// is known to the system by its absolute path plus a code requirement, so the path must not change
// and the signature must name the program rather than one file (cli/stable-runner.ts has the
// measurements). These tests pin the path rule, the replacement rules and the release workflow.

const DARWIN = hostFor("darwin");
const INSTALL = "/home/pat/.local/share/collie";
const ROOT = `${INSTALL}/versions/1.2.3`;
const SOURCE = `${ROOT}/bin/collie`;
const RUNNER = `${INSTALL}/runner/bin/collie`;

/** How the `cp` the code asks for behaves in one test. */
interface CopyBehaviour {
  /** `cp -c` (clone) is refused, as on a volume that cannot clone. */
  cloneFails?: boolean;
  /** Every copy is refused. */
  allFail?: boolean;
  /** The copy lands with other bytes than the source: a torn copy. */
  tear?: boolean;
}

/** A `cp` that does what the real one would to the fake file system, and records what was asked. */
function world(seed: Record<string, string>, how: CopyBehaviour = {}) {
  const files: FakeFiles = fakeFiles(seed);
  const exec = fakeExec();
  const copies: string[] = [];
  const capture = exec.capture.bind(exec);
  exec.capture = (tool, args, ...rest) => {
    if (tool !== "cp") return capture(tool, args, ...rest);
    copies.push(`${tool} ${args.join(" ")}`);
    const clone = args[0] === "-c";
    if (how.allFail === true || (clone && how.cloneFails === true)) {
      return { found: true, code: 1, stdout: "", stderr: "cp: failed" };
    }
    const from = args.at(-2)!;
    const to = args.at(-1)!;
    files.write(to, how.tear === true ? "torn" : (files.read(from) ?? ""));
    return { found: true, code: 0, stdout: "", stderr: "" };
  };
  return { files, exec, copies };
}

describe("where the stable copy lives", () => {
  test("a macOS binary install gets one beside versions/ and current", () => {
    expect(runnerPath(ROOT, DARWIN)).toBe(RUNNER);
  });

  test("a checkout, Linux and Windows get none", () => {
    // A checkout has no versions/ folder: its root is its own place.
    expect(runnerPath("/Users/pat/src/collie", DARWIN)).toBeNull();
    expect(runnerPath(ROOT, hostFor("linux"))).toBeNull();
    expect(runnerPath("C:\\collie\\versions\\1.2.3", hostFor("win32"))).toBeNull();
  });

  test("the path does not depend on the version", () => {
    expect(runnerPath(`${INSTALL}/versions/9.9.9`, DARWIN)).toBe(RUNNER);
  });
});

describe("refreshing the stable copy", () => {
  test("a missing copy is made from the binary of this version", () => {
    const w = world({ [SOURCE]: "v1-bytes" });
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBe(RUNNER);
    expect(w.files.read(RUNNER)).toBe("v1-bytes");
    // Cloned first: on APFS that costs no second copy on disk.
    expect(w.copies).toEqual([`cp -c ${SOURCE} ${RUNNER}.new`]);
    // The staging name is gone once the copy is in place.
    expect(w.files.exists(`${RUNNER}.new`)).toBe(false);
  });

  test("a copy that already holds these bytes is left alone", () => {
    const w = world({ [SOURCE]: "v1-bytes", [RUNNER]: "v1-bytes" });
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBe(RUNNER);
    // No copy, no rename: a running bridge keeps the very file it holds.
    expect(w.copies).toEqual([]);
    expect(w.files.ops).toEqual([]);
  });

  test("a copy of an older version is replaced by a rename, never overwritten in place", () => {
    const w = world({ [SOURCE]: "v2-bytes", [RUNNER]: "v1-bytes" });
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBe(RUNNER);
    expect(w.files.read(RUNNER)).toBe("v2-bytes");
    // The rename gives the path a new file: a bridge still running the old one keeps its own, whose
    // signed pages macOS would otherwise find changed under it.
    expect(w.files.ops).toContain(`mv ${RUNNER}.new ${RUNNER}`);
  });

  test("a volume that cannot clone falls back to a plain copy", () => {
    const w = world({ [SOURCE]: "v1-bytes" }, { cloneFails: true });
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBe(RUNNER);
    expect(w.copies).toEqual([`cp -c ${SOURCE} ${RUNNER}.new`, `cp ${SOURCE} ${RUNNER}.new`]);
    expect(w.files.read(RUNNER)).toBe("v1-bytes");
  });

  test("a copy that fails keeps the old one and says there is none to run", () => {
    const w = world({ [SOURCE]: "v2-bytes", [RUNNER]: "v1-bytes" }, { allFail: true });
    // null: the caller keeps running the version folder's own binary, which is how every install
    // ran before the copy existed. A failed copy may cost a repeated dialog, never a bridge.
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBeNull();
    expect(w.files.read(RUNNER)).toBe("v1-bytes");
    expect(w.files.exists(`${RUNNER}.new`)).toBe(false);
  });

  test("a torn copy never replaces a good one", () => {
    const w = world({ [SOURCE]: "v2-bytes", [RUNNER]: "v1-bytes" }, { tear: true });
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBeNull();
    expect(w.files.read(RUNNER)).toBe("v1-bytes");
    expect(w.files.exists(`${RUNNER}.new`)).toBe(false);
  });

  test("a version folder with no binary has nothing to copy", () => {
    const w = world({});
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, ROOT)).toBeNull();
    expect(w.copies).toEqual([]);
  });

  test("a checkout or another platform copies nothing", () => {
    const w = world({ "/Users/pat/src/collie/bin/collie": "bytes", [SOURCE]: "bytes" });
    expect(refreshRunner({ files: w.files, exec: w.exec, host: DARWIN }, "/Users/pat/src/collie")).toBeNull();
    expect(refreshRunner({ files: w.files, exec: w.exec, host: hostFor("linux") }, ROOT)).toBeNull();
    expect(w.copies).toEqual([]);
  });
});

describe("the release workflow signs what this code expects", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "dogr-release.yml"), "utf8");

  test("macOS binaries carry the fixed identifier and a requirement that names only it", () => {
    // Both halves: the default ad-hoc requirement names one exact file hash, so a rebuilt binary at
    // the very same path would still be a new program to the system.
    expect(workflow).toContain(`--identifier ${RUNNER_IDENTIFIER}`);
    expect(workflow).toContain(`-r='designated => identifier "${RUNNER_IDENTIFIER}"'`);
  });

  test("a release whose binary was signed another way is refused", () => {
    expect(workflow).toContain(`grep -qF 'designated => identifier "${RUNNER_IDENTIFIER}"'`);
  });
});
