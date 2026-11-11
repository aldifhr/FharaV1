/**
 * Threadbear N8: the turn fold, and the presentation that puts both folds together.
 *
 * A finished turn folds into one "Worked for …" row, its answer and footer
 * still showing, when:
 *   - its footer says it completed;
 *   - its last row before the footer is the answer (assistant text with something in it);
 *   - every tool in it finished well, and it holds no card, failure or danger note;
 *   - it did some work before the answer (a tool, reasoning, earlier text, a diff, a plan).
 * A turn that does not qualify (still running, stopped, failed, or holding a
 * card or a failure) gets the activity fold instead, which never folds a
 * failure or a card either.
 *
 * Pure: no React, no Convex.
 */
import { foldActivityStretch, isRoutineRow, mustStayVisible, stretches, type PresentedItem } from "./activityFold";
import type { TranscriptRow, TurnFooterRow } from "./types";

/** Rows that may sit inside a turn fold besides routine work. */
const FOLDABLE_EXTRA: ReadonlySet<TranscriptRow["kind"]> = new Set(["diff", "plan"]);

/**
 * Where a stretch's turn fold ends: the index of its answer row (everything
 * before it folds), or -1 when the stretch does not fold by turn.
 */
export function turnFoldSplit(rows: readonly TranscriptRow[]): number {
  const footerAt = rows.length - 1;
  const footer = rows[footerAt];
  if (!footer || footer.kind !== "turn" || footer.outcome !== "completed") return -1;
  const answerAt = footerAt - 1;
  const answer = rows[answerAt];
  if (answerAt < 1 || !answer || answer.kind !== "assistant" || answer.streaming || !answer.text.trim()) return -1;
  for (let i = 0; i < answerAt; i++) {
    const row = rows[i];
    if (mustStayVisible(row)) return -1;
    if (!isRoutineRow(row) && !FOLDABLE_EXTRA.has(row.kind)) return -1;
  }
  return answerAt;
}

/** One stretch as shown: a turn fold when it qualifies, else the activity fold. */
export function foldTurnStretch(rows: readonly TranscriptRow[], isLast: boolean): PresentedItem[] {
  const split = turnFoldSplit(rows);
  if (split < 0) return foldActivityStretch(rows, isLast);
  const folded = rows.slice(0, split);
  const footer = rows[rows.length - 1] as TurnFooterRow;
  return [
    { kind: "fold", fold: "turn", key: `turn:${folded[0].key}`, rows: folded, durationMs: footer.durationMs },
    ...rows.slice(split).map((row) => ({ kind: "row" as const, row })),
  ];
}

/**
 * The direct transcript as shown: user messages as rows, each stretch of agent
 * rows turn-folded or activity-folded. `rows` are the reducer's output (after
 * `collapseRepeatedFailures`), oldest first.
 */
export function presentTranscript(rows: readonly TranscriptRow[]): PresentedItem[] {
  const parts = stretches(rows);
  return parts.flatMap((part, i) =>
    part[0]?.kind === "user" ? [{ kind: "row" as const, row: part[0] }] : foldTurnStretch(part, i === parts.length - 1),
  );
}
