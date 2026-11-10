// Portions adapted from t3code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/ThreadStream.ts (decideThreadResume,
// threadReplayEncodedBytes). MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.
//
// Pure, framework-free: shared by the Convex `since` queries and the web
// client's reconnect logic, so both agree on when to replay vs re-snapshot.

/** Replay at most this many events after a gap; beyond it, take a fresh snapshot. */
export const RESUME_MAX_REPLAY_EVENTS = 128;
/** ...or at most this many encoded bytes. */
export const RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/** UTF-8 size of the JSON encoding of `items`, stopping early once past `limit`. */
export function replayEncodedBytes(
  items: ReadonlyArray<unknown>,
  limit: number = RESUME_MAX_REPLAY_ENCODED_BYTES
): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const item of items) {
    total += encoder.encode(JSON.stringify(item) ?? "").length;
    if (total > limit) break;
  }
  return total;
}

export type ResumePlan =
  | { mode: "replay"; afterSequence: number; throughSequence: number }
  | { mode: "snapshot" };

/**
 * Bound replay by event count and encoded bytes; replace an excessive replay
 * (or a cursor from the future, e.g. after a reset) with one current snapshot.
 */
export function decideResume(input: {
  afterSequence: number;
  highWater: number;
  replayEventCount: number;
  replayEncodedBytes: number;
}): ResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: "snapshot" };
  }
  return { mode: "replay", afterSequence: input.afterSequence, throughSequence: input.highWater };
}

/** Anything with an optional per-scope sequence and a Convex creation time. */
export type SequencedRow = { _id: string; sequence?: number | null; _creationTime: number };

/**
 * Total order for event rows: numbered rows by sequence; legacy rows (written
 * before sequences existed) by `_creationTime`, always before numbered ones,
 * matching the `by_*_and_sequence` index order (undefined sorts lowest).
 */
export function compareSequenced(a: SequencedRow, b: SequencedRow): number {
  const as = typeof a.sequence === "number" ? a.sequence : null;
  const bs = typeof b.sequence === "number" ? b.sequence : null;
  if (as !== null && bs !== null && as !== bs) return as - bs;
  if (as === null && bs !== null) return -1;
  if (as !== null && bs === null) return 1;
  return a._creationTime - b._creationTime;
}

/**
 * Merge a freshly received window into what the client already holds:
 * dedupe by `_id`, drop nothing older the caller still wants, keep order.
 * (Client rule from t3code's thread state: skip items it already has.)
 */
export function mergeSequenced<T extends SequencedRow>(held: ReadonlyArray<T>, incoming: ReadonlyArray<T>): T[] {
  const byId = new Map<string, T>();
  for (const row of held) byId.set(row._id, row);
  for (const row of incoming) byId.set(row._id, row);
  return [...byId.values()].sort(compareSequenced);
}

/** Highest sequence present (0 when none is numbered). */
export function highWater(rows: ReadonlyArray<SequencedRow>): number {
  let max = 0;
  for (const row of rows) if (typeof row.sequence === "number" && row.sequence > max) max = row.sequence;
  return max;
}

/**
 * True when a new window no longer overlaps what the client last saw: its
 * lowest numbered sequence is past `lastSeen + 1`, so events in between were
 * never delivered (the tab slept or the socket dropped while the window moved).
 */
export function hasGap(lastSeen: number, window: ReadonlyArray<SequencedRow>): boolean {
  if (lastSeen <= 0) return false;
  let min = Infinity;
  for (const row of window) if (typeof row.sequence === "number" && row.sequence < min) min = row.sequence;
  return Number.isFinite(min) && min > lastSeen + 1;
}
