import { splitTimedOutNodes, timedOutKeys } from "@/orchestrator/concernSplit";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { RunState } from "./types";
import { carryForwardState } from "./state";
import { persistPlan } from "./finalize";
import {
  finishOnPlanningError,
  requestPlan,
  type AuthoritativePlanResult,
  type PlanningContext,
} from "./planning";

/**
 * The subtasks of `plan` that already produced output, in the shape the
 * replan feedback lists them. Keys with no matching subtask in the plan
 * (stale state) are skipped: their output text is not a task description,
 * and without kind/capability carry-forward could never match them anyway.
 */
export function completedSubtasksFor(
  plan: Pick<ExecutionPlan, "subtasks">,
  state: Pick<RunState, "priorOutputs">
): CompletedSubtask[] {
  const completed: CompletedSubtask[] = [];
  for (const key of state.priorOutputs.keys()) {
    const subtask = plan.subtasks.find((candidate) => candidate.key === key);
    if (!subtask) continue;
    completed.push({
      key: subtask.key,
      kind: subtask.kind,
      capability: subtask.capability,
      description: subtask.description,
    });
  }
  return completed;
}

export type CompletedSubtask = {
  key: string;
  kind: string;
  capability: string;
  description: string;
};

/**
 * Replan feedback (Phase 3): the deterministic evaluator's summary plus
 * what the orchestrator itself decided and found along the way — the
 * decisions and open findings accumulated in the shared task context —
 * so the next plan is built with the orchestrator's evaluations as
 * input, not just the final verdict.
 */
export function buildReplanFeedback(
  base: string,
  sharedContext: SharedTaskContext,
  completedSubtasks?: Array<{ key: string; kind: string; capability: string; description: string }>
): string {
  const parts = [base];
  if (completedSubtasks && completedSubtasks.length > 0) {
    parts.push(
      "Already completed (DO NOT repeat these; reuse their descriptions verbatim so carry-forward matches): " +
        completedSubtasks
          .map((s) => `${s.key}: [${s.kind}/${s.capability}] ${s.description}`)
          .join(" | ")
    );
  }
  const decisions = sharedContext.decisions.slice(-6);
  if (decisions.length > 0) {
    parts.push(
      `Orchestrator evaluations: ${decisions
        .map(
          (decision) =>
            `${decision.decision}${decision.capability ? ` (${decision.capability})` : ""}: ${decision.reason}`
        )
        .join("; ")}`
    );
  }
  const openIssues = sharedContext.outstandingIssues
    .filter((issue) => issue.status === "open")
    .slice(-6);
  if (openIssues.length > 0) {
    parts.push(
      `Open findings: ${openIssues
        .map((issue) => `[${issue.severity}] ${issue.description}`)
        .join("; ")}`
    );
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

/**
 * The re-plan loop's mutable state, owned by `processTask`. `replanOnce`
 * advances it in place: a successful replan bumps `replans` and
 * `planVersion`, swaps in the new `plan`, records the `feedback` it was
 * built from, and replaces `completedKeys` with the carried-forward set.
 */
export interface ReplanLoopState {
  plan: ExecutionPlan;
  planVersion: number;
  replans: number;
  feedback?: string;
  completedKeys: Set<string>;
}

/**
 * One bounded re-plan (the ONE replan path for engine, verification and
 * execution-failure replans). The caller checks the planning-iteration
 * bound and cancellation first; this helper:
 *   1. increments `replans` and builds the feedback (base reason + the
 *      orchestrator's decisions/open findings + already-completed work),
 *   2. asks the planner for a new plan (budget/cancel during planning
 *      ends the task → returns "ended"),
 *   3. splits nodes named in `timedOutFrom` (a timed-out node is never
 *      retried as-is: the replan's copy is split per concern / per file group),
 *   4. persists the plan under the next version,
 *   5. carries forward completed work that matches the new plan (Step 5.3),
 *   6. logs `plan.replanned` (payload feedback = `eventFeedback` when given,
 *      else the built feedback).
 */
export async function replanOnce(
  pctx: PlanningContext,
  loop: ReplanLoopState,
  state: RunState,
  opts: { reason: string; eventFeedback?: string; timedOutFrom?: string }
): Promise<"replanned" | "ended"> {
  const { deps, task, project, classification } = pctx;
  loop.replans += 1;
  loop.feedback = buildReplanFeedback(
    opts.reason,
    pctx.sharedContext,
    completedSubtasksFor(loop.plan, state)
  );
  let replanned: AuthoritativePlanResult;
  try {
    replanned = await requestPlan(pctx, { feedback: loop.feedback });
  } catch (error) {
    await finishOnPlanningError(pctx, error);
    return "ended";
  }
  const previousPlan = loop.plan;
  loop.plan = replanned.plan;
  if (opts.timedOutFrom !== undefined) {
    const timedOut = timedOutKeys(opts.timedOutFrom);
    if (timedOut.length > 0) {
      const resplit = splitTimedOutNodes(loop.plan, previousPlan, timedOut, classification, {
        maxSubtasks: deps.policy.maxSubtasks,
        agents: pctx.agents,
      });
      loop.plan = resplit.plan;
      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "plan.timeout_split",
        payload: { timedOut, split: resplit.split, unsplittable: resplit.unsplittable },
        level: "warn",
      });
    }
  }
  loop.planVersion += 1;
  await persistPlan(deps, {
    taskId: task._id,
    projectId: project._id,
    plan: loop.plan,
    version: loop.planVersion,
    createdBy: replanned.createdBy,
    classification: classification.kind,
  });
  const carried = carryForwardState(previousPlan, state, loop.plan);
  loop.completedKeys = carried.completedKeys;
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "plan.replanned",
    payload: {
      replans: loop.replans,
      feedback: (opts.eventFeedback ?? loop.feedback).slice(0, 1000),
    },
    level: "warn",
  });
  return "replanned";
}
