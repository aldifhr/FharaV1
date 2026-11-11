/**
 * ui-g13: the quiet System line for a task's CTO decision turn (G13,
 * apps/api/convex/decisionTurns.ts). While the question waits on the CTO it
 * says so with the time left; an answer shows its summary; an expired or
 * declined turn says the question went to the user. Never an @name.
 *
 * Pure, so tests/unit/ctoTurnLine.test.mjs can run it under node:test.
 */
import { normalizeSystemLine } from "@/api/convex/lib/systemLine";

export type CtoTurn = {
  status: "open" | "answered" | "escalated" | "expired";
  expiresAt: number;
  answer?: string | null;
  chosenOption?: string | null;
};

const SUMMARY_MAX = 140;

/** "9m", "1h 5m", "under a minute". */
export function timeLeft(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** The answer's first line, bounded; the chosen option leads when there is one. */
export function answerSummary(turn: Pick<CtoTurn, "answer" | "chosenOption">): string {
  const first = (turn.answer ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
  const chosen = turn.chosenOption?.trim() ?? "";
  const text = chosen && first && !first.startsWith(chosen) ? `${chosen}: ${first}` : chosen || first;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/** The System line text for a turn, or null when there is nothing to say. */
export function ctoTurnLine(turn: CtoTurn | null | undefined, now: number): string | null {
  if (!turn) return null;
  let text: string;
  switch (turn.status) {
    case "open": {
      const left = turn.expiresAt - now;
      text = left > 0 ? `Waiting on CTO · expires in ${timeLeft(left)}` : "Waiting on CTO · expiring";
      break;
    }
    case "answered": {
      const summary = answerSummary(turn);
      text = summary ? `CTO answered · ${summary}` : "CTO answered";
      break;
    }
    case "expired":
    case "escalated":
      text = "Sent to you";
      break;
    default:
      return null;
  }
  return normalizeSystemLine(text);
}

/** How often the line re-renders: every 15s while a turn is open, never otherwise. */
export const ctoTurnTickMs = (turn: CtoTurn | null | undefined): number | null => (turn?.status === "open" ? 15_000 : null);
