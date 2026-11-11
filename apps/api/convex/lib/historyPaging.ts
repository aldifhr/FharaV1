/**
 * History paging (D12): the live view holds the newest window of a thread;
 * older rows arrive in pages keyed by a cursor (the oldest `_creationTime`
 * for messages, the oldest `sequence` for task events). Pure helpers shared
 * by the Convex cursor queries, the web hook and the tests.
 */

/** Newest-window size of the live message queries (listByTask, listByProject, listByConversation). */
export const MESSAGE_WINDOW = 500;
/** Rows per "Load earlier" page. */
export const HISTORY_PAGE_SIZE = 200;
/** Ceiling for one page, including a jump page that fills down to an outline turn. */
export const HISTORY_PAGE_MAX = 1000;
/** Rows the turn outline scans per scope, newest first. */
export const TURN_OUTLINE_SCAN_MAX = 5000;
/** Characters of a turn's first line shown in the outline. */
export const TURN_PREVIEW_CHARS = 80;
/** Pages one jump may load before it gives up (5 × HISTORY_PAGE_MAX rows). */
export const JUMP_PAGES_MAX = 5;

export type HistoryRow = { _id: string; _creationTime: number };

/** One page of older rows, oldest first. `reachedFloor` is false when a floor was asked for and rows remain above it. */
export type EarlierPage<T> = { rows: T[]; hasMore: boolean; reachedFloor: boolean };

export function pageSize(limit: number | undefined): number {
  return Math.min(Math.max(Math.floor(limit ?? HISTORY_PAGE_SIZE), 1), HISTORY_PAGE_MAX);
}

/** Older pages plus the live window as one list: deduplicated by id (the live copy wins), oldest first. */
export function mergeHistory<T extends HistoryRow>(earlier: readonly T[], live: readonly T[]): T[] {
  if (!earlier.length) return live as T[];
  const liveIds = new Set<string>();
  for (const row of live) liveIds.add(row._id);
  const older = earlier.filter((row) => !liveIds.has(row._id));
  if (!older.length) return live as T[];
  const liveOldest = live.length ? live[0]._creationTime : Infinity;
  // Fast path: every older row predates the live window, and both lists are sorted.
  if (older[older.length - 1]._creationTime <= liveOldest) return [...older, ...live];
  return [...older, ...live].sort((a, b) => a._creationTime - b._creationTime);
}

/** The cursor for the next older page: the oldest creation time held. */
export function oldestCursor(rows: readonly HistoryRow[]): number | undefined {
  let oldest: number | undefined;
  for (const row of rows) if (oldest === undefined || row._creationTime < oldest) oldest = row._creationTime;
  return oldest;
}

/** Turn preview: the first non-empty line, cut to TURN_PREVIEW_CHARS. */
export function turnPreview(content: string): string {
  const line = content.split("\n").find((part) => part.trim()) ?? "";
  const text = line.trim().replace(/\s+/g, " ");
  return text.length > TURN_PREVIEW_CHARS ? `${text.slice(0, TURN_PREVIEW_CHARS - 1)}…` : text;
}

export type FetchEarlier<T> = (args: { before: number; floor?: number; limit?: number }) => Promise<EarlierPage<T>>;

/**
 * Load older rows. Without a floor this loads one page. With a floor (a
 * jump to an outline turn) it keeps paging until the floor is covered, so
 * the turn's page is loaded and the list stays contiguous.
 */
export async function loadEarlier<T extends HistoryRow>(
  fetchPage: FetchEarlier<T>,
  held: { earlier: T[]; live: T[] },
  opts: { floor?: number; limit?: number } = {}
): Promise<{ earlier: T[]; hasMore: boolean }> {
  let earlier = held.earlier;
  let hasMore = true;
  for (let i = 0; i < (opts.floor === undefined ? 1 : JUMP_PAGES_MAX); i++) {
    const before = oldestCursor(earlier.length ? earlier : held.live);
    if (before === undefined) return { earlier, hasMore: false };
    if (opts.floor !== undefined && before <= opts.floor) break;
    const page = await fetchPage({
      before,
      ...(opts.floor !== undefined ? { floor: opts.floor, limit: HISTORY_PAGE_MAX } : { limit: opts.limit }),
    });
    earlier = [...page.rows, ...earlier];
    hasMore = page.hasMore;
    if (!page.rows.length || page.reachedFloor || !hasMore) break;
  }
  return { earlier, hasMore };
}
