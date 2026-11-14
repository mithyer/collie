// Tests for scripts/dogr-stamp.ts, the twin of release-version.ts for the fork's `-dogr.N` tags.
//
// OURS, NOT UPSTREAM'S: the fork cuts its own releases, and a wrong stamp or a stray strict tag makes
// every installed machine look for an update that does not exist. The cases pin the tag shape, the
// reconcile rule, the strict-tag trap and the files the stamp touches.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import { REPO_SPOTS, UPSTREAM_REPO, readDogrTag, reconcileDogr, stampRepoSpot, strictTagsAtOrAbove } from "./dogr-stamp.ts";
import { tomlVersion } from "./release-tag.ts";

const SCRIPT = join(import.meta.dir, "dogr-stamp.ts");

describe("readDogrTag", () => {
	test("reads a Dogr tag into its upstream base and counter", () => {
		expect(readDogrTag("v1.28.1-dogr.1")).toEqual({ tag: "v1.28.1-dogr.1", base: "1.28.1", n: 1, version: "1.28.1-dogr.1" });
		expect(readDogrTag("v1.28.1-dogr.12")?.n).toBe(12);
	});

	test("refuses every other shape", () => {
		for (const tag of [
			"v1.28.1", // strict: Collie's own kind of tag
			"v1.28.1-edge.1",
			"v1.28.1-dogr", // no counter
			"v1.28.1-dogr.0", // counters start at 1
			"v1.28.1-dogr.01", // no leading zero
			"v1.28.1-dogr.1+x", // build metadata is not understood by the update logic
			"v1.28.1.1-dogr.1", // four numbers
			"v1.28-dogr.1",
			"1.28.1-dogr.1", // no leading v
			"v1.28.1_dogr.1",
		]) {
			expect(readDogrTag(tag)).toBeNull();
		}
	});
});

describe("reconcileDogr", () => {
	test("plain files ask for the stamp", () => {
		const verdict = reconcileDogr("v1.28.1-dogr.2", "1.28.1");
		expect(verdict.ok && verdict.stamp).toBe("1.28.1-dogr.2");
	});

	test("files that already carry the full version need no stamp (a re-run)", () => {
		const verdict = reconcileDogr("v1.28.1-dogr.2", "1.28.1-dogr.2");
		expect(verdict.ok && verdict.stamp).toBeNull();
	});

	test("a tag on a commit of another version is refused with both versions named", () => {
		const verdict = reconcileDogr("v1.28.2-dogr.1", "1.28.1");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toContain("1.28.2");
			expect(verdict.reason).toContain("1.28.1");
		}
	});

	test("an older counter does not match files stamped with another counter", () => {
		expect(reconcileDogr("v1.28.1-dogr.1", "1.28.1-dogr.2").ok).toBe(false);
	});

	test("a non-Dogr tag is refused", () => {
		expect(reconcileDogr("v1.28.1", "1.28.1").ok).toBe(false);
	});
});

describe("strictTagsAtOrAbove", () => {
	const tags = ["v1.26.3", "v1.27.4", "v1.28.0", "v1.28.1", "v1.28.2", "v1.29.0", "v2.0.0", "v1.28.1-dogr.1", "v1.28.1-edge.1"];

	test("finds the strict tags that sort above a Dogr build of that base", () => {
		expect(strictTagsAtOrAbove(tags, "1.28.1")).toEqual(["v1.28.1", "v1.28.2", "v1.29.0", "v2.0.0"]);
	});

	test("older strict tags are harmless", () => {
		expect(strictTagsAtOrAbove(["v1.26.3", "v1.28.0"], "1.28.1")).toEqual([]);
	});

	test("suffixed tags are not strict tags", () => {
		expect(strictTagsAtOrAbove(["v9.9.9-dogr.1", "v9.9.9-edge.2"], "1.28.1")).toEqual([]);
	});

	test("compares numbers, not text", () => {
		expect(strictTagsAtOrAbove(["v1.100.0"], "1.28.1")).toEqual(["v1.100.0"]);
		expect(strictTagsAtOrAbove(["v1.9.0"], "1.28.1")).toEqual([]);
	});
});

