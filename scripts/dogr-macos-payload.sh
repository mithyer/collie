#!/usr/bin/env bash
# DOGR (our own file, not upstream's): builds the two macOS payload tarballs of a Dogr build on a
# machine that is NOT a GitHub runner. It is what Codemagic runs (codemagic.yaml), so a release does
# not have to wait for GitHub's macOS pool, which is often out of capacity (see the long comment in
# .github/workflows/dogr-release.yml, job `payload`).
#
# IT DOES THE SAME STEPS AS THAT JOB, AND IT MUST STAY THE SAME: the version gate, the Dogr stamp,
# the web build, the compile on the upstream Bun, the ad-hoc codesign with the fixed identifier
# `dev.dogr.collie`, the loader check and the artifact description. The tarball name, its `.sha256`
# sidecar and the `<platform>.artifact.json` are written in the very shape the workflow's release job
# merges, so a later change can feed these files into that job without touching it.
# scripts/dogr-macos-payload.test.ts pins the pieces that must not drift (targets, identifier).
#
# Needs: macOS on Apple Silicon (the x64 payload is cross-compiled, as on the GitHub runner), Nix with
# flakes (`nix develop` gives the Bun, node and git of flake.lock), and the Xcode command line tools.
#
# Inputs (environment):
#   DOGR_TAG        the tag being built, e.g. v1.30.0-dogr.28. Unset = a TEST build: no stamp, the plain
#                   version of the files, and a loud note, so a hand-started build cannot be mistaken
#                   for a release.
#   DOGR_REPO       owner/name the stamp points every update default at (default mithyer/collie).
#   DOGR_PLATFORMS  space separated, any of macos-arm64 macos-x64 (default both).
#   DOGR_OUT        where the files for upload go (default <repo>/dogr-out).
#   DOGR_WORK       scratch folder (default a new one under $TMPDIR).
# Output: $DOGR_OUT/collie-<version>-<platform>.tar.gz, its .sha256, and <platform>.artifact.json.
set -euo pipefail

# The repository root, wherever the script is started from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/$(basename "${BASH_SOURCE[0]}")"
cd "$ROOT"

PLATFORMS="${DOGR_PLATFORMS:-macos-arm64 macos-x64}"
DOGR_REPO="${DOGR_REPO:-mithyer/collie}"
DOGR_TAG="${DOGR_TAG:-}"
OUT_DIR="${DOGR_OUT:-$ROOT/dogr-out}"

# The Bun target of each platform: the same pairs as the `payload` matrix of dogr-release.yml.
# macos-x64 is the BASELINE target and is compiled on this arm64 machine.
bun_target_of() {
  case "$1" in
    macos-arm64) echo "bun-darwin-arm64" ;;
    macos-x64) echo "bun-darwin-x64-baseline" ;;
    *) echo "unknown platform '$1': this script builds macos-arm64 and macos-x64 only" >&2; return 1 ;;
  esac
}

# The version the payloads are named after: the tag without its `v`, as the workflow does; a test
# build (no tag) uses the plain version the files say.
version_of() {
  if [ -n "$DOGR_TAG" ]; then
    echo "${DOGR_TAG#v}"
  else
    sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/herdr-plugin.toml" | head -1
  fi
}

# Phase 1, INSIDE `nix develop`: check, stamp, build the web app once, then compile and stage each
# payload. `bun`, `node` and `git` are the versions flake.lock names, as on the GitHub runner.
inner() {
  : "${DOGR_WORK:?inner phase needs DOGR_WORK}"
  local version
  version="$(version_of)"

  # The scripts below read the GitHub names; give them the same facts under those names.
  if [ -n "$DOGR_TAG" ]; then
    export GITHUB_REF_NAME="$DOGR_TAG"
    export GITHUB_REPOSITORY="$DOGR_REPO"
  fi
  export GITHUB_WORKSPACE="$ROOT"

  # The version gate runs BEFORE the stamp: the files in git say plain X.Y.Z and the gate refuses
  # anything else.
  bash scripts/check-version.sh

  # A DOGR TAG IS STAMPED BEFORE ANYTHING READS A VERSION (scripts/dogr-stamp.ts holds the reasons):
  # the binary then names the Dogr build and asks THIS fork for updates.
  if [ -n "$DOGR_TAG" ]; then
    bun scripts/dogr-stamp.ts --tag "$DOGR_TAG" --stamp --repo "$DOGR_REPO"
  else
    echo "NOTE: DOGR_TAG is not set, so this is a TEST build: not stamped, not a release." >&2
  fi

  bun install --frozen-lockfile
  (cd web && bun install --frozen-lockfile && bun run build)

  # THE COMPILE RUNS ON THE UPSTREAM BUN, not on the one this shell uses, because `bun build --compile`
  # copies the RUNNING bun as the base of what it emits and nixpkgs patches its own copy into the Nix
  # store (#184). scripts/upstream-bun.sh realises the archive `flake.nix` pins and prints its bun.
  local upstream_bun
  upstream_bun="$(FLAKE_ROOT="$ROOT" bash scripts/upstream-bun.sh)"

  local platform target root stage
  for platform in $PLATFORMS; do
    target="$(bun_target_of "$platform")"
    root="collie-$version-$platform"
    stage="$DOGR_WORK/$root"
    rm -rf "$stage"
    mkdir -p "$stage/bin" "$stage/web"

    bun run scripts/build-cli.ts --bun "$upstream_bun" --target "$target" --outfile "$stage/bin/collie"
    chmod 0755 "$stage/bin/collie"

    # Ad-hoc codesign makes the binary RUNNABLE on Apple Silicon. DOGR: a FIXED identifier and the
    # requirement "identifier only", so the folder-access answer a person gave once keeps matching
    # after each update (cli/stable-runner.ts, RUNNER_IDENTIFIER; the test pins them together).
    codesign --force --sign - --timestamp=none \
      --identifier dev.dogr.collie \
      -r='designated => identifier "dev.dogr.collie"' "$stage/bin/collie"
    codesign -dv "$stage/bin/collie"
    # A binary signed any other way would bring the dialog back after every update: refuse it.
    codesign -d -r- "$stage/bin/collie" 2>&1 | grep -qF 'designated => identifier "dev.dogr.collie"'
    codesign --verify --strict "$stage/bin/collie"

    cp -R web/dist "$stage/web/dist"
    # The math engines are not in any install (ADR 0132): they are the `collie-math-<version>` asset.
    rm -rf "$stage/web/dist/math"
    cp herdr-plugin.toml package.json .env.example CHANGELOG.md LICENSE README.md "$stage/"
    cp -R docs "$stage/docs"
    # The shim the manifest names: every `[[actions]]` entry is `bash scripts/collie-ctl.sh <verb>`.
    mkdir -p "$stage/scripts"
    cp scripts/collie-ctl.sh "$stage/scripts/collie-ctl.sh"
    chmod 0755 "$stage/scripts/collie-ctl.sh"
  done
}

