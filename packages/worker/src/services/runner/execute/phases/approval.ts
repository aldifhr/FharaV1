import { decideApprovalGate } from "@/orchestrator/decisionEngine";
import { snapshotIdForChanges } from "@/tools/gitDiff";
import { mayAutoApproveEdits } from "../../autoApprove";
import { brokerGate, mergeAcceptance, requestApplyApproval, type PreparedApply } from "../../applyStage";
import type { RunContext } from "../../types";
import { exit, failedOrCancelled, next, type Phase } from "../pipeline";

/**
 * Plan 020: a permission mode that may auto-approve edits hands the plan
 * gate to the broker path, which auto-approves or still asks.
 */
function planAsks(ctx: RunContext, files: number): boolean {
  const { input, plan } = ctx;
  return input.approvalMode === "ask" && plan.requiresApproval && !mayAutoApproveEdits(ctx) && !input.approvalResolved && files > 0;
}

/** Legacy order: the plan-level approval gate, before anything is applied. */
export const legacyApprovalPhase: Phase = async ({ ctx, prepared }) => {
  if (planAsks(ctx, prepared!.preparedChanges.length)) return exit(await requestApplyApproval(ctx, prepared!, "plan"));
  return next();
};

/**
 * verified_first: the approval comes LAST, for the final snapshot only,
 * and only when that snapshot's latest review verdict is approve
 * (decideApprovalGate). A resumed approval covers the snapshot it was given
 * for; a fix that landed since needs a new one. Every broker / human-look
 * gate of the legacy apply still applies; passing them lets the land phase
 * merge.
 */
export const approvalPhase: Phase = async (s) => {
  const { ctx } = s;
  const { state, reviewNodes } = ctx;
  const changes = Array.from(state.fileChanges.values());
  if (changes.length === 0) return next();
  const snapshotId = snapshotIdForChanges(changes);
  const gate = decideApprovalGate({
    reviewRequired: reviewNodes.length > 0,
    snapshotId,
    reviewBySnapshot: state.reviewBySnapshot ?? {},
    approvalResolved: ctx.input.approvalResolved === true,
    approvedSnapshotId: s.baseSnapshotId,
  });
  if (gate.kind === "block") {
    await ctx.deps.api.logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "review.snapshot_mismatch",
      payload: { actual: snapshotId, reason: gate.reason, stage: "approval" },
      level: "error",
    });
    state.feedback.push(
      gate.reason === "unreviewed"
        ? "The final changes were never reviewed; approval is only requested for a review-approved snapshot"
        : "Review did not approve the final changes; approval is only requested for a review-approved snapshot"
    );
    return exit({ ...failedOrCancelled(ctx), failureKind: "review_rejected" });
  }
  // An approval given for an earlier snapshot does not cover this one.
  const gateCtx: RunContext =
    gate.kind === "covered" || !ctx.input.approvalResolved ? ctx : { ...ctx, input: { ...ctx.input, approvalResolved: false } };
  const prepared: PreparedApply = {
    preparedChanges: changes,
    reviewSnapshotId: snapshotId,
    approvedVerdicts: Object.values(state.reviewVerdicts).filter((verdict) => verdict.verdict === "approved"),
    ...(s.prepared?.dryRunSummary ? { dryRunSummary: s.prepared.dryRunSummary } : {}),
  };
  if (planAsks(gateCtx, changes.length)) return exit(await requestApplyApproval(gateCtx, prepared, "plan"));
  const passed = await brokerGate(gateCtx, prepared);
  if (passed.stop) return exit({ status: passed.stop });
  s.accepted = mergeAcceptance(gateCtx);
  return next();
};
