/**
 * Threadbear N8: the activity fold for a direct thread.
 *
 * Inside each stretch of agent rows (the rows between two user messages, or
 * after a turn footer), runs of routine work fold into one expandable
 * "Activity" row: reasoning, earlier commentary, and tool calls that finished
 * well. What the user has to see stays a row of its own:
 *   - a failure (a tool that failed or never finished, a failed turn footer);
 *   - an approval or question card, whatever its state;
 *   - the newest assistant text of the stretch, and the newest row of all;
 *   - a user message (a steer included), a diff, a plan, a note, a turn footer.
 * Only placement changes: every row keeps its identity and content.
 *
 * Pure: no React, no Convex, so node unit tests load it.
 */
import type { TranscriptRow } from "./types";

/** A row shown as itself, or a folded run of rows shown as one expandable row. */
export type PresentedItem =
  | { kind: "row"; row: TranscriptRow }
  | { kind: "fold"; fold: "activity" | "turn"; key: string; rows: TranscriptRow[]; durationMs?: number };

/** Fewer routine rows than this in a run are left as they are (a fold of one hides nothing). */
export const MIN_ACTIVITY_RUN = 2;

/** Whether a row is routine work that may fold. Failures and cards never are. */
export function isRoutineRow(row: TranscriptRow): boolean {
  switch (row.kind) {
    case "reasoning":
      return !row.streaming;
    case "assistant":
      return !row.streaming;
    case "tool":
      return Boolean(row.result?.ok);
    default:
      return false;
  }
}

/** Whether a row is something the user must see unfolded (a failure, an error, a card). */
export function mustStayVisible(row: TranscriptRow): boolean {
  switch (row.kind) {
    case "approval":
    case "question":
      return true;
    case "tool":
      return !row.result || !row.result.ok;
    case "turn":
      return row.outcome !== "completed";
    case "note":
      return row.tone === "danger";
    default:
      return false;
  }
}

/** Index of the newest assistant text with something in it, or -1. */
export function latestTextIndex(rows: readonly TranscriptRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "assistant" && row.text.trim()) return i;
  }
  return -1;
}

/**
 * Splits rows into stretches: each user message stands alone, and the agent
 * rows between them group, a turn footer closing its group (goal rounds run
 * several turns with no user message between them).
 */
export function stretches(rows: readonly TranscriptRow[]): TranscriptRow[][] {
  const out: TranscriptRow[][] = [];
  let current: TranscriptRow[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      if (current.length) out.push(current);
      out.push([row]);
      current = [];
      continue;
    }
    current.push(row);
    if (row.kind === "turn") {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * The activity fold over one stretch of agent rows. `isLast` marks the stretch
 * that ends the transcript, whose last row always stays visible.
 */
export function foldActivityStretch(rows: readonly TranscriptRow[], isLast: boolean): PresentedItem[] {
  const keep = latestTextIndex(rows);
  const out: PresentedItem[] = [];
  let run: TranscriptRow[] = [];
  const flush = () => {
    if (run.length >= MIN_ACTIVITY_RUN) out.push({ kind: "fold", fold: "activity", key: `activity:${run[0].key}`, rows: run });
    else for (const row of run) out.push({ kind: "row", row });
    run = [];
  };
  rows.forEach((row, i) => {
    const pinned = i === keep || (isLast && i === rows.length - 1);
    if (!pinned && isRoutineRow(row) && !mustStayVisible(row)) {
      run.push(row);
      return;
    }
    flush();
    out.push({ kind: "row", row });
  });
  flush();
  return out;
}

/** The activity fold alone over a whole transcript (rows in sequence order). */
export function foldActivity(rows: readonly TranscriptRow[]): PresentedItem[] {
  const parts = stretches(rows);
  return parts.flatMap((part, i) =>
    part[0]?.kind === "user" ? [{ kind: "row" as const, row: part[0] }] : foldActivityStretch(part, i === parts.length - 1),
  );
}

/** Every row a presented list stands for, in order (folds expanded). */
export function presentedRows(items: readonly PresentedItem[]): TranscriptRow[] {
  return items.flatMap((item) => (item.kind === "row" ? [item.row] : item.rows));
}
