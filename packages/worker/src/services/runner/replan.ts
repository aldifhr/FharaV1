import { splitTimedOutNodes, timedOutKeys } from "@/orchestrator/concernSplit";
import type { ExecutionPlan } from "@/types";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { RunState } from "./types";
import { carryForwardState } from "./state";
import {
  buildReplanScope,
  checkReplanQuality,
  computeImpact,
  describeViolations,
  diffPlans,
  frozenNodesFor,
  preserveFrozen,
  resolveFailedKeys,
  stripReplanAnnotations,
  type ReplanRecord,
  type ReplanViolation,
} from "@/orchestrator/replanIntelligence";
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
 * A rejected replan (quality check failed twice) leaves the plan as it was
 * and sets `rejection` to the message the task fails with.
 */
export interface ReplanLoopState {
  plan: ExecutionPlan;
  planVersion: number;
  replans: number;
  feedback?: string;
  completedKeys: Set<string>;
  rejection?: string;
}

/** Deterministic replan scope, computed before the planner is asked anything. */
export interface ReplanScopeFacts {
  failedKeys: string[];
  impactKeys: string[];
  frozenKeys: string[];
  facts: string[];
}

/** Output a completed node produced (recorded output, else the delivered one). */
function outputOf(state: Pick<RunState, "priorOutputs" | "deliveredOutputs">, key: string): string | undefined {
  return state.priorOutputs.get(key) ?? state.deliveredOutputs?.get(key);
}

export function computeReplanScope(
  plan: ExecutionPlan,
  state: Pick<RunState, "priorOutputs" | "deliveredOutputs" | "reviewVerdicts" | "feedback">,
  completedKeys: Iterable<string>,
  reason: string,
  explicitFailedKeys?: string[]
): ReplanScopeFacts {
  const facts = [reason, ...state.feedback].filter((fact) => fact && fact.trim().length > 0);
  const failedKeys = resolveFailedKeys(plan, facts, explicitFailedKeys);
  const impactKeys = computeImpact(plan.subtasks, failedKeys);
  const frozenKeys = frozenNodesFor({
    plan,
    completed: new Set([...completedKeys, ...state.priorOutputs.keys(), ...(state.deliveredOutputs?.keys() ?? [])]),
    failedKeys,
    impactKeys,
    reviewVerdicts: state.reviewVerdicts,
  }).filter((key) => outputOf(state, key) !== undefined);
  return { failedKeys, impactKeys, frozenKeys, facts: [...new Set(facts)] };
}

/**
 * One bounded re-plan (the ONE replan path for engine, verification and
 * execution-failure replans). The caller checks the planning-iteration
 * bound and cancellation first; this helper:
 *   1. computes the deterministic scope: failed nodes, their downstream
 *      impact set, and the frozen (valid completed) nodes,
 *   2. increments `replans` and builds the feedback (base reason + the
 *      orchestrator's decisions/open findings + already-completed work +
 *      the replan scope block),
 *   3. asks the planner for a new plan (budget/cancel during planning
 *      ends the task → returns "ended"),
 *   4. splits nodes named in `timedOutFrom` (a timed-out node is never
 *      retried as-is: the replan's copy is split per concern / per file group),
 *   5. Preservation Guard: frozen nodes restored verbatim,
 *   6. Replan Quality Check: a repeated failed strategy, a dropped frozen
 *      node, a cycle or a dangling dependency rejects the plan; ONE retry
 *      with the reasons, then "rejected" (the caller fails the task with
 *      `loop.rejection`),
 *   7. persists the plan under the next version with its diff record,
 *   8. carries forward completed work (Step 5.3); frozen nodes always
 *      carry (never re-run),
 *   9. logs `plan.replanned` (payload feedback = `eventFeedback` when given,
 *      else the built feedback) and `plan.replan_diff`.
 */