describe("the update repository stamp", () => {
	const ROOT = join(import.meta.dir, "..");

	test("every spot still exists exactly once in the real files (an upstream merge turns this red first)", () => {
		for (const spot of REPO_SPOTS) {
			const text = readFileSync(join(ROOT, spot.file), "utf8");
			expect({ file: spot.file, found: text.split(spot.text).length - 1 }).toEqual({ file: spot.file, found: 1 });
		}
	});

	test("no other built-in default of Collie's own repository hides in the source", () => {
		// Every source file that names the repository in a default position must be a spot. A new one
		// upstream (a second default somewhere) would otherwise ship a build that updates from upstream.
		const named = spawnSync("grep", ["-rlE", `(\\|\\||:-|= ) ?"?\\$?\\{?${UPSTREAM_REPO}`, "bridge", "cli", "scripts", "web/src", "--include=*.ts", "--include=*.tsx", "--include=*.sh", "--exclude=*.test.ts", "--exclude=*.test.tsx", "--exclude=dogr-stamp.ts", "--exclude-dir=node_modules", "--exclude-dir=testdata"], { cwd: ROOT, encoding: "utf8" });
		const files = new Set(REPO_SPOTS.map((spot) => spot.file));
		const extra = named.stdout.split("\n").filter((line) => line !== "" && !files.has(line));
		expect(extra).toEqual([]);
	});

	test("one spot is pointed at the fork, once, and the rest of the file is untouched", () => {
		const spot = REPO_SPOTS[0]!;
		const before = `// header\n${spot.text}\nexport const OTHER = 1;\n`;
		const done = stampRepoSpot(before, spot, "mithyer/collie");
		expect(done).toEqual({ ok: true, text: `// header\nexport const DEFAULT_UPDATE_REPO = "mithyer/collie";\nexport const OTHER = 1;\n` });
	});

	test("a second run on stamped text changes nothing", () => {
		const spot = REPO_SPOTS[0]!;
		const first = stampRepoSpot(spot.text, spot, "mithyer/collie");
		expect(first.ok).toBe(true);
		if (first.ok) expect(stampRepoSpot(first.text, spot, "mithyer/collie")).toEqual({ ok: true, text: first.text });
	});

	test("text that is missing or doubled is refused, and so is a repository that is not owner/name", () => {
		const spot = REPO_SPOTS[0]!;
		expect(stampRepoSpot("nothing here\n", spot, "mithyer/collie").ok).toBe(false);
		expect(stampRepoSpot(`${spot.text}\n${spot.text}\n`, spot, "mithyer/collie").ok).toBe(false);
		expect(stampRepoSpot(spot.text, spot, "mithyer").ok).toBe(false);
		expect(stampRepoSpot(spot.text, spot, "a b/c").ok).toBe(false);
	});

	test("a replacement with a dollar sign in it is written as it is", () => {
		const spot = REPO_SPOTS.find((s) => s.file === "scripts/install.sh")!;
		const done = stampRepoSpot(spot.text, spot, "mithyer/collie");
		expect(done).toEqual({ ok: true, text: 'REPO="${COLLIE_UPDATE_REPO:-mithyer/collie}"' });
	});
});

/** A scratch checkout holding only the three version files and a CHANGELOG, at `version`. */
function scratch(version: string): string {
	const root = mkdtempSync(join(tmpdir(), "dogr-stamp-"));
	mkdirSync(join(root, "web"));
	writeFileSync(join(root, "herdr-plugin.toml"), `id = "herdr.collie"\nversion = "${version}"\nmin_herdr_version = "0.7.0"\n`);
	writeFileSync(join(root, "package.json"), `{\n  "name": "collie",\n  "version": "${version}"\n}\n`);
	writeFileSync(join(root, "web", "package.json"), `{\n  "name": "web",\n  "version": "${version}"\n}\n`);
	// The files the repository stamp rewrites, as small stand-ins that hold only the spot's own line.
	for (const spot of REPO_SPOTS) {
		const path = join(root, spot.file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `// stand-in\n${spot.text}\n`);
	}
	return root;
}

