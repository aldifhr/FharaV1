import { repeatedOutputStop } from "./repeatGuard";
import type { RunContext } from "./types";
import type { PlanSubtask } from "@/types";
import { implementerAgent } from "./setup";
import { attributeFinding, decideFixOwner, fixRoundsExhausted } from "@/orchestrator/decisionEngine";
import { applyOrRequestFixApproval } from "./fixApply";
import { reReviewAfterFix } from "./execute/phases/review";
import { runVerification } from "@/execution/verification";
import { verificationStatus } from "@/execution/verifyEnv";
import { contentFingerprint } from "./applyLedger";

export { verificationStatus };
// Moved to the Decision Engine (L7); re-exported for existing importers.
export { attributeFinding, verifyFixKey } from "@/orchestrator/decisionEngine";
import type { ReviewFinding } from "@/utils/json";
import { buildVerificationCard, postStageCard } from "./cards";

/**
 * The verification correction loop (plan 012 step 2): static verification
 * failure spawns a targeted fix and re-verifies, bounded by
 * maxReviewIterations. A task never completes on a failing check.
 * Extracted verbatim from executePlan; state that used to be captured is
 * threaded through `ctx`.
 *
 * Returns null when verification passed (or no changes need it),
 * otherwise the terminal reason ("failed" / "cancelled") for the caller
 * to fold into its stage return.
 */
export async function runVerificationLoop(ctx: RunContext): Promise<"failed" | "cancelled" | "waiting_approval" | null> {
  if (!ctx.deps.policy.verificationEnabled) return null;
  if (ctx.state.fileChanges.size === 0) return null;

  // Loop ownership (like the review/QA loops): while verification and its
  // fixes run, the objective is not judgeable — a fix settling while the
  // last verification result is still "failed" must not trigger a replan.
  ctx.inStageLoop = true;
  try {
    return await verificationLoopBody(ctx);
  } finally {
    ctx.inStageLoop = false;
  }
}

