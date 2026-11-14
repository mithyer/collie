#!/usr/bin/env bun
// The version a Dogr release tag names, reconciled with the version files of the tagged commit.
//
//   bun scripts/dogr-stamp.ts --tag v1.28.1-dogr.1                       check, print version/base/n
//   bun scripts/dogr-stamp.ts --tag v1.28.1-dogr.1 --stamp               the same, then stamp the files
//   bun scripts/dogr-stamp.ts --tag v1.28.1-dogr.1 --tags-file tags.txt  also refuse a dangerous tag list
//   bun scripts/dogr-stamp.ts --tag v1.28.1-dogr.1 --reading             print collie-release.json
//   bun scripts/dogr-stamp.ts --tag v1.28.1-dogr.1 --stamp --repo owner/name   also point every default at that repo
//
// THIS FILE IS OURS, NOT UPSTREAM'S. The fork ships its own builds as `vX.Y.Z-dogr.N`, where X.Y.Z is
// the upstream release the branch was last merged up to. `scripts/release-version.ts` only knows
// `-edge.N`, so this is its twin for the other suffix, written as a new file so that merging upstream
// never conflicts with it (collie-fork.md in the wiki holds the whole plan).
//
// THE FILES IN GIT KEEP PLAIN X.Y.Z. The suffix lives in the tag, and the release job stamps it into
// its own working copy of the three version files before it builds (`--stamp`), exactly as an Edge
// build does. Committing the suffix would make every upstream merge conflict on the version files.
//
// THE UPDATE REPOSITORY IS STAMPED THE SAME WAY (`--repo`). Collie's built-in default for "where do
// updates come from" is `AltanS/collie` in seven places (REPO_SPOTS below). A release build rewrites
// them in its own working copy, so a released binary asks the fork by default, while the files in git
// stay identical to upstream: no merge conflict, and upstream's 151 test mentions keep passing
// untouched. scripts/dogr-stamp.test.ts checks that every spot still exists exactly once, so an
// upstream refactor turns a test red instead of silently shipping a build that updates from upstream.
//
// A STRICT TAG IN THE FORK IS A TRAP. The in-app update check lists the fork's tags. A strict
// `vX.Y.Z` that is not older than the build's base sorts ABOVE `X.Y.Z-dogr.N`, so every machine would be
// offered an update to a package that does not exist (it was run against Collie's own update logic:
// see bridge/dogr-update.test.ts). `--tags-file` is how the release job refuses such a tag list.
//
// No dependency beyond Node's own modules and `release-tag.ts`: the payload job runs this before
// `bun install`, like `release-version.ts`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stampPackageJson, stampToml, tomlVersion } from "./release-tag.ts";

/** `vX.Y.Z-dogr.N`: three plain numbers, then `-dogr.` and a counter with no leading zero. */
const DOGR_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dogr\.([1-9]\d*)$/;

/** A strict release tag, `vX.Y.Z` and nothing after it. */
const STRICT_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** What a Dogr tag names. */
export interface DogrTag {
	readonly tag: string;
	/** The upstream release this build is based on, `1.28.1`; the version the files carry in git. */
	readonly base: string;
	/** The build counter after `-dogr.`, from 1 for each base. */
	readonly n: number;
	/** The version the build reports, `1.28.1-dogr.1`. */
	readonly version: string;
}

/**
 * Read a Dogr release tag.
 * @param tag The tag name, with its leading `v`.
 * @returns What it names, or null for anything that is not `vX.Y.Z-dogr.N`.
 */
export function readDogrTag(tag: string): DogrTag | null {
	const m = DOGR_TAG.exec(tag.trim());
	if (m === null) return null;
	const base = `${m[1]}.${m[2]}.${m[3]}`;
	const n = Number(m[4]);
	return { tag: tag.trim(), base, n, version: `${base}-dogr.${n}` };
}

/** The verdict on one tag against the files' version, and the stamp it needs, if any. */
export type DogrReconciled =
	| { readonly ok: true; readonly reading: DogrTag; readonly stamp: string | null }
	| { readonly ok: false; readonly reason: string };

/**
 * Does this tag belong on a commit whose version files say `files`?
 * @param tag The tag name.
 * @param files The version the three files agree on.
 * @returns Plain `X.Y.Z` files ask for a stamp; files already at the full version are a re-run of a
 *   stamped job and need none; anything else is a tag on the wrong commit, refused with both named.
 */