function run(root: string, ...args: string[]) {
	return spawnSync("bun", [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
}

describe("the command", () => {
	test("stamps the three files and prints the version, base and counter", () => {
		const root = scratch("1.28.1");
		try {
			const done = run(root, "--tag", "v1.28.1-dogr.3", "--stamp");
			expect(done.status).toBe(0);
			expect(done.stdout).toBe("version=1.28.1-dogr.3\nbase=1.28.1\nn=3\n");
			expect(readFileSync(join(root, "herdr-plugin.toml"), "utf8")).toContain('version = "1.28.1-dogr.3"');
			expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version": "1.28.1-dogr.3"');
			expect(readFileSync(join(root, "web", "package.json"), "utf8")).toContain('"version": "1.28.1-dogr.3"');
			// A second run on the stamped copy is a no-op, not a failure.
			expect(run(root, "--tag", "v1.28.1-dogr.3", "--stamp").status).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("--repo points every spot at the fork, and --stamp without --repo leaves them alone", () => {
		const root = scratch("1.28.1");
		try {
			const plain = run(root, "--tag", "v1.28.1-dogr.1", "--stamp");
			expect(plain.status).toBe(0);
			for (const spot of REPO_SPOTS) expect(readFileSync(join(root, spot.file), "utf8")).toContain(UPSTREAM_REPO);
			const done = run(root, "--tag", "v1.28.1-dogr.1", "--stamp", "--repo", "mithyer/collie");
			expect(done.status).toBe(0);
			for (const spot of REPO_SPOTS) {
				const text = readFileSync(join(root, spot.file), "utf8");
				expect(text).toContain("mithyer/collie");
				expect(text).not.toContain(UPSTREAM_REPO);
			}
			expect(run(root, "--tag", "v1.28.1-dogr.1", "--stamp", "--repo", "mithyer/collie").status).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a spot upstream moved refuses the whole stamp and writes nothing", () => {
		const root = scratch("1.28.1");
		try {
			writeFileSync(join(root, "bridge", "server.ts"), "// the line was reworded upstream\n");
			const done = run(root, "--tag", "v1.28.1-dogr.1", "--stamp", "--repo", "mithyer/collie");
			expect(done.status).toBe(1);
			expect(done.stderr).toContain("bridge/server.ts");
			expect(readFileSync(join(root, "cli", "install-kind.ts"), "utf8")).toContain(UPSTREAM_REPO);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("checks without writing when --stamp is not given", () => {
		const root = scratch("1.28.1");
		try {
			expect(run(root, "--tag", "v1.28.1-dogr.1").status).toBe(0);
			expect(readFileSync(join(root, "herdr-plugin.toml"), "utf8")).toContain('version = "1.28.1"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses a tag on the wrong commit and leaves the files alone", () => {
		const root = scratch("1.28.1");
		try {
			const done = run(root, "--tag", "v1.29.0-dogr.1", "--stamp");
			expect(done.status).toBe(1);
			expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version": "1.28.1"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses files that disagree", () => {
		const root = scratch("1.28.1");
		try {
			writeFileSync(join(root, "web", "package.json"), '{ "version": "1.27.0" }\n');
			expect(run(root, "--tag", "v1.28.1-dogr.1").status).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses a tag list that holds a strict tag above the build", () => {
		const root = scratch("1.28.1");
		try {
			const list = join(root, "tags.txt");
			writeFileSync(list, "v1.26.3\nv1.28.1\n");
			const done = run(root, "--tag", "v1.28.1-dogr.1", "--tags-file", list);
			expect(done.status).toBe(1);
			expect(done.stderr).toContain("v1.28.1");
			writeFileSync(list, "v1.26.3\nv1.28.1-dogr.1\n");
			expect(run(root, "--tag", "v1.28.1-dogr.2", "--tags-file", list).status).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("prints a release reading that names the Dogr version and reads the base CHANGELOG section", () => {
		// The base is whatever version this checkout carries, so the test survives every upstream merge.
		const repoToml = readFileSync(join(import.meta.dir, "..", "herdr-plugin.toml"), "utf8");
		const base = tomlVersion(repoToml);
		expect(base).not.toBeNull();
		const root = scratch(base ?? "0.0.0");
		try {
			cpSync(join(import.meta.dir, "..", "CHANGELOG.md"), join(root, "CHANGELOG.md"));
			const done = run(root, "--tag", `v${base}-dogr.1`, "--reading");
			expect(done.status).toBe(0);
			// SAFETY: the document is the one this script just printed; the three fields below are the ones asserted next.
			const doc = JSON.parse(done.stdout) as { version: string; crewProtocol: number; line?: string };
			expect(doc.version).toBe(`${base}-dogr.1`);
			expect(Number.isInteger(doc.crewProtocol)).toBe(true);
			expect(doc.line).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