# Phase 2, OUTSIDE `nix develop` and on purpose: nothing inside the flake can see a link into this
# machine's Nix store, and a binary that only runs because /nix/store exists runs perfectly. The loader
# check is the guard; the version run after it proves the binary that passed is the one that works.
# The tarball is sealed HERE, so it does not exist before its binary has been checked.
seal() {
  local version platform target root stage tarball name sha size arch archs reported page
  version="$(version_of)"
  mkdir -p "$OUT_DIR"
  # No AppleDouble `._` files in the tarball: they carry extended attributes nobody asked for.
  export COPYFILE_DISABLE=1

  for platform in $PLATFORMS; do
    target="$(bun_target_of "$platform")"
    root="collie-$version-$platform"
    stage="$DOGR_WORK/$root"
    name="$root.tar.gz"
    tarball="$DOGR_WORK/$name"

    bash scripts/check-payload-links.sh "$stage/bin/collie"

    if [ "$platform" = "macos-x64" ]; then
      # Cross-compiled on arm64: Rosetta has no AVX and Bun's x64 runtime dies with SIGILL under it,
      # baseline target or not. So it is checked by what it IS: an x86_64 Mach-O that carries a signature.
      archs="$(lipo -archs "$stage/bin/collie")"
      [ "$archs" = "x86_64" ] || { echo "the macos-x64 binary is '$archs', not x86_64" >&2; exit 1; }
      echo "ok: $root/bin/collie is x86_64 (not run: no x86_64 runtime on this machine)"
    else
      reported="$("$stage/bin/collie" version)"
      case "$reported" in
        "$version"*) ;;
        *) echo "the compiled binary reports '$reported', which does not start with '$version'" >&2; exit 1 ;;
      esac
      echo "ok: $root/bin/collie reports $reported"
      # The embedded operator manual: a page nothing on disk supplied.
      page="$("$stage/bin/collie" docs crew | head -1)"
      [ "$page" = "# Crew commands" ] || { echo "'docs crew' answered '$page', not the embedded page" >&2; exit 1; }
      echo "ok: $root/bin/collie carries the embedded operator docs"
    fi

    tar -czf "$tarball" -C "$DOGR_WORK" "$root"

    # One entry of the manifest's `artifacts[]`, in the shape the release job merges.
    sha="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
    [ "${#sha}" -eq 64 ] || { echo "no usable sha256 for $tarball" >&2; exit 1; }
    size="$(wc -c < "$tarball" | tr -d ' ')"
    arch="${platform##*-}"
    cp "$tarball" "$OUT_DIR/$name"
    printf '%s  %s\n' "$sha" "$name" > "$OUT_DIR/$name.sha256"
    cat > "$OUT_DIR/$platform.artifact.json" <<JSON
{
  "name": "$name",
  "platform": "$platform",
  "os": "macos",
  "arch": "$arch",
  "libc": null,
  "variant": null,
  "bunTarget": "$target",
  "size": $size,
  "sha256": "$sha",
  "payloadRoot": "$root",
  "codesign": "adhoc",
  "notarized": false
}
JSON
    echo "wrote $OUT_DIR/$name ($size bytes, sha256 $sha)"
  done
}

main() {
  case "${1:-}" in
    inner)
      inner
      ;;
    "")
      [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || {
        echo "this script needs macOS on Apple Silicon (found $(uname -s) $(uname -m))" >&2
        exit 1
      }
      # Validate every platform name BEFORE the long build starts.
      local p
      for p in $PLATFORMS; do bun_target_of "$p" > /dev/null; done
      DOGR_WORK="${DOGR_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/dogr-payload.XXXXXX")}"
      export DOGR_WORK DOGR_TAG DOGR_REPO
      mkdir -p "$DOGR_WORK" "$OUT_DIR"
      # Only OUR files are removed from an earlier run, never the whole folder (DOGR_OUT may be anywhere).
      rm -f "$OUT_DIR"/collie-*.tar.gz "$OUT_DIR"/collie-*.tar.gz.sha256 "$OUT_DIR"/*.artifact.json
      nix develop --command bash "$SELF" inner
      seal
      ls -l "$OUT_DIR"
      ;;
    *)
      echo "usage: bash scripts/dogr-macos-payload.sh   (see the comment at the top for the inputs)" >&2
      exit 2
      ;;
  esac
}

main "$@"
