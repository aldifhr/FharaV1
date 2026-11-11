/**
 * Threadbear N8: repeated failures, and the prompt "Retry last prompt" resends.
 *
 * An agent that refuses every turn (out of credits, signed out, a bad key)
 * answers each queued message with the same failed footer. Of a run of
 * identical failure-only turns only the latest footer stays, carrying the
 * number of turns it stands for; every user message stays.
 *
 * Pure: no React, no Convex.
 */
import type { TranscriptRow, TurnFooterRow } from "./types";

const FAILED: ReadonlySet<string> = new Set(["failed", "timed_out"]);

/** Whether a row is the footer of a failed or timed-out turn. */
export const isFailedFooter = (row: TranscriptRow): row is TurnFooterRow => row.kind === "turn" && FAILED.has(row.outcome);

const failureKey = (row: TurnFooterRow) => `${row.outcome}\n${(row.error ?? "").trim()}`;

/**
 * Collapse runs of identical failure-only turns. A turn is failure-only when
 * its failed footer is the only row between its user message and the next
 * one. A turn with any other row (text, a tool, a card, a note) ends the run.
 */
export function collapseRepeatedFailures(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  let last: { index: number; row: TurnFooterRow } | undefined;
  rows.forEach((row, i) => {
    if (row.kind === "user") {
      out.push(row);
      return;
    }
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const failureOnly = isFailedFooter(row) && prev?.kind === "user" && (!next || next.kind === "user");
    if (!failureOnly) {
      last = undefined;
      out.push(row);
      return;
    }
    if (last && failureKey(last.row) === failureKey(row)) {
      // Identical lines: the latest footer speaks for the ones it hides.
      const merged: TurnFooterRow = { ...row, repeats: (last.row.repeats ?? 1) + 1 };
      out.splice(last.index, 1);
      last = { index: out.length, row: merged };
      out.push(merged);
      return;
    }
    last = { index: out.length, row };
    out.push(row);
  });
  return out;
}

/**
 * The text "Retry last prompt" sends again, or null. Offered only when the
 * newest row is the footer of a failed or timed-out turn, no turn is running,
 * and the user message that turn answered is plain text (a slash command is
 * not resent). A turn the user stopped is not offered.
 */
export function retryablePrompt(rows: readonly TranscriptRow[], turnOpen: boolean): string | null {
  if (turnOpen) return null;
  const footer = rows.at(-1);
  if (!footer || !isFailedFooter(footer)) return null;
  for (let i = rows.length - 2; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "turn") return null;
    if (row.kind !== "user") continue;
    if (row.sending) return null;
    const text = row.text.trim();
    return text && !text.startsWith("/") ? text : null;
  }
  return null;
}