async function verificationLoopBody(ctx: RunContext): Promise<"failed" | "cancelled" | "waiting_approval" | null> {
  const {
    plan, state, dynamicKeys, chainByKey, fixDepthByKey, persistDynamic,
    deps, input, taskId, project, agents,
  } = ctx;
  const runNodes = (nodes: PlanSubtask[]) => ctx.runNodes(nodes);
  const maxVerifyIters = deps.policy.maxReviewIterations;
  // The fix budget is PER verification phase (initial apply, then after
  // each QA fix round): a new failure surfacing after a QA fix gets its own
  // attempts instead of inheriting an exhausted task-wide count. A resumed
  // run (after an ask-mode fix approval) continues its phase's count, so
  // the bound holds across pauses; keys encode the phase, so they never
  // collide across phases.
  const phase = verificationPhase(plan.subtasks);
  let verifyIteration = verifyFixesInPhase(plan.subtasks, phase);
  // Fix attempts in this invocation that landed no change.
  let noChangeFixes = 0;
  while (verifyIteration <= maxVerifyIters) {
    const startedAt = Date.now();
    const verification = await runVerification({
      workspacePath: input.workspacePath,
      changedFiles: Array.from(state.fileChanges.keys()),
      includeBuild: deps.policy.verificationIncludeBuild,
      timeoutMs: deps.policy.verificationTimeoutMs,
      signal: input.taskAbort?.signal,
      onCheck: async (check) => {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "task.check",
          payload: { label: `verify:${check.name}`, status: check.status, details: check.details },
        });
      },
    });
    // Plan 019: one verification card per run in the task's chat.
    await postStageCard(deps.api, {
      taskId,
      projectId: project._id,
      agentId: (agents.find((a) => a.role === "devops") ?? implementerAgent(plan, agents))?._id,
      kind: "verification",
      data: buildVerificationCard(verification, {
        iteration: verifyIteration,
        phase,
        durationMs: Date.now() - startedAt,
        steps: deps.policy.verificationIncludeBuild === false
          ? ["typecheck", "lint", "test"]
          : ["typecheck", "lint", "test", "build"],
        idempotencyKey: `verify:${phase}:${verifyIteration}:${startedAt}`,
      }),
    });
    const failedChecks = verification.checks.filter((c) => c.status === "failed");
    // Environment failures (missing node_modules / type packages / binaries)
    // are never handed to a fixer: no code change can make them pass.
    const envChecks = verification.checks.filter((c) => c.environment);
    state.verification = { ...verificationStatus(verification.checks), checks: verification.checks };
    // Fingerprint of the content just verified: finalize reuses this result
    // instead of re-running the suite when nothing changed since.
    state.lastContentHash = contentFingerprint(Array.from(state.fileChanges.values()));
    if (failedChecks.length === 0 && envChecks.length > 0) {
      await deps.api
        .logEvent({
          taskId,
          projectId: project._id,
          type: "verification.skipped_env",
          payload: {
            checks: envChecks.map((c) => ({ name: c.name, reason: c.environment })),
            ...(verification.linkedDependencies ? { linkedDependencies: verification.linkedDependencies } : {}),
          },
          level: "warn",
        })
        .catch(() => undefined);
    }
    // Plan 022: the individual checks are the typecheck / test gate evidence.
    state.verificationChecks = verification.checks.map((check) => ({
      name: check.name,
      status: check.status,
      ...(check.details ? { details: check.details.slice(0, 500) } : {}),
    }));
    if (failedChecks.length === 0) {
      ctx.repeatGuard?.reset("verification");
      break;
    }
    const verifyRepeat = await repeatedOutputStop(
      ctx,
      "verification",
      failedChecks.map((c) => `${c.name}: ${c.details ?? ""}`).join("\n")
    );
    if (verifyRepeat) {
      state.feedback.push(verifyRepeat);
      // The same failure again after a fix: a replan would rebuild the
      // same loop (live test 4), so the task ends here.
      state.terminalFailure ??= verifyRepeat;
      return "failed";
    }
    const changedPaths = Array.from(state.fileChanges.keys());
    const findings: ReviewFinding[] = failedChecks.map((c) => ({
      severity: "high" as const,
      filePath: attributeFinding(c, changedPaths),
      description: `${c.name}: ${c.details ?? "check failed"}`,
      suggestion: "Fix the failing check and retry verification.",
    }));
    // L7: the Decision Engine owns "who fixes this, or does the loop stop?"
    // (one shared owner rule; nobody owns it → stop with a reason).
    const next = decideFixOwner(
      {
        kind: "fix_needed",
        facts: { stage: "verify", round: verifyIteration, maxRounds: maxVerifyIters, findings, nodes: plan.subtasks, writerByKey: ctx.agentByKey, agents, verifyPhase: phase },
      },
      ctx.uniqueSubtaskKey
    );
    if (next.kind === "block" && next.reason === "exhausted") {
      const message = `Verification still failing after ${maxVerifyIters} fix attempt(s)${
        phase > 0 ? ` (after QA fix round ${phase})` : ""
      }${noChangeFixes > 0 ? `, ${noChangeFixes} of which changed nothing` : ""}: ${failedChecks
        .map((c) => c.name)
        .join(", ")}`;
      state.feedback.push(message);
      if (noChangeFixes > 0) state.terminalFailure ??= message;
      return "failed";
    }
    if (next.kind === "block") {
      state.feedback.push("No implementer agent owns the code behind these verification failures, so no fix was attempted");
      return "cancelled";
    }
    // Scoped to the owner's files by the engine (live test 3: an unscoped
    // verify fix edited tsconfig.json and README).
    const fixSubtask = next.nodes[0];
    plan.subtasks.push(fixSubtask);
    dynamicKeys.add(fixSubtask.key);
    ctx.agentByKey.set(fixSubtask.key, next.agent);
    chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
    fixDepthByKey.set(fixSubtask.key, 1);
    await persistDynamic([fixSubtask], "fix");
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "verification.fix_started",
      payload: { iteration: verifyIteration + 1, phase, findings: findings.length },
      level: "warn",
    });
    const fixRun = await runNodes([fixSubtask]);
    if (fixRun.status !== "completed") {
      if (fixRun.status === "cancelled" || ctx.taskCancelled()) return "cancelled";
      // The fixer ran but landed nothing ("No effective change", a refused
      // path, an unparseable answer): that is a spent attempt, not a reason
      // to replan. The node is settled as skipped so it does not fail the
      // final evaluation if a later attempt fixes the check.
      const outcome = fixRun.outcomes.get(fixSubtask.key);
      const error = outcome && outcome.status === "failed" ? outcome.error : `fix run ${fixRun.status}`;
      noChangeFixes += 1;
      verifyIteration += 1;
      await deps.api
        .updateSubtask({ taskId, key: fixSubtask.key, status: "skipped", error: error.slice(0, 500) })
        .catch(() => undefined);
      await deps.api
        .logEvent({
          taskId,
          projectId: project._id,
          type: "verification.fix_no_change",
          payload: { iteration: verifyIteration, phase, error: error.slice(0, 500) },
          level: "warn",
        })
        .catch(() => undefined);
      if (fixRoundsExhausted(verifyIteration, maxVerifyIters)) {
        const message = `Verification failed: ${failedChecks.map((c) => c.name).join(", ")} still failing and the last of ${verifyIteration} fix attempt(s) produced no change (${error.slice(0, 200)})`;
        state.feedback.push(message);
        state.terminalFailure ??= message;
        return "failed";
      }
      continue;
    }
    // Exec-pipeline: the fix made a new snapshot; it is re-reviewed before
    // it lands and verification re-runs (a rejection loops through the
    // review fix owner within the review budget, or ends the loop).
    const reReview = await reReviewAfterFix(ctx, "verification", fixSubtask.key);
    if (!reReview.approved) return ctx.taskCancelled() ? "cancelled" : "failed";
    const landed = await applyOrRequestFixApproval(ctx, fixSubtask, "verification", reReview.fixKeys);
    if (landed === "waiting_approval") return "waiting_approval";
    if (landed === "failed") return "cancelled";
    verifyIteration += 1;
  }
  return null;
}

/**
 * Verification phase of the current pass: the number of QA fix rounds
 * already in the plan (0 = the initial apply). Exported for tests.
 */
export function verificationPhase(subtasks: Pick<PlanSubtask, "key">[]): number {
  return subtasks.filter((s) => s.key.startsWith("fix_qa_")).length;
}

/** How many verification fixes the given phase already spent. Exported for tests. */
export function verifyFixesInPhase(subtasks: Pick<PlanSubtask, "key">[], phase: number): number {
  const pattern = phase > 0
    ? new RegExp(`^fix_verify_qa${phase}_\\d+(_\\d+)?$`)
    : /^fix_verify_\d+(_\d+)?$/;
  return subtasks.filter((s) => pattern.test(s.key)).length;
}
