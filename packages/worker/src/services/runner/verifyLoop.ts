import { VERIFY_FIX_INTRO } from "@/prompts/fix";
import type { RunContext } from "./types";
import type { PlanSubtask } from "@/types";
import { implementerAgent } from "./setup";
import { pickFixOwner } from "@/orchestrator/ownership";
import { applyOrRequestFixApproval } from "./fixApply";
import { buildFixSubtask } from "@/orchestrator/reviewLoop";
import { runVerification } from "@/execution/verification";
import type { ReviewFinding } from "@/utils/json";
import { CAPABILITY } from "@/types";
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
    const allPassed =
      verification.checks.length > 0 &&
      verification.checks.every((c) => c.status === "passed");
    state.verification = {
      status: failedChecks.length > 0 ? "failed" : allPassed ? "passed" : "skipped",
      details: failedChecks.map((c) => `${c.name}: ${c.details ?? ""}`).join("; ") || undefined,
    };
    // Plan 022: the individual checks are the typecheck / test gate evidence.
    state.verificationChecks = verification.checks.map((check) => ({
      name: check.name,
      status: check.status,
      ...(check.details ? { details: check.details.slice(0, 500) } : {}),
    }));
    if (failedChecks.length === 0) break;
    if (verifyIteration >= maxVerifyIters) {
      state.feedback.push(
        `Verification still failing after ${maxVerifyIters} fix attempt(s)${
          phase > 0 ? ` (after QA fix round ${phase})` : ""
        }: ${failedChecks.map((c) => c.name).join(", ")}`
      );
      return "failed";
    }
    const changedPaths = Array.from(state.fileChanges.keys());
    const findings: ReviewFinding[] = failedChecks.map((c) => ({
      severity: "high" as const,
      filePath: changedPaths.find((p) => (c.details ?? "").includes(p)) ?? changedPaths[0] ?? "",
      description: `${c.name}: ${c.details ?? "check failed"}`,
      suggestion: "Fix the failing check and retry verification.",
    }));
    const implementer = implementerAgent(plan, agents);
    if (!implementer) return "cancelled";
    const owner = pickFixOwner(plan.subtasks, findings);
    const fixSubtask = {
      ...buildFixSubtask({
        key: ctx.uniqueSubtaskKey(verifyFixKey(phase, verifyIteration + 1)),
        title: `Address verification failures (${phase > 0 ? `after QA fix ${phase}, ` : ""}iteration ${verifyIteration + 1})`,
        intro: VERIFY_FIX_INTRO,
        findings,
        capability: owner?.capability ?? CAPABILITY.GENERAL,
        order: plan.subtasks.reduce((max, c) => Math.max(max, c.order), 0) + 1,
      }),
    };
    plan.subtasks.push(fixSubtask);
    dynamicKeys.add(fixSubtask.key);
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
    if (fixRun.status !== "completed") return "cancelled";
    const landed = await applyOrRequestFixApproval(ctx, fixSubtask, "verification");
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

/** Fix key for the n-th verification fix of a phase (phase 0 keeps the legacy `fix_verify_<n>`). */
export function verifyFixKey(phase: number, n: number): string {
  return phase > 0 ? `fix_verify_qa${phase}_${n}` : `fix_verify_${n}`;
}

/** How many verification fixes the given phase already spent. Exported for tests. */
export function verifyFixesInPhase(subtasks: Pick<PlanSubtask, "key">[], phase: number): number {
  const pattern = phase > 0
    ? new RegExp(`^fix_verify_qa${phase}_\\d+(_\\d+)?$`)
    : /^fix_verify_\d+(_\d+)?$/;
  return subtasks.filter((s) => pattern.test(s.key)).length;
}