export function reconcileDogr(tag: string, files: string): DogrReconciled {
	const reading = readDogrTag(tag);
	if (reading === null) return { ok: false, reason: `'${tag}' is not a Dogr release tag (vX.Y.Z-dogr.N)` };
	if (files === reading.version) return { ok: true, reading, stamp: null };
	if (files === reading.base) return { ok: true, reading, stamp: reading.version };
	return {
		ok: false,
		reason: `tag ${reading.tag} needs version files at ${reading.base} (or ${reading.version}, already stamped), and they say ${files}`,
	};
}

/**
 * The strict tags that would hide a Dogr build behind a package that does not exist.
 * @param tags Every tag name of the fork.
 * @param base The upstream version of the build being cut, `1.28.1`.
 * @returns The strict `vX.Y.Z` tags whose version is the base or newer (they sort above `base-dogr.N`).
 */
export function strictTagsAtOrAbove(tags: readonly string[], base: string): string[] {
	const want = base.split(".").map(Number);
	return tags.filter((tag) => {
		const m = STRICT_TAG.exec(tag.trim());
		if (m === null) return false;
		const have = [Number(m[1]), Number(m[2]), Number(m[3])];
		for (let i = 0; i < 3; i++) {
			if (have[i] !== want[i]) return (have[i] ?? 0) > (want[i] ?? 0);
		}
		return true;
	});
}

/** Collie's own repository: what the files in git say, and what a Dogr build replaces. */
export const UPSTREAM_REPO = "AltanS/collie";

/** One place where Collie's own repository is the built-in default. */
export interface RepoSpot {
	/** The file, relative to the repository root. */
	readonly file: string;
	/** The exact upstream text that carries the repository; it must occur exactly once in the file. */
	readonly text: string;
}

/** Every built-in default for the update repository. Add a line here when upstream adds one. */
export const REPO_SPOTS: readonly RepoSpot[] = [
	{ file: "cli/install-kind.ts", text: `export const DEFAULT_UPDATE_REPO = "${UPSTREAM_REPO}";` },
	{ file: "bridge/config-schema.ts", text: `default: "${UPSTREAM_REPO}",` },
	{ file: "bridge/index.ts", text: `const updateRepo = process.env.COLLIE_UPDATE_REPO?.trim() || "${UPSTREAM_REPO}";` },
	{ file: "bridge/server.ts", text: `repo: process.env.COLLIE_UPDATE_REPO?.trim() || "${UPSTREAM_REPO}",` },
	{ file: "scripts/install.sh", text: `REPO="\${COLLIE_UPDATE_REPO:-${UPSTREAM_REPO}}"` },
	{ file: "web/src/lib/report/body.ts", text: `export const ISSUE_REPO = "${UPSTREAM_REPO}";` },
	{ file: "web/src/lib/theme/registry.ts", text: `https://github.com/${UPSTREAM_REPO}/issues/new?` },
];

/** `owner/name`, the way GitHub writes a repository. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** The verdict on one file's text against one spot. */
export type RepoStamped = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/**
 * Point one spot at `repo`.
 * @param text The file's text.
 * @param spot The place to change.
 * @param repo The repository to put there, `owner/name`.
 * @returns The new text. A file that already holds the stamped line is returned as it is (a re-run); a
 *   file where the upstream text is missing or occurs more than once is refused, because it means upstream
 *   moved the line and the stamp must be updated by a person.
 */
export function stampRepoSpot(text: string, spot: RepoSpot, repo: string): RepoStamped {
	if (!REPO_NAME.test(repo)) return { ok: false, reason: `'${repo}' is not owner/name` };
	const to = spot.text.replace(UPSTREAM_REPO, repo);
	const found = text.split(spot.text).length - 1;
	if (found === 1) return { ok: true, text: text.replace(spot.text, () => to) };
	if (found === 0 && repo !== UPSTREAM_REPO && text.split(to).length - 1 === 1) return { ok: true, text };
	return { ok: false, reason: `${spot.file}: expected the text below exactly once, found ${found}:\n    ${spot.text}` };
}

function packageVersion(text: string): string | null {
	return /"version"[ \t]*:[ \t]*"([^"]*)"/.exec(text)?.[1] ?? null;
}

function flag(argv: readonly string[], name: string): string | null {
	const at = argv.indexOf(`--${name}`);
	if (at === -1) return null;
	return argv[at + 1] ?? null;
}

