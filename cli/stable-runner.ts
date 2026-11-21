import { collieBinary, type Host } from "../bridge/host.ts";
import type { Exec, Files } from "./sys.ts";

// A STABLE COPY OF THE BINARY FOR LAUNCHD TO RUN (macOS only; a Dogr addition, not upstream).
//
// WHY. macOS keeps its per-program privacy answers (the "would like to access files in your
// Documents folder" dialog) in a table whose key, for a program that is not inside an app bundle, is
// the program's ABSOLUTE PATH plus a code requirement. A binary install runs the bridge from
// `<install-root>/versions/<version>/bin/collie`, so every update made a brand-new program in the
// system's eyes and the dialog came back after every update. Measured on 2026-11-21 with a scratch
// program (herdogr-v2 `collie-mac-permission-prompt.md`): same path + same code requirement, a
// different file replaced in place -> no new dialog; the default ad-hoc requirement (it names one
// exact file hash) -> dialog again.
//
// WHAT. The launch agent runs `<install-root>/runner/bin/collie`, a copy that only ever changes its
// contents, never its path. The release workflow signs every macOS binary with the same identifier
// and the requirement "identifier only" (`.github/workflows/dogr-release.yml`), so the answer the
// person gave once keeps matching after each update. `current/` and `versions/` are untouched: the
// copy is the program that runs, the version folder is still the root that holds `web/dist` and the
// manifest (the plist hands that over in `COLLIE_PLUGIN_ROOT`).
//
// HOW IT IS REPLACED. Written next to the target and renamed over it, so the target always gets a NEW
// inode: a bridge that still runs the old copy keeps its old file (macOS kills a process whose
// signed pages change under it, which an in-place overwrite would do).
//
// TEST:cli/stable-runner.test.ts

/** The folder that holds the stable copy, beside `versions/` and `current`. */
export const RUNNER_DIR = "runner";

/** The identifier the release workflow signs macOS binaries with. Pinned here so a test can check the workflow against it. */
export const RUNNER_IDENTIFIER = "dev.dogr.collie";

/**
 * Where the stable copy of a binary install lives, or `null` when this install gets none.
 *
 * Only macOS, and only a binary install (its root is `<install-root>/versions/<version>`): a checkout
 * has no `versions` folder and Linux and Windows have no such per-path privacy table.
 *
 * @param root The Collie root of this process (a version folder on a binary install).
 * @param host The platform rules to read the path with.
 * @returns `<install-root>/runner/bin/collie`, or `null`.
 */
export function runnerPath(root: string, host: Host): string | null {
  if (host.platform !== "darwin") return null;
  const { dirname, basename, join } = host.path;
  const versionsDir = dirname(root);
  if (basename(versionsDir) !== "versions") return null;
  return collieBinary(join(dirname(versionsDir), RUNNER_DIR), host);
}

/** The slice of the CLI's seams this needs; both are already part of `LifecycleDeps`. */
export interface RunnerDeps {
  files: Files;
  exec: Exec;
  host: Host;
}

/**
 * Make sure the stable copy holds exactly the binary of `root`, and say where it is.
 *
 * Every failure answers `null` and leaves the old copy alone: the caller then runs the version
 * folder's own binary, which is how every install ran before this existed, so a failed copy can cost
 * a repeated privacy dialog but never a bridge that does not start.
 *
 * @param deps The file and process seams.
 * @param root The Collie root of this process.
 * @returns The path the launch agent should run, or `null` when this install keeps running `<root>/bin/collie`.
 */
export function refreshRunner(deps: RunnerDeps, root: string): string | null {
  const target = runnerPath(root, deps.host);
  if (target === null) return null;
  const source = collieBinary(root, deps.host);
  const wanted = deps.files.digest(source);
  if (wanted === null) return null;
  // Same bytes already there: nothing to do, and the file keeps the inode a running bridge may hold.
  if (deps.files.digest(target) === wanted) return target;
  const staged = `${target}.new`;
  try {
    deps.files.mkdirp(deps.host.path.dirname(target));
    deps.files.remove(staged);
    // `cp -c` clones on APFS (no second copy on disk); the plain copy is the fallback for any other volume.
    const cloned = deps.exec.capture("cp", ["-c", source, staged]);
    if (!cloned.found || cloned.code !== 0) {
      const plain = deps.exec.capture("cp", [source, staged]);
      if (!plain.found || plain.code !== 0) throw new Error("copy failed");
    }
    deps.exec.capture("chmod", ["0755", staged]);
    // A torn copy must never replace a good one: compare before the rename, not after.
    if (deps.files.digest(staged) !== wanted) throw new Error("copy differs");
    deps.files.rename(staged, target);
    return target;
  } catch {
    deps.files.remove(staged);
    return null;
  }
}
