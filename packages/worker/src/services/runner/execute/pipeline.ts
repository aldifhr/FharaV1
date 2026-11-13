import { failureKindForExit, type FailureKind, type StageOrder } from "@/orchestrator/decisionEngine";
import { snapshotIdForChanges } from "@/tools/gitDiff";
import type { RunContext } from "../types";
import type { PreparedApply } from "../applyStage";
import type { SchedulerResult } from "@/scheduler/dagScheduler";

// Interpretation of one `executePlan` invocation. `replan` carries the
// objective-missing feedback processTask's bounded re-plan consumes,
// and `waiting_input` means the task was paused by the backend
// `pauseForInput` mutation (plan 013 step 4) — the caller simply ends
// the invocation; the answer re-queues the task.
export interface ExecutePlanResult {
  status: "completed" | "failed" | "waiting_approval" | "cancelled" | "step_limit" | "replan" | "waiting_input" | "paused";
  replanFeedback?: string;
  /** Item 7: why a failed / cancelled / step-limited run ended (additive; status is unchanged). */
  failureKind?: FailureKind;
}

/** What the phases of one invocation share besides the RunContext. */
export interface PipelineState {
  ctx: RunContext;
  order: StageOrder;
  /**
   * Snapshot of the staged changes when this invocation started. A resumed
   * invocation's approval covers exactly this set (the approval was asked
   * for at the end of the previous invocation).
   */
  baseSnapshotId: string;
  /** A failed implementation held back for its decision boundary (implementPhase). */
  implementationFailed?: SchedulerResult;
  /** Set by the prepare phase: the reviewed change set and its dry-run summary. */
  prepared?: PreparedApply;
  /** Set by the approval phase (verified_first): who accepted the merge. */
  accepted?: "user" | "auto" | null;
}

/**
 * A phase either continues (optionally asking for a decision boundary
 * after it: "check" = terminalExit, "observe" = re-read a user pause first,
 * then terminalExit) or ends the invocation with a terminal outcome.
 */
export type PhaseStep =
  | { kind: "continue"; boundary?: "check" | "observe" }
  | { kind: "exit"; result: ExecutePlanResult };

export interface Phase {
  (state: PipelineState): Promise<PhaseStep>;
  /** Item 7: what a "failed" exit of this phase means, unless the exit names its own kind. */
  failureKind?: FailureKind;
}

export const next = (boundary?: "check" | "observe"): PhaseStep =>
  boundary ? { kind: "continue", boundary } : { kind: "continue" };
export const exit = (result: ExecutePlanResult): PhaseStep => ({ kind: "exit", result });

/** Tag a phase with the failure kind its failed exits carry. */
export function failingAs(phase: Phase, failureKind: FailureKind): Phase {
  const tagged: Phase = (state) => phase(state);
  tagged.failureKind = failureKind;
  return tagged;
}

/** The terminal outcome with its failure kind (item 7). */
function withFailureKind(result: ExecutePlanResult, phase: Phase | null, ctx: RunContext): ExecutePlanResult {
  const failureKind = failureKindForExit({
    status: result.status,
    explicit: result.failureKind,
    phaseKind: phase?.failureKind,
    budgetHalt: ctx.budgetHalt,
    snapshotReview: ctx.state.reviewBySnapshot?.[snapshotIdForChanges(Array.from(ctx.state.fileChanges.values()))],
  });
  return failureKind ? { ...result, failureKind } : result;
}

/** A failure that is really a cancellation reports as cancelled. */
export function failedOrCancelled(ctx: RunContext): ExecutePlanResult {
  return { status: ctx.taskCancelled() ? "cancelled" : "failed" };
}

/**
 * Decision-terminal exits at stage boundaries, never mid-node:
 * `waiting_input` (plan 013 step 4) wins over `replan` (step 3) — a
 * question the user can still answer is worth more than re-planning
 * the same gap. Cancellation always wins over replan.
 */
function terminalExit(ctx: RunContext): ExecutePlanResult | null {
  if (ctx.waitingForInput !== null) return { status: "waiting_input" };
  // Plan 022: a user pause ends the invocation at the boundary; the
  // stored plan + completed rows are the checkpoint Resume continues from.
  if (ctx.paused && !ctx.taskCancelled()) return { status: "paused" };
  if (ctx.replanFeedback !== null && !ctx.taskCancelled()) {
    return { status: "replan", replanFeedback: ctx.replanFeedback };
  }
  return null;
}

/**
 * Plan 022: re-read the task status at a stage boundary so a user pause
 * that landed while no scheduler was polling (review/apply/QA) is seen.
 */
async function observePause(ctx: RunContext): Promise<void> {
  if (ctx.paused) return;
  const current = await ctx.deps.api.getContext({ taskId: ctx.taskId }).catch(() => null);
  if (current?.task.status === "paused") ctx.paused = true;
}

/**
 * Run the phases in order. The ONE place a decision boundary (terminalExit)
 * is evaluated; a phase that ends the invocation returns its own outcome.
 */
export async function runPipeline(phases: ReadonlyArray<Phase>, state: PipelineState): Promise<ExecutePlanResult> {
  for (const phase of phases) {
    const step = await phase(state);
    if (step.kind === "exit") return withFailureKind(step.result, phase, state.ctx);
    if (!step.boundary) continue;
    if (step.boundary === "observe") await observePause(state.ctx);
    const stop = terminalExit(state.ctx);
    if (stop) return withFailureKind(stop, null, state.ctx);
  }
  return { status: "completed" };
}
