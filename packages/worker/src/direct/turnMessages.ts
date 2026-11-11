/**
 * The direct runner's user-facing texts and usage sum, split out of
 * threadRunner.ts (which re-exports them) to keep it under the line budget.
 */
import type { TurnTimeoutReason } from "@/vendor/nuphos/turnTimers";
import type { TurnUsage } from "./types";

export type TurnTimeout = { reason: TurnTimeoutReason; windowMs: number; waitingOnApproval: boolean };

function span(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  return `${min} min`;
}

/** What the person reads when the watchdog stops a turn. */
export function timeoutMessage(t: TurnTimeout): string {
  const why = t.waitingOnApproval
    ? `This turn waited on an approval for ${span(t.windowMs)}`
    : t.reason === "no_output"
      ? `The agent sent nothing for ${span(t.windowMs)}`
      : `The agent stayed connected but made no progress (no text, tool or plan updates) for ${span(t.windowMs)}`;
  return `${why}, so the turn was stopped. Send a message to continue.`;
}

/** What the person (and the card) read when a card expires unanswered. */
export function expiredMessage(maxMs: number): string {
  return `No one answered this approval within ${span(maxMs)}, so it expired and the agent was told no. The turn goes on.`;
}

/** Two turn usages summed (a steered turn reports more than once). */
export function addUsage(a: TurnUsage | undefined, b: TurnUsage): TurnUsage {
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cachedReadTokens || b.cachedReadTokens ? { cachedReadTokens: (a.cachedReadTokens ?? 0) + (b.cachedReadTokens ?? 0) } : {}),
    ...(b.costUsd !== undefined || a.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
    ...(b.model ?? a.model ? { model: b.model ?? a.model } : {}),
  };
}
