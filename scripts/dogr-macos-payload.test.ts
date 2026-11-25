// Tests for scripts/dogr-macos-payload.sh and codemagic.yaml, the Codemagic twin of the `payload` job in
// .github/workflows/dogr-release.yml.
//
// OURS, NOT UPSTREAM'S. The script is run by Codemagic only, so nothing in CI would notice if it drifted
// from the workflow: a wrong Bun target ships a binary for the wrong chip, and a different codesign
// identifier makes macOS ask for folder access again after every update. These cases pin the facts the
// two files must agree on. They read the files as text; they do not run a build (that needs Nix and
// Apple Silicon).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { RUNNER_IDENTIFIER } from "../cli/stable-runner.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const script = read("scripts/dogr-macos-payload.sh");
const workflow = read(".github/workflows/dogr-release.yml");
const codemagic = read("codemagic.yaml");

/**
 * Collects `platform -> bun target` pairs: every match of `pattern` must have two capture groups,
 * the platform and the target.
 */
function targetPairs(text: string, pattern: RegExp): Map<string, string> {
	const pairs = new Map<string, string>();
	for (const match of text.matchAll(pattern)) {
		const [, platform, target] = match;
		if (platform !== undefined && target !== undefined) pairs.set(platform, target.trim());
	}
	return pairs;
}

/** The pairs of the macOS rows of the workflow's `payload` matrix. */
const workflowMacTargets = (): Map<string, string> =>
	targetPairs(workflow, /platform: (macos-[a-z0-9]+)\n\s+runs-on: [^\n]+\n\s+bun-target: ([^\n]+)/g);

/** The pairs of the script's `bun_target_of` function. */
const scriptTargets = (): Map<string, string> => targetPairs(script, /(macos-[a-z0-9]+)\) echo "([^"]+)"/g);

describe("dogr-macos-payload.sh against the GitHub workflow", () => {
	test("builds the same macOS platforms for the same Bun targets", () => {
		const fromWorkflow = workflowMacTargets();
		// Guard the guard: a regex that matched nothing would pass the equality below.
		expect([...fromWorkflow.keys()].toSorted()).toEqual(["macos-arm64", "macos-x64"]);
		expect(scriptTargets()).toEqual(fromWorkflow);
	});

	test("signs with the fixed identifier the update logic expects, and checks it", () => {
		const requirement = `designated => identifier "${RUNNER_IDENTIFIER}"`;
		for (const text of [script, workflow]) {
			expect(text).toContain(`--identifier ${RUNNER_IDENTIFIER}`);
			expect(text).toContain(`-r='${requirement}'`);
			// The check that refuses a binary signed any other way.
			expect(text).toContain(`grep -qF '${requirement}'`);
		}
	});

	test("runs the same gates and the same compile as the workflow", () => {
		for (const piece of [
			"bash scripts/check-version.sh",
			"scripts/dogr-stamp.ts",
			"bun install --frozen-lockfile",
			"bun run build",
			"scripts/upstream-bun.sh",
			"scripts/build-cli.ts",
			"scripts/check-payload-links.sh",
			"rm -rf \"$stage/web/dist/math\"",
		]) {
			expect(workflow).toContain(piece);
			expect(script).toContain(piece);
		}
	});

	test("describes each artifact with the keys the release job merges", () => {
		const keys = ["name", "platform", "os", "arch", "libc", "variant", "bunTarget", "size", "sha256", "payloadRoot", "codesign", "notarized"];
		for (const key of keys) {
			expect(workflow).toContain(`"${key}"`);
			expect(script).toContain(`"${key}"`);
		}
	});

	test("is valid bash", () => {
		const result = spawnSync("bash", ["-n", join(root, "scripts/dogr-macos-payload.sh")], { encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});

describe("codemagic.yaml", () => {
	test("runs the script and uploads the folder the script writes to", () => {
		expect(codemagic).toContain("bash scripts/dogr-macos-payload.sh");
		// The script writes to $DOGR_OUT; the YAML sets it to <clone>/dogr-out and uploads dogr-out/*.
		expect(codemagic).toContain('export DOGR_OUT="$CM_BUILD_DIR/dogr-out"');
		expect(codemagic).toContain("- dogr-out/*");
	});

	test("passes the tag Codemagic gives, empty for a hand-started test build", () => {
		expect(codemagic).toContain('export DOGR_TAG="${CM_TAG:-}"');
	});

	test("runs on an Apple Silicon machine, which the script requires", () => {
		expect(codemagic).toContain("instance_type: mac_mini_m2");
		expect(script).toContain("Darwin-arm64");
	});
});
