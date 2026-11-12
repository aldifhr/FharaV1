/**
 * Thread rename (Paradev B3): the pure parts shared by the task header and
 * the chat header. The server (`threads.rename`) normalises
 * the same way and refuses blanks; this mirrors it so the UI can refuse an
 * empty title before a round trip and show the new title at once.
 */

/** Same cap as `TITLE_MAX` in apps/api/convex/lib/threadIndex.ts. */
export const RENAME_TITLE_MAX = 200;

export type RenameRef = { taskId: string } | { conversationId: string };

export type RenameDraft =
  | { kind: "save"; title: string }
  | { kind: "unchanged" }
  | { kind: "empty" };

/** Collapse whitespace, trim and cap, like the server's `normaliseTitle`. */
export function normaliseRenameTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, RENAME_TITLE_MAX);
}

/** What submitting `input` should do: save it, close with nothing to save, or refuse it. */
export function renameDraft(input: string, current: string): RenameDraft {
  const title = normaliseRenameTitle(input);
  if (!title) return { kind: "empty" };
  if (title === normaliseRenameTitle(current)) return { kind: "unchanged" };
  return { kind: "save", title };
}

const sameThread = (row: { taskId?: unknown; conversationId?: unknown }, ref: RenameRef) =>
  "taskId" in ref ? String(row.taskId ?? "") === ref.taskId : String(row.conversationId ?? "") === ref.conversationId;

/**
 * `threads.list` rows with the renamed thread's title replaced, for the
 * optimistic update. Returns the same array when nothing matched.
 */
export function withRenamedRow<T extends { taskId?: unknown; conversationId?: unknown; title: string }>(
  rows: T[],
  ref: RenameRef,
  title: string,
): T[] {
  if (!rows.some((row) => sameThread(row, ref))) return rows;
  return rows.map((row) => (sameThread(row, ref) ? { ...row, title } : row));
}
