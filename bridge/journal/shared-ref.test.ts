import { describe, expect, test } from "bun:test";

import { SHARED_REF_GRACE_MS, settleSharedRef } from "./shared-ref.ts";
import type { AgentSessionRef } from "./types.ts";

const ref = (value: string): AgentSessionRef => ({ kind: "id", value });
const first = ref("00000000-0000-7000-8000-00000000a001");
const second = ref("00000000-0000-7000-8000-00000000b002");

describe("settleSharedRef — a pane in a shared folder keeps its last log for a short grace", () => {
  test("a pane that was never found stays unanswered", () => {
    expect(settleSharedRef({ agent: "pi" }, "w1:p1", null, 1_000)).toBeNull();
  });

  test("a found ref is returned as is and stands in when the next poll finds nothing", () => {
    const owner = { agent: "pi" };
    expect(settleSharedRef(owner, "w1:p1", first, 1_000)).toBe(first);
    expect(settleSharedRef(owner, "w1:p1", null, 1_000 + 2_000)).toBe(first);
    expect(settleSharedRef(owner, "w1:p1", null, 1_000 + SHARED_REF_GRACE_MS)).toBe(first);
  });

  test("after the grace the honest answer is none, and it stays none", () => {
    const owner = { agent: "pi" };
    settleSharedRef(owner, "w1:p1", first, 1_000);
    expect(settleSharedRef(owner, "w1:p1", null, 1_000 + SHARED_REF_GRACE_MS + 1)).toBeNull();
    // The memory is gone: an earlier time does not bring it back
    expect(settleSharedRef(owner, "w1:p1", null, 1_500)).toBeNull();
  });

  test("the grace counts from the last time the footer named the log, not from the last helped poll", () => {
    const owner = { agent: "pi" };
    settleSharedRef(owner, "w1:p1", first, 0);
    // Polls every 5 s that find nothing do not extend the memory
    for (let t = 5_000; t <= SHARED_REF_GRACE_MS; t += 5_000) expect(settleSharedRef(owner, "w1:p1", null, t)).toBe(first);
    expect(settleSharedRef(owner, "w1:p1", null, SHARED_REF_GRACE_MS + 5_000)).toBeNull();
  });

  test("a newer found ref replaces the old one at once (/new or /resume) and restarts the grace", () => {
    const owner = { agent: "pi" };
    settleSharedRef(owner, "w1:p1", first, 0);
    expect(settleSharedRef(owner, "w1:p1", second, 10_000)).toBe(second);
    expect(settleSharedRef(owner, "w1:p1", null, 10_000 + SHARED_REF_GRACE_MS)).toBe(second);
  });

  test("each pane and each adapter has a memory of its own", () => {
    const owner = { agent: "pi" };
    settleSharedRef(owner, "w1:p1", first, 0);
    expect(settleSharedRef(owner, "w1:p2", null, 1_000)).toBeNull();
    expect(settleSharedRef({ agent: "pi" }, "w1:p1", null, 1_000)).toBeNull();
  });

  test("a clock that went backwards never stretches the grace", () => {
    const owner = { agent: "pi" };
    settleSharedRef(owner, "w1:p1", first, 50_000);
    expect(settleSharedRef(owner, "w1:p1", null, 10_000)).toBeNull();
  });

  test("the memory is bounded: the oldest panes are forgotten first", () => {
    const owner = { agent: "pi" };
    for (let i = 0; i < 300; i++) settleSharedRef(owner, `w1:p${i}`, first, 0);
    expect(settleSharedRef(owner, "w1:p0", null, 1_000)).toBeNull();
    expect(settleSharedRef(owner, "w1:p299", null, 1_000)).toBe(first);
  });
});
