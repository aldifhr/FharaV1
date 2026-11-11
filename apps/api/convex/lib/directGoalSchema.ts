/**
 * Goal mode for direct threads (DeepSeek Harness D8): the stored shape of
 * `tasks.direct.goal`, the worker's patch to it, and the pure rules both
 * sides share. No Convex server imports: schema.ts, the mutations
 * (lib/directGoal.ts) and the worker (packages/worker/src/direct/goal.ts)
 * all import it.
 *
 * The state machine follows the pattern of DeepSeek Harness
 * `packages/goal/goal/src/{types,domain}.ts` (MIT, Copyright (c) 2026
 * DeepSeek, commit e8f7b93a); no code is copied from those files.
 *
 * Who writes what:
 *   - the user (setGoal / pauseGoal / clearGoal, or `/goal` in the thread):
 *     a new goal (new `id`), pause, resume; each bumps `rev`;
 *   - the worker (appendEvents state patch, lease-fenced): the round it
 *     started, a terminal phase (complete / blocked), a stopped round
 *     (paused) and `wrappedUp`. A patch for another goal id is ignored, so a
 *     cleared or replaced goal is never revived by a late worker write.
 */
import { v, type Infer } from "convex/values";

export const goalPhaseValidator = v.union(v.literal("active"), v.literal("paused"), v.literal("blocked"), v.literal("complete"));
export const goalBlockedValidator = v.object({ code: v.string(), message: v.string() });

export const directGoalValidator = v.object({
  id: v.string(),
  objective: v.string(),
  maxRounds: v.number(),
  // Rounds started so far (the wrap-up turn is not a round).
  round: v.number(),
  phase: goalPhaseValidator,
  blockedReason: v.optional(goalBlockedValidator),
  // The closing turn after complete/blocked has run (or is not wanted: a timed-out agent).
  wrappedUp: v.optional(v.boolean()),
  // User revision: bumped by every user change, never by the worker.
  rev: v.number(),
  setAt: v.number(),
  updatedAt: v.number(),
});

/** What the worker may change, for the goal it names. */
export const goalWorkerPatchValidator = v.object({
  goalId: v.string(),
  round: v.optional(v.number()),
  phase: v.optional(goalPhaseValidator),
  blockedReason: v.optional(goalBlockedValidator),
  wrappedUp: v.optional(v.boolean()),
});

export type GoalPhase = Infer<typeof goalPhaseValidator>;
export type DirectGoal = Infer<typeof directGoalValidator>;
export type GoalWorkerPatch = Infer<typeof goalWorkerPatchValidator>;

export const GOAL_DEFAULT_ROUNDS = 10;
export const GOAL_MAX_ROUNDS = 50;
export const GOAL_OBJECTIVE_MAX = 2_000;

export const isGoalTerminal = (phase: GoalPhase): boolean => phase === "complete" || phase === "blocked";

/**
 * A worker patch applied to a goal. Rounds only grow (up to the limit); a
 * terminal report always lands (it is a fact about a round that ran);
 * `paused` (a stopped round) only replaces `active`.
 */
export function applyGoalPatch(goal: DirectGoal | undefined, patch: GoalWorkerPatch, now: number): DirectGoal | undefined {
  if (!goal || goal.id !== patch.goalId) return goal;
  const next: DirectGoal = { ...goal, updatedAt: now };
  if (patch.round !== undefined) next.round = Math.min(goal.maxRounds, Math.max(goal.round, Math.floor(patch.round)));
  if (patch.phase && isGoalTerminal(patch.phase)) {
    next.phase = patch.phase;
    if (patch.blockedReason) next.blockedReason = { code: patch.blockedReason.code.slice(0, 40), message: patch.blockedReason.message.slice(0, 1000) };
    else delete next.blockedReason;
  } else if (patch.phase === "paused" && goal.phase === "active") next.phase = "paused";
  if (patch.wrappedUp) next.wrappedUp = true;
  return next;
}

/** Whether the thread has goal work a worker should pick up. */
export function goalWantsWorker(goal: DirectGoal | undefined | null, held: boolean): boolean {
  if (!goal || held) return false;
  return goal.phase === "active" || (isGoalTerminal(goal.phase) && !goal.wrappedUp);
}

export type GoalCommand =
  | { action: "set"; objective: string; maxRounds: number }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" };

/**
 * The arguments of `/goal`: `pause`, `resume`, `clear`, or
 * `<objective> [rounds]`, where a last token that is a whole number from 1
 * to GOAL_MAX_ROUNDS is the round limit. Null when nothing is given.
 */
export function parseGoalArgs(args: string): GoalCommand | null {
  const text = args.trim();
  const word = text.toLowerCase();
  if (word === "pause" || word === "resume" || word === "clear") return { action: word };
  if (!text) return null;
  const m = /^([\s\S]*\S)\s+(\d{1,3})$/.exec(text);
  const n = m ? Number(m[2]) : NaN;
  if (m && n >= 1 && n <= GOAL_MAX_ROUNDS) return { action: "set", objective: m[1].slice(0, GOAL_OBJECTIVE_MAX), maxRounds: n };
  return { action: "set", objective: text.slice(0, GOAL_OBJECTIVE_MAX), maxRounds: GOAL_DEFAULT_ROUNDS };
}

/** The one-line summary the thread header shows. */
export function goalStatusLine(goal: Pick<DirectGoal, "phase" | "round" | "maxRounds" | "blockedReason">): string {
  const rounds = `round ${goal.round}/${goal.maxRounds}`;
  if (goal.phase === "blocked") return `Goal blocked (${goal.blockedReason?.code ?? "blocked"}) · ${rounds}`;
  if (goal.phase === "complete") return `Goal complete · ${rounds}`;
  if (goal.phase === "paused") return `Goal paused · ${rounds}`;
  return `Goal · ${rounds}`;
}
