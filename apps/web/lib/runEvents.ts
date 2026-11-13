/**
 * ui-g13: "Load earlier" for a run's raw events (D12 taskEvents.pageEarlier).
 * runs.get holds the newest window; older pages are fetched by the oldest
 * sequence held and shown in the same shape. Pure, for tests/unit/runEvents.test.mjs.
 */

/** One row as the Raw events list shows it (the shape runs.get returns). */
export type RawEvent = {
  _id: string;
  sequence: number | null;
  type: string;
  level: string;
  message: string | null;
  subtaskKey: string | null;
  payload?: string | null;
  createdAt: number;
};

/** Same cap runs.get puts on message and payload text. */
const RAW_EVENT_TEXT_CAP = 2_000;

const cap = (text: string | undefined | null): string | null =>
  text == null ? null : text.length > RAW_EVENT_TEXT_CAP ? `${text.slice(0, RAW_EVENT_TEXT_CAP)}…` : text;

/** A taskEvents document from pageEarlier, in the Raw events shape. */
export function toRawEvent(doc: {
  _id: string;
  _creationTime: number;
  sequence?: number;
  type: string;
  level?: string;
  message?: string;
  subtaskKey?: string;
  payload?: unknown;
  createdAt?: number;
}): RawEvent {
  return {
    _id: doc._id,
    sequence: typeof doc.sequence === "number" ? doc.sequence : null,
    type: doc.type,
    level: doc.level ?? "info",
    message: cap(doc.message),
    subtaskKey: doc.subtaskKey ?? null,
    payload: doc.payload === undefined ? null : cap(JSON.stringify(doc.payload)),
    createdAt: doc.createdAt ?? doc._creationTime,
  };
}

/** The cursor for the next older page: the lowest sequence held, or null when none is numbered. */
export function oldestSequence(rows: readonly RawEvent[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) if (row.sequence !== null && (oldest === null || row.sequence < oldest)) oldest = row.sequence;
  return oldest;
}

/** Older pages plus the live window, deduplicated by id (live wins), oldest first. */
export function mergeRawEvents(earlier: readonly RawEvent[], live: readonly RawEvent[]): RawEvent[] {
  if (!earlier.length) return live as RawEvent[];
  const liveIds = new Set(live.map((row) => row._id));
  const older = earlier.filter((row) => !liveIds.has(row._id));
  // Legacy rows without a sequence sort first, as on by_task_and_sequence.
  const key = (row: RawEvent) => (row.sequence === null ? -Infinity : row.sequence);
  return [...older, ...live].sort((a, b) => key(a) - key(b) || a.createdAt - b.createdAt);
}
