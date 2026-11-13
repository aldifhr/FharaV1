import { reviewFixRoundsSpent } from "@/orchestrator/decisionEngine";
import type { RunContext } from "../../types";
import { currentSnapshotId, runReviewLoop } from "../../reviewLoop";
import { exit, failedOrCancelled, next, type Phase } from "../pipeline";

/** The review loop on the implementation's staged changes, then a pause-aware boundary. */
export const reviewPhase: Phase = async ({ ctx }) => {
  const { plan, state } = ctx;
  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  if (hasCodeChange && state.fileChanges.size === 0) {
    state.feedback.push("The implementation produced no file changes");
    return exit({ status: "failed", failureKind: "no_change" });
  }
  if (!(await runReviewLoop(ctx))) {
    // A review that never reached a verdict (its node failed) is not a rejection.
    const rejected = ctx.state.reviewBySnapshot?.[currentSnapshotId(ctx)] === "changes_requested";
    return exit({ ...failedOrCancelled(ctx), ...(rejected ? {} : { failureKind: "error" as const }) });
  }
  // Same boundary after the review stage (plan 013 step 3).
  return next("observe");
};

export interface ReReview {
  /** The new snapshot passed review (or the plan has no review nodes). */
  approved: boolean;
  /** Review-fix nodes this re-review spawned: their files land with the stage fix. */
  fixKeys: string[];
}

/**
 * Exec-pipeline re-review: a verify / QA fix produced a new snapshot, so it
 * goes back through the review loop before the stage loop continues. The
 * review fix rounds continue the plan's one maxReviewIterations budget
 * (never a fresh one), and a rejection goes to the fix owner the Decision
 * Engine picks (decideFixOwner, stage "review") inside runReviewLoop.
 */
export async function reReviewAfterFix(ctx: RunContext, stage: "verification" | "QA", fixKey: string): Promise<ReReview> {
  if (ctx.reviewNodes.length === 0) return { approved: true, fixKeys: [] };
  const before = new Set(ctx.plan.subtasks.map((subtask) => subtask.key));
  const startRound = reviewFixRoundsSpent(ctx.plan.subtasks);
  await Promise.resolve(
    ctx.deps.api.logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "review.rereview",
      payload: { stage, fixKey, snapshotId: currentSnapshotId(ctx), round: startRound, maxRounds: ctx.deps.policy.maxReviewIterations },
    })
  ).catch(() => undefined);
  if (startRound > ctx.deps.policy.maxReviewIterations) {
    ctx.state.feedback.push(`Re-review after the ${stage} fix not possible: the review fix budget (${ctx.deps.policy.maxReviewIterations}) is spent`);
    return { approved: false, fixKeys: [] };
  }
  const approved = await runReviewLoop(ctx, { rerun: true, startRound });
  return { approved, fixKeys: ctx.plan.subtasks.map((subtask) => subtask.key).filter((key) => !before.has(key)) };
}
