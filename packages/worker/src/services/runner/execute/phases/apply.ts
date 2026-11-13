import { snapshotIdForChanges } from "@/tools/gitDiff";
import { dryRunPolicy } from "../../setup";
import { brokerCheckAndApply, commitAndMergeWorktree, mergeAcceptance, type PreparedApply } from "../../applyStage";
import { captureRunCheckpoint } from "../../checkpoints";
import type { RunContext } from "../../types";
import { exit, failedOrCancelled, next, type Phase } from "../pipeline";

/**
 * The reviewed change set: refuse a set that changed after its review
 * approval, then run the policy dry-run over it.
 */
export const preparePhase: Phase = async (s) => {
  const { ctx } = s;
  const { deps, taskId, project, state, input, plan } = ctx;
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
    state.feedback.push("Changes changed after review approval; re-review required before apply");
    return exit(failedOrCancelled(ctx));
  }
  const prepared: PreparedApply = { preparedChanges, reviewSnapshotId, approvedVerdicts };
  if (preparedChanges.length > 0) {
    const dryRun = await dryRunPolicy(preparedChanges, deps, input.task, project, plan, plan.version, state);
    if (!dryRun.allowed) return exit({ ...failedOrCancelled(ctx), failureKind: "error" });
    prepared.dryRunSummary = dryRun.summary;
  }
  s.prepared = prepared;
  return next();
};

/**
 * A decision-engine "complete" latched during the implementation pass only
 * ends THAT drain. The stage loops after it (verification / QA fixes) must
 * still be able to schedule their own nodes; a replan or waiting_input
 * already returned through a boundary.
 */
function reopenForStageLoops(ctx: RunContext): void {
  if (ctx.decisionTerminal && ctx.replanFeedback === null && ctx.waitingForInput === null) {
    ctx.decisionTerminal = false;
  }
}

/** Legacy order: apply the approved changes to the workspace (permission broker first). */
export const applyPhase: Phase = async (s) => {
  const prepared = s.prepared!;
  if (prepared.preparedChanges.length > 0) {
    const stop = await brokerCheckAndApply(s.ctx, prepared);
    if (stop) return exit({ status: stop });
  }
  reopenForStageLoops(s.ctx);
  return next();
};

/**
 * verified_first: write the reviewed changes into the task's isolated
 * worktree (input.workspacePath IS the worktree, decideStageOrder checked
 * it) so verification and QA run on them. The user's checkout is untouched
 * until the approval phase passed and the land phase merges the branch.
 */
export const stagePhase: Phase = async (s) => {
  const { ctx } = s;
  const changes = s.prepared!.preparedChanges;
  if (changes.length > 0) {
    await ctx.deps.api.logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "task.stage",
      payload: { stage: "staging", files: changes.length, stageOrder: s.order },
    });
    const applied = await ctx.applyStaged(changes, "orchestrator");
    if ("stop" in applied) return exit({ status: applied.stop });
    if (applied.applied.length > 0) await captureRunCheckpoint(ctx, "apply");
  }
  reopenForStageLoops(ctx);
  return next();
};

/**
 * Worktree commit/merge runs LAST, after the acceptance gates and the
 * coverage check passed (live test 3: the merge to master ran before
 * acceptance and landed out-of-scope edits) and, in verified_first order,
 * after the approval phase. It merges only accepted work: the user's
 * approval, or a mode the user picked that accepts edits automatically;
 * otherwise the branch is committed and kept.
 */
export const landPhase: Phase = async (s) => {
  const { ctx } = s;
  const { input, state } = ctx;
  if (input.worktree && state.fileChanges.size > 0) {
    const accepted = s.order === "verified_first" ? (s.accepted ?? null) : mergeAcceptance(ctx);
    const merged = await commitAndMergeWorktree(ctx, input.worktree, { accepted });
    if (!merged) return exit(failedOrCancelled(ctx));
  }
  return next();
};
