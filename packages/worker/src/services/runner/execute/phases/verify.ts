import { runVerificationLoop } from "../../verifyLoop";
import { runQaLoop } from "../../qaLoop";
import { contentFingerprint } from "../../applyLedger";
import { exit, failedOrCancelled, next, type Phase } from "../pipeline";

/**
 * Static verification (cheap, deterministic) on the changes as they sit in
 * the workspace (legacy: applied) or the task worktree (verified_first:
 * staged). Each fix it spawns is re-reviewed before it lands.
 */
export const verifyPhase: Phase = async ({ ctx, prepared }) => {
  const files = prepared?.preparedChanges.length ?? 0;
  if (files === 0) return next();
  await ctx.deps.api.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.project._id,
    type: "task.stage",
    payload: { stage: "verifying", files },
  });
  const stop = await runVerificationLoop(ctx);
  if (stop === "waiting_approval") return exit({ status: "waiting_approval" });
  if (stop) return exit({ status: ctx.taskCancelled() ? "cancelled" : stop });
  if (ctx.stepLimitHit) return exit({ status: "step_limit" });
  return next("check");
};

/** A pause that landed during verification ends the invocation before QA starts. */
export const pauseBoundaryPhase: Phase = async () => next("observe");

/**
 * Plan 005 Step 5.2: QA failures spawn targeted fix subtasks (each one
 * re-reviewed) and the same QA nodes re-run; a still-failing QA after the
 * last fix attempt fails the task instead of being silently marked done.
 */
export const qaPhase: Phase = async ({ ctx, prepared }) => {
  if (ctx.qaNodes.length === 0) return next();
  await ctx.deps.api.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.project._id,
    type: "task.stage",
    payload: { stage: "qa", files: prepared?.preparedChanges.length ?? 0 },
  });
  const qaApproved = await runQaLoop(ctx);
  if (ctx.pendingApproval) return exit({ status: "waiting_approval" });
  if (!qaApproved) return exit(failedOrCancelled(ctx));
  if (ctx.stepLimitHit) return exit({ status: "step_limit" });
  // Same boundary after the QA stage (plan 013 step 3).
  return next("check");
};

/**
 * verified_first: a QA fix changed the staged content after verification
 * passed, so verification runs once more (its own fix budget: the next
 * verification phase) before the user is asked to approve. With nothing
 * changed since the last verification this is a no-op.
 */
export const reverifyPhase: Phase = async (s) => {
  const { ctx } = s;
  if (!ctx.deps.policy.verificationEnabled || ctx.state.lastContentHash === undefined) return next();
  if (ctx.state.lastContentHash === contentFingerprint(Array.from(ctx.state.fileChanges.values()))) return next();
  return verifyPhase(s);
};
