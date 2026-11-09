import { WebClient } from "@/tools/webClient";
import { snapshotIdForChanges } from "@/tools/gitDiff";
import type { ExecutePlanInput, RunContext } from "./types";
import { dryRunPolicy, stagehandConfigFrom } from "./setup";
import { mayAutoApproveEdits } from "./autoApprove";
import { createRunContext } from "./runContext";
import { runReviewLoop } from "./reviewLoop";
import { runQaLoop } from "./qaLoop";
import { runVerificationLoop } from "./verifyLoop";
import {
  brokerCheckAndApply,
  commitAndMergeWorktree,
  requestApplyApproval,
  type PreparedApply,
} from "./applyStage";

// Interpretation of one `executePlan` invocation. `replan` carries the
// objective-missing feedback processTask's bounded re-plan consumes,
// and `waiting_input` means the task was paused by the backend
// `pauseForInput` mutation (plan 013 step 4) — the caller simply ends
// the invocation; the answer re-queues the task.
export interface ExecutePlanResult {
  status: "completed" | "failed" | "waiting_approval" | "cancelled" | "step_limit" | "replan" | "waiting_input";
  replanFeedback?: string;
}

/**
 * Decision-terminal exits at stage boundaries, never mid-node:
 * `waiting_input` (plan 013 step 4) wins over `replan` (step 3) — a
 * question the user can still answer is worth more than re-planning
 * the same gap. Cancellation always wins over replan.
 */
function terminalExit(ctx: RunContext): ExecutePlanResult | null {
  if (ctx.waitingForInput !== null) return { status: "waiting_input" };
  if (ctx.replanFeedback !== null && !ctx.taskCancelled()) {
    return { status: "replan", replanFeedback: ctx.replanFeedback };
  }
  return null;
}

/** A failure that is really a cancellation reports as cancelled. */
function failedOrCancelled(ctx: RunContext): ExecutePlanResult {
  return { status: ctx.taskCancelled() ? "cancelled" : "failed" };
}

/**
 * The stage driver for one plan: implementation DAG → review loop →
 * snapshot/dry-run/approval gates → apply → verification loop → QA loop
 * → worktree commit/merge → final decision boundary.
 */
