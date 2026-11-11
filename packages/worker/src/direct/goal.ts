/**
 * Goal mode for direct threads (D8): what the runner (threadRunner.ts) asks
 * between turns. Pure: the end-of-turn marker, merging the stored goal with
 * what this worker already reported, the next step, and what a finished
 * round means for the goal.
 *
 * The stored shape and the server rules live in
 * apps/api/convex/lib/directGoalSchema.ts; the prompts are adapted copies
 * (vendor/deepseek-harness/goalPrompts.ts).
 */
import { isGoalTerminal, type DirectGoal, type GoalWorkerPatch } from "@/api/convex/lib/directGoalSchema";
import type { TurnOutcome } from "./types";

export type { DirectGoal, GoalWorkerPatch };
export { renderGoalRoundPrompt, renderWrapupPrompt } from "@/vendor/deepseek-harness/goalPrompts";

/** How the agent reports, said in every round prompt. */
export const GOAL_MARKER_RULE =
  "End your reply with one final line: `GOAL: complete` once the whole objective is achieved and verified, " +
  "`GOAL: blocked: <reason>` when you cannot go on without the user, or no such line when work remains for the next round.";

export type GoalMarker = { kind: "complete" } | { kind: "blocked"; reason: string };

const MARKER = /^[\s*_`>]*GOAL:\s*(complete|blocked)\b\s*:?\s*(.*?)[\s*_`]*$/i;

/** The marker on the last non-empty line of the reply, if there is one. */
export function parseGoalMarker(text: string | undefined): GoalMarker | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const m = lines.length ? MARKER.exec(lines[lines.length - 1]) : null;
  if (!m) return null;
  if (m[1].toLowerCase() === "complete") return { kind: "complete" };
  return { kind: "blocked", reason: m[2].trim().slice(0, 1000) || "The agent reported it is blocked." };
}

/**
 * The stored goal (poll) merged with this worker's own view. A different
 * goal id, or a newer user revision, is the user's change and wins; the
 * fields the worker owns (rounds, a terminal report, wrappedUp) never move
 * back because a poll read the row before this worker's patch landed.
 */
export function mergeGoal(local: DirectGoal | null, stored: DirectGoal | null): DirectGoal | null {
  if (!stored) return null;
  if (!local || local.id !== stored.id) return stored;
  const round = Math.max(local.round, stored.round);
  const wrappedUp = local.wrappedUp || stored.wrappedUp ? true : undefined;
  const base = stored.rev !== local.rev ? stored : local;
  const out: DirectGoal = { ...base, round, ...(wrappedUp ? { wrappedUp } : {}) };
  if (isGoalTerminal(local.phase)) {
    out.phase = local.phase;
    if (local.blockedReason) out.blockedReason = local.blockedReason;
  }
  return out;
}

export type GoalStep = "none" | "held" | "round" | "round-limit" | "wrapup";

/** What to do while no turn is live. G3 hold: nothing new starts. */
export function nextGoalStep(goal: DirectGoal | null, held: boolean): GoalStep {
  if (!goal || goal.phase === "paused") return "none";
  if (isGoalTerminal(goal.phase)) return goal.wrappedUp ? "none" : held ? "held" : "wrapup";
  if (held) return "held";
  return goal.round >= goal.maxRounds ? "round-limit" : "round";
}

export type GoalUpdate = { patch: Omit<GoalWorkerPatch, "goalId">; action: string };

export const roundLimitUpdate = (goal: DirectGoal): GoalUpdate => ({
  action: "blocked",
  patch: { phase: "blocked", blockedReason: { code: "round-limit", message: `Used all ${goal.maxRounds} rounds before the objective was marked complete.` } },
});

/**
 * What a finished round means for the goal. The watchdog stopping it (N3)
 * or the turn failing blocks the goal with no wrap-up (the agent is not
 * answering well enough for one); Stop pauses it; otherwise the reply's
 * marker decides, and no marker leaves it active for the next round.
 */
export function roundOutcome(outcome: TurnOutcome, error: string | undefined, lastText: string | undefined): GoalUpdate | null {
  if (outcome === "timed_out" || outcome === "failed") {
    const code = outcome === "timed_out" ? "timeout" : "turn-failed";
    return { action: "blocked", patch: { phase: "blocked", blockedReason: { code, message: error ?? `The round ${outcome === "failed" ? "failed" : "timed out"}.` }, wrappedUp: true } };
  }
  if (outcome === "interrupted") return { action: "paused", patch: { phase: "paused" } };
  const marker = parseGoalMarker(lastText);
  if (!marker) return null;
  if (marker.kind === "complete") return { action: "complete", patch: { phase: "complete" } };
  return { action: "blocked", patch: { phase: "blocked", blockedReason: { code: "agent", message: marker.reason } } };
}

export const GOAL_HELD_NOTE = "Goal rounds are waiting: automation is held. They go on once the hold is lifted.";
/** Said to the agent when it asks for a tool during the wrap-up turn. */
export const WRAPUP_NO_TOOLS = "The goal is wrapping up: no more tools in this turn. Write the closing message instead.";
