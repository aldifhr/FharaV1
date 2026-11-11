/**
 * Threadbear T3: the live tail plus older pages, as one gapless event list.
 *
 * Pattern from threadbear `web/src/transcript.ts` (MIT, Copyright (c) 2026
 * Mike Cann; see THIRD_PARTY_NOTICES.md): a small live subscription for the
 * newest events (`directThreads.tail`, at most DIRECT_TAIL_LIMIT) and older
 * pages read once (`directThreads.page {beforeSeq}`), never a subscription
 * on the whole thread. Sequences are gapless per task, so a hole between
 * what we hold and the new tail means events were missed (a long
 * disconnect): we drop what we held and start again from the tail.
 */
import type { ThreadEvent } from "./types";

/** Events read live. The rest is paged once on "Load earlier". */
export const DIRECT_TAIL_LIMIT = 80;
/** One older page. */
export const DIRECT_PAGE_LIMIT = 100;

const seq = (e: ThreadEvent) => (typeof e.sequence === "number" ? e.sequence : -1);

function bySequence(events: Iterable<ThreadEvent>): ThreadEvent[] {
  const map = new Map<number, ThreadEvent>();
  for (const e of events) if (seq(e) >= 0) map.set(seq(e), e);
  return [...map.values()].sort((a, b) => seq(a) - seq(b));
}

export type MergeResult = { events: ThreadEvent[]; reset: boolean };

/**
 * Fold a new tail snapshot into what we hold. The tail's copy of a sequence
 * wins (a patched payload, such as a moved tool body). A gap between our
 * newest event and the tail's oldest resets to the tail.
 */
export function mergeTail(held: readonly ThreadEvent[], tail: readonly ThreadEvent[]): MergeResult {
  const fresh = bySequence(tail);
  if (!held.length || !fresh.length) return { events: fresh.length ? fresh : bySequence(held), reset: false };
  const newestHeld = seq(held[held.length - 1]);
  const oldestTail = seq(fresh[0]);
  if (oldestTail > newestHeld + 1) return { events: fresh, reset: true };
  return { events: bySequence([...held, ...fresh]), reset: false };
}

/** Put an older page in front. A page that does not reach up to what we hold is ignored. */
export function prependPage(held: readonly ThreadEvent[], page: readonly ThreadEvent[]): ThreadEvent[] {
  const older = bySequence(page);
  if (!older.length) return [...held];
  if (held.length && seq(older[older.length - 1]) + 1 < seq(held[0])) return [...held];
  return bySequence([...older, ...held]);
}

/** The `beforeSeq` for the next older page, or null when the thread starts here. */
export function olderCursor(held: readonly ThreadEvent[]): number | null {
  if (!held.length) return null;
  const first = seq(held[0]);
  return first > 1 ? first : null;
}
