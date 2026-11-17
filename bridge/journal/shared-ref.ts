/**
 * The session a pane in a shared folder found last, kept for a short while (#508).
 *
 * Such a pane has no folder answer: its log is told apart from its neighbours' by the token totals its
 * footer shows. The footer and the log are two views of one conversation that are written a moment
 * apart, so at every turn boundary a poll can see the new total in the log before the screen shows it
 * (measured: about 0.3 s, up to a few seconds under load), see no footer at all while a dialog covers
 * it, or hit two logs with the same totals. Each of those answers "no session", and a phone that polls
 * the chat route then replaces a transcript it was showing with "no conversation" until the next poll
 * that agrees. A pane does not change its conversation in a few seconds, so for a short grace the last
 * positive answer stands. A newer positive answer replaces it at once, so `/new` or `/resume` (the
 * footer then names another log) switches immediately, and after the grace the honest answer is null.
 *
 * Only a shared folder keeps this memory: every other answer is a folder walk that is repeatable.
 *
 * TEST:bridge/journal/shared-ref.test.ts, bridge/server.test.ts[journalRefOf]
 */
import type { AgentSessionRef } from "./types.ts";

/** How long the last positive answer of a pane in a shared folder still stands after it was last found. */
export const SHARED_REF_GRACE_MS = 20_000;

/** The most panes one adapter remembers; the oldest memory is dropped first. */
const MAX_REMEMBERED = 256;

/** One remembered answer: the ref and when a poll last found it by the pane's own footer. */
interface Remembered {
  readonly ref: AgentSessionRef;
  readonly at: number;
}

/** What owns a memory: the journal adapter that discovered. Only its identity is used, as the key. */
export interface SharedRefOwner {
  readonly agent: string;
}

/**
 * The memory, one map per adapter object and keyed by pane id inside it. An adapter owns its own
 * (a test builds adapters of its own and so never meets another test's memory); a map that outlives
 * its adapter is freed with it.
 */
const memory = new WeakMap<SharedRefOwner, Map<string, Remembered>>();

/**
 * The ref a pane in a shared folder reads this time.
 *
 * @param owner the adapter that discovered, the key of its own memory
 * @param paneId the pane that asked
 * @param found what discovery answered this time: a ref, or null when it found none
 * @param now the time of the poll in milliseconds (a parameter so a test sets the clock)
 * @returns `found` when it is a ref (and remembers it); otherwise the remembered ref while it was
 *   found at most {@link SHARED_REF_GRACE_MS} ago, else null
 */
export function settleSharedRef(owner: SharedRefOwner, paneId: string, found: AgentSessionRef | null, now: number): AgentSessionRef | null {
  let panes = memory.get(owner);
  if (found !== null) {
    if (panes === undefined) memory.set(owner, (panes = new Map()));
    // Delete first so a re-found pane moves to the end: the first key is then always the oldest memory
    panes.delete(paneId);
    panes.set(paneId, { ref: found, at: now });
    for (const old of panes.keys()) {
      if (panes.size <= MAX_REMEMBERED) break;
      panes.delete(old);
    }
    return found;
  }
  const last = panes?.get(paneId);
  if (last === undefined) return null;
  // The grace counts from the last time the footer named the log, never from the last poll that was
  // helped by it, so a pane whose footer stays unreadable gets the honest answer after the grace
  if (now - last.at <= SHARED_REF_GRACE_MS && now >= last.at) return last.ref;
  panes?.delete(paneId);
  return null;
}