export async function replanOnce(
  pctx: PlanningContext,
  loop: ReplanLoopState,
  state: RunState,
  opts: { reason: string; eventFeedback?: string; timedOutFrom?: string; failedKeys?: string[] }
): Promise<"replanned" | "ended" | "rejected"> {
  const { deps, task, project, classification } = pctx;
  const previousPlan = loop.plan;
  const scope = computeReplanScope(previousPlan, state, loop.completedKeys, opts.reason, opts.failedKeys);
  loop.replans += 1;
  const base = buildReplanFeedback(
    opts.reason,
    pctx.sharedContext,
    completedSubtasksFor(loop.plan, state)
  );
  const scopeText = buildReplanScope({ plan: previousPlan, ...scope });
  loop.feedback = `${base}\n${scopeText}`;

  const rejected: string[] = [];
  let accepted:
    | { plan: ExecutionPlan; createdBy: AuthoritativePlanResult["createdBy"]; restored: string[]; reasoningMissing: string[]; removals?: ExecutionPlan["replanRemovals"] }
    | null = null;
  let attempts = 0;
  let lastHard: ReplanViolation[] = [];
  for (attempts = 1; attempts <= 2; attempts += 1) {
    const feedback =
      attempts === 1
        ? loop.feedback
        : `${loop.feedback}\nYour previous replan was REJECTED by the quality check: ${rejected.at(-1)}. Fix exactly these problems.`;
    let replanned: AuthoritativePlanResult;
    try {
      replanned = await requestPlan(pctx, { feedback, stage: "replanning" });
    } catch (error) {
      await finishOnPlanningError(pctx, error);
      return "ended";
    }
    let candidate = replanned.plan;
    if (opts.timedOutFrom !== undefined) {
      const timedOut = timedOutKeys(opts.timedOutFrom);
      if (timedOut.length > 0) {
        const resplit = splitTimedOutNodes(candidate, previousPlan, timedOut, classification, {
          maxSubtasks: deps.policy.maxSubtasks,
          agents: pctx.agents,
        });
        candidate = resplit.plan;
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "plan.timeout_split",
          payload: { timedOut, split: resplit.split, unsplittable: resplit.unsplittable },
          level: "warn",
        });
      }
    }
    const guarded = preserveFrozen(previousPlan, candidate, scope.frozenKeys);
    const quality = checkReplanQuality({
      previous: previousPlan,
      next: guarded.plan,
      failedKeys: scope.failedKeys,
      frozenKeys: scope.frozenKeys,
    });
    // Soft-only violations (a changed node without replanReasoning) never
    // cost a planner retry or a rejection: the missing reasoning is filled
    // deterministically from the replan reason and the plan is accepted
    // (live test 4: a missing_reasoning retry fed a verify → replan loop).
    if (quality.ok || quality.hard.length === 0) {
      const missingKeys = new Set(
        quality.violations
          .filter((violation) => violation.code === "missing_reasoning" && violation.key)
          .map((violation) => violation.key!)
      );
      const filledPlan = missingKeys.size === 0 ? guarded.plan : fillMissingReasoning(guarded.plan, missingKeys, opts.reason);
      accepted = {
        plan: filledPlan,
        createdBy: replanned.createdBy,
        restored: guarded.restored,
        reasoningMissing: quality.violations
          .filter((violation) => violation.code === "missing_reasoning" && violation.key)
          .map((violation) => violation.key!),
        removals: candidate.replanRemovals,
      };
      break;
    }
    lastHard = quality.hard;
    const message = describeViolations(quality.hard.length > 0 ? quality.hard : quality.violations);
    rejected.push(message);
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "plan.replan_rejected",
      payload: {
        attempt: attempts,
        violations: quality.violations.map((violation) => ({
          code: violation.code,
          key: violation.key,
          message: violation.message,
          soft: violation.soft === true,
        })),
        willRetry: attempts < 2,
      },
      level: "warn",
    });
  }

  if (!accepted) {
    loop.rejection = `Replan rejected by the quality check after ${attempts - 1} attempt(s): ${describeViolations(
      lastHard
    )}`.slice(0, 1500);
    return "rejected";
  }

  const diff = diffPlans({
    previous: previousPlan,
    next: accepted.plan,
    frozenKeys: scope.frozenKeys,
    restoredKeys: accepted.restored,
    failedKeys: scope.failedKeys,
    impactKeys: scope.impactKeys,
    removals: accepted.removals,
  });
  const record: ReplanRecord = {
    fromVersion: loop.planVersion,
    toVersion: loop.planVersion + 1,
    reason: opts.reason.slice(0, 1000),
    failedKeys: scope.failedKeys,
    impactKeys: scope.impactKeys,
    frozenKeys: scope.frozenKeys,
    restoredKeys: accepted.restored,
    diff,
    attempts: Math.min(attempts, 2),
    rejected,
    reasoningMissing: accepted.reasoningMissing,
  };
  loop.plan = { ...stripReplanAnnotations(accepted.plan), replan: record };
  loop.rejection = undefined;
  loop.planVersion += 1;
  await persistPlan(deps, {
    taskId: task._id,
    projectId: project._id,
    plan: loop.plan,
    version: loop.planVersion,
    createdBy: accepted.createdBy,
    classification: classification.kind,
  });
  // Frozen outputs are read BEFORE carry-forward resets the state.
  const frozenOutputs = new Map(
    scope.frozenKeys
      .map((key) => [key, outputOf(state, key)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
  );
  const carried = carryForwardState(previousPlan, state, loop.plan);
  // Preservation Guard (execution side): a frozen node is never re-run,
  // whatever the signature match decided.
  for (const [key, output] of frozenOutputs) {
    if (!loop.plan.subtasks.some((subtask) => subtask.key === key)) continue;
    state.priorOutputs.set(key, output);
    carried.completedKeys.add(key);
  }
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
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "plan.replan_diff",
    payload: {
      fromVersion: record.fromVersion,
      toVersion: record.toVersion,
      failed: record.failedKeys,
      impact: record.impactKeys,
      frozen: record.frozenKeys,
      added: diff.added.map((entry) => entry.key),
      removed: diff.removed.map((entry) => entry.key),
      modified: diff.modified.map((entry) => entry.key),
      preserved: diff.preserved.map((entry) => entry.key),
      attempts: record.attempts,
      reasoningMissing: record.reasoningMissing,
    },
    level: "info",
  });
  return "replanned";
}

/**
 * Fill `replanReasoning` on the given nodes from the replan reason (marked
 * as auto-filled), so a replan missing only its reasoning is accepted with
 * a deterministic record instead of a retry. Exported for tests.
 */
export function fillMissingReasoning(plan: ExecutionPlan, keys: ReadonlySet<string>, reason: string): ExecutionPlan {
  const why = `(auto-filled: the planner gave no reason) Replan for: ${reason.replace(/\s+/g, " ").trim().slice(0, 200)}`;
  return {
    ...plan,
    subtasks: plan.subtasks.map((subtask) =>
      keys.has(subtask.key) && !subtask.replanReasoning?.trim() ? { ...subtask, replanReasoning: why } : subtask
    ),
  };
}