/** `collie-release.json` of a Dogr build: the CHANGELOG section of the base version, the Dogr version on top. */
async function printReading(root: string, reading: DogrTag, changelogPath: string): Promise<void> {
	// Imported only here: these pull in the bridge, which the stamp step must not need.
	const { buildReleaseReading } = await import("./release-reading.ts");
	const { CREW_PROTOCOL_VERSION } = await import("../bridge/crew/enrollment.ts");
	const changelog = readFileSync(join(root, changelogPath), "utf8");
	const doc = buildReleaseReading(changelog, reading.base, CREW_PROTOCOL_VERSION);
	process.stdout.write(`${JSON.stringify({ ...doc, version: reading.version }, null, 2)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
	const tag = flag(argv, "tag");
	const root = flag(argv, "root") ?? join(import.meta.dir, "..");
	if (tag === null || tag === "") {
		console.error("usage: bun scripts/dogr-stamp.ts --tag vX.Y.Z-dogr.N [--stamp [--repo owner/name]] [--tags-file <file>] [--reading] [--root <dir>]");
		return 2;
	}
	const files = {
		toml: join(root, "herdr-plugin.toml"),
		pkg: join(root, "package.json"),
		web: join(root, "web", "package.json"),
	};
	const text = { toml: readFileSync(files.toml, "utf8"), pkg: readFileSync(files.pkg, "utf8"), web: readFileSync(files.web, "utf8") };
	const versions = { toml: tomlVersion(text.toml), pkg: packageVersion(text.pkg), web: packageVersion(text.web) };
	if (versions.toml === null || versions.toml !== versions.pkg || versions.toml !== versions.web) {
		console.error(
			`✗ dogr-stamp: the version files disagree (herdr-plugin.toml ${versions.toml ?? "?"}, package.json ${versions.pkg ?? "?"}, web/package.json ${versions.web ?? "?"})`,
		);
		return 1;
	}
	const verdict = reconcileDogr(tag, versions.toml);
	if (!verdict.ok) {
		console.error(`✗ dogr-stamp: ${verdict.reason}`);
		return 1;
	}
	const { reading, stamp } = verdict;
	const tagsFile = flag(argv, "tags-file");
	if (tagsFile !== null) {
		const tags = readFileSync(tagsFile, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
		const hidden = strictTagsAtOrAbove(tags, reading.base);
		if (hidden.length > 0) {
			console.error(
				`✗ dogr-stamp: this repository holds strict tag(s) ${hidden.join(", ")}, which sort above ${reading.version}. ` +
					"Every machine would be offered an update to a package that does not exist. Delete the tag(s) from this repository.",
			);
			return 1;
		}
	}
	const repo = flag(argv, "repo");
	if (argv.includes("--stamp") && repo !== null) {
		// Check every spot before writing any, so a refusal leaves the tree as it was.
		const changed: { path: string; text: string; file: string }[] = [];
		for (const spot of REPO_SPOTS) {
			const path = join(root, spot.file);
			if (!existsSync(path)) {
				console.error(`✗ dogr-stamp: ${spot.file} is missing`);
				return 1;
			}
			const done = stampRepoSpot(readFileSync(path, "utf8"), spot, repo);
			if (!done.ok) {
				console.error(`✗ dogr-stamp: ${done.reason}`);
				return 1;
			}
			changed.push({ path, text: done.text, file: spot.file });
		}
		for (const c of changed) writeFileSync(c.path, c.text);
		if (existsSync(join(root, ".git"))) {
			spawnSync("git", ["-C", root, "update-index", "--assume-unchanged", "--", ...changed.map((c) => c.file)]);
		}
		console.error(`stamped ${repo} as the update repository in ${changed.length} files (this checkout only)`);
	}
	if (stamp !== null && argv.includes("--stamp")) {
		writeFileSync(files.toml, stampToml(text.toml, stamp));
		writeFileSync(files.pkg, stampPackageJson(text.pkg, stamp));
		writeFileSync(files.web, stampPackageJson(text.web, stamp));
		// Keep the stamp out of `git status`: the web build marks a changed tree `-dirty`.
		if (existsSync(join(root, ".git"))) {
			spawnSync("git", ["-C", root, "update-index", "--assume-unchanged", "--", "herdr-plugin.toml", "package.json", join("web", "package.json")]);
		}
		console.error(`stamped ${stamp} into herdr-plugin.toml, package.json and web/package.json (this checkout only)`);
	}
	if (argv.includes("--reading")) {
		await printReading(root, reading, flag(argv, "changelog") ?? "CHANGELOG.md");
		return 0;
	}
	process.stdout.write(`version=${reading.version}\nbase=${reading.base}\nn=${reading.n}\n`);
	return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