export async function executePlan(input: ExecutePlanInput): Promise<ExecutePlanResult> {
  const { deps, project, plan, state } = input;
  const browser = new WebClient({
    headless: true,
    ...stagehandConfigFrom(input.llmConfig),
  });

  try {
    if (plan.subtasks.length === 0) {
      return { status: "failed" };
    }
    const ctx = createRunContext(input, browser);
    const { taskId, implementationNodes, reviewNodes, qaNodes } = ctx;

    const implementation = await ctx.runNodes(implementationNodes);
    // Plan 005 Step 5.4: the decision step bound is terminal — fail the
    // task explicitly upstream, never mark it done or replan it.
    if (ctx.stepLimitHit) {
      return { status: "step_limit" };
    }
    if (implementation.status === "cancelled") {
      await deps.api
        .updateSubtask({
          taskId,
          key: implementationNodes[0]?.key ?? reviewNodes[0]?.key ?? qaNodes[0]?.key ?? "unknown",
          status: "blocked",
        })
        .catch(() => undefined);
      // Cancellation is its own outcome (Phase 4 hardening): the caller
      // ends the task as cancelled instead of treating it as a failure
      // it could replan away.
      return { status: "cancelled" };
    }
    if (implementation.status !== "completed") {
      if (implementation.outcomes) {
        for (const [key, o] of implementation.outcomes) {
          if (o.status === "failed") state.feedback.push(`${key}: ${o.error ?? "failed without detail"}`);
        }
      }
      return failedOrCancelled(ctx);
    }
    // Engine replan at the stage boundary (plan 013 step 3): abandon the
    // rest of this plan; processTask re-plans (bounded) and re-runs the
    // scheduler. Cancellation already won above.
    {
      const exit = terminalExit(ctx);
      if (exit) return exit;
    }

    const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
    if (hasCodeChange && state.fileChanges.size === 0) {
      state.feedback.push("The implementation produced no file changes");
      return { status: "failed" };
    }

    const reviewApproved = await runReviewLoop(ctx);
    if (!reviewApproved) {
      return failedOrCancelled(ctx);
    }
    // Same boundary after the review stage (plan 013 step 3).
    {
      const exit = terminalExit(ctx);
      if (exit) return exit;
    }

    const preparedChanges = Array.from(state.fileChanges.values());
    const reviewSnapshotId = snapshotIdForChanges(preparedChanges);
    const approvedVerdicts = Object.values(state.reviewVerdicts).filter(
      (verdict) => verdict.verdict === "approved" && verdict.snapshotId
    );
    if (
      preparedChanges.length > 0 &&
      approvedVerdicts.length > 0 &&
      approvedVerdicts.some((verdict) => verdict.snapshotId !== reviewSnapshotId)
    ) {
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.snapshot_mismatch",
        payload: {
          expected: approvedVerdicts.map((verdict) => verdict.snapshotId),
          actual: reviewSnapshotId,
        },
        level: "error",
      });
      state.feedback.push(
        "Changes changed after review approval; re-review required before apply"
      );
      return failedOrCancelled(ctx);
    }

    const prepared: PreparedApply = { preparedChanges, reviewSnapshotId, approvedVerdicts };
    if (preparedChanges.length > 0) {
      const dryRun = await dryRunPolicy(
        preparedChanges,
        deps,
        input.task,
        project,
        plan,
        plan.version,
        state
      );
      if (!dryRun.allowed) {
        return failedOrCancelled(ctx);
      }
      prepared.dryRunSummary = dryRun.summary;
    }

    // Plan 020: a permission mode that may auto-approve edits hands the
    // plan gate to the broker path, which auto-approves or still asks.
    const shouldAsk =
      input.approvalMode === "ask" &&
      plan.requiresApproval &&
      !mayAutoApproveEdits(ctx) &&
      !input.approvalResolved &&
      preparedChanges.length > 0;
    if (shouldAsk) {
      return await requestApplyApproval(ctx, prepared, "plan");
    }

    if (preparedChanges.length > 0) {
      const stop = await brokerCheckAndApply(ctx, prepared);
      if (stop) return { status: stop };
    }

    // A decision-engine "complete" latched during the implementation pass
    // only ends THAT drain. The post-apply stage loops (verification / QA
    // fixes) must still be able to schedule their own nodes; a replan or
    // waiting_input already returned through terminalExit above.
    if (ctx.decisionTerminal && ctx.replanFeedback === null && ctx.waitingForInput === null) {
      ctx.decisionTerminal = false;
    }

    // Stage order after apply (core H1 / QA P0-1): verification (cheap,
    // deterministic) → QA (only when the plan has QA nodes) → worktree
    // commit/merge → final decision boundary. None of these is gated on QA.
    if (preparedChanges.length > 0) {
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "verifying", files: preparedChanges.length },
      });
      const stop = await runVerificationLoop(ctx);
      if (stop === "waiting_approval") return { status: "waiting_approval" };
      if (stop) {
        return { status: ctx.taskCancelled() ? "cancelled" : stop };
      }
      if (ctx.stepLimitHit) {
        return { status: "step_limit" };
      }
      {
        const exit = terminalExit(ctx);
        if (exit) return exit;
      }
    }

    if (qaNodes.length > 0) {
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "qa", files: preparedChanges.length },
      });
      // Plan 005 Step 5.2: QA failures spawn targeted fix subtasks and the
      // same QA nodes re-run; a still-failing QA after the last fix attempt
      // fails the task instead of being silently marked done.
      const qaApproved = await runQaLoop(ctx);
      if (ctx.pendingApproval) {
        return { status: "waiting_approval" };
      }
      if (!qaApproved) {
        return failedOrCancelled(ctx);
      }
      if (ctx.stepLimitHit) {
        return { status: "step_limit" };
      }
      // Same boundary after the QA stage (plan 013 step 3).
      {
        const exit = terminalExit(ctx);
        if (exit) return exit;
      }
    }

    if (input.worktree && preparedChanges.length > 0) {
      const merged = await commitAndMergeWorktree(ctx, input.worktree);
      if (!merged) return failedOrCancelled(ctx);
    }
    // Final boundary before completing (plan 013 step 3): a replan
    // requested anywhere earlier in this invocation still wins over
    // "completed".
    {
      const exit = terminalExit(ctx);
      if (exit) return exit;
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { status: "completed" };
}
