// Guard tests for the way a Dogr build (`X.Y.Z-dogr.N`) is seen by Collie's own update logic.
//
// OURS, NOT UPSTREAM'S. The fork ships `vX.Y.Z-dogr.N` tags and relies on update logic it did not
// write: `lineOffer`, `latestUpdateInMajor`, `updatesNewerThan`. The cases below are the results the
// plan in the wiki (collie-fork.md) was built on. If an upstream merge changes the logic, one of them
// goes red here first, before a machine is offered an update that does not exist.

import { describe, expect, test } from "bun:test";

import { compareSemver, latestUpdateInMajor, updatesNewerThan } from "./update.ts";
import { lineOffer } from "./update-line.ts";

/** The tags of a fork that has released three Dogr builds on two upstream bases. */
const FORK_TAGS = ["v1.26.3", "v1.28.1-dogr.1", "v1.28.1-dogr.2", "v1.28.2-dogr.1"];

describe("a Dogr build against the fork's own tags", () => {
	test("is offered the later Dogr builds, newest last", () => {
		const offer = lineOffer({ tags: FORK_TAGS, installed: "1.28.1-dogr.1", line: "stable" });
		expect(offer.newer).toEqual(["1.28.1-dogr.2", "1.28.2-dogr.1"]);
		expect(offer.latest).toBe("1.28.2-dogr.1");
		expect(offer.back).toBeNull();
	});

	test("the banner's resolver and the digest list agree with it", () => {
		expect(latestUpdateInMajor(FORK_TAGS, 1, "1.28.1-dogr.1")).toBe("1.28.2-dogr.1");
		expect(updatesNewerThan(FORK_TAGS, "1.28.1-dogr.1")).toEqual(["1.28.1-dogr.2", "1.28.2-dogr.1"]);
	});

	test("the newest build is offered nothing", () => {
		const offer = lineOffer({ tags: FORK_TAGS, installed: "1.28.2-dogr.1", line: "stable" });
		expect(offer.newer).toEqual([]);
	});

	test("counters sort as numbers: dogr.10 is above dogr.9", () => {
		expect(compareSemver("1.28.1-dogr.10", "1.28.1-dogr.9")).toBeGreaterThan(0);
	});

	test("a Dogr build is older than the strict release of its own base", () => {
		expect(compareSemver("1.28.1-dogr.1", "1.28.1")).toBeLessThan(0);
	});
});

describe("the trap the release job guards against", () => {
	test("a strict tag of the base in the fork is offered as an update, and no package exists for it", () => {
		const offer = lineOffer({ tags: [...FORK_TAGS, "v1.28.1"], installed: "1.28.1-dogr.2", line: "stable" });
		expect(offer.newer).toContain("1.28.1");
	});

	test("a strict tag older than the base is harmless", () => {
		const offer = lineOffer({ tags: [...FORK_TAGS, "v1.28.0"], installed: "1.28.1-dogr.2", line: "stable" });
		expect(offer.newer).toEqual(["1.28.2-dogr.1"]);
	});
});

describe("the way back to Collie's own releases", () => {
	test("a machine pointed back at the upstream repository is offered upstream's releases", () => {
		const upstream = ["v1.27.4", "v1.28.0", "v1.28.1", "v1.28.2"];
		const offer = lineOffer({ tags: upstream, installed: "1.28.1-dogr.1", line: "stable" });
		expect(offer.newer).toEqual(["1.28.1", "1.28.2"]);
	});
});
