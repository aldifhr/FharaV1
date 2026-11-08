import type { RunContext } from "./types";
import type { PlanSubtask } from "@/orchestrator/types";
import { implementerAgent } from "./setup";
import { buildFixSubtask } from "@/orchestrator/reviewLoop";
import { runVerification } from "@/execution/verification";
import type { FileDiff } from "@/tools/gitDiff";
import type { ReviewFinding } from "@/utils/json";
import { CAPABILITY } from "@/orchestrator/types";

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
export async function runVerificationLoop(ctx: RunContext): Promise<"failed" | "cancelled" | null> {
  const {
    plan, state, dynamicKeys, chainByKey, fixDepthByKey, persistDynamic,
    deps, input, taskId, project, agents, taskCancelled, applyStaged,
  } = ctx;
  const runNodes = (nodes: PlanSubtask[]) => ctx.runNodes(nodes);
  if (!deps.policy.verificationEnabled) return null;
  if (state.fileChanges.size === 0 || Array.from(state.fileChanges.values()).length === 0) return null;

  const maxVerifyIters = deps.policy.maxReviewIterations;
  let verifyIteration = 0;
  while (verifyIteration <= maxVerifyIters) {
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
    const failedChecks = verification.checks.filter((c) => c.status === "failed");
    const allPassed =
      verification.checks.length > 0 &&
      verification.checks.every((c) => c.status === "passed");
    state.verification = {
      status: failedChecks.length > 0 ? "failed" : allPassed ? "passed" : "skipped",
      details: failedChecks.map((c) => `${c.name}: ${c.details ?? ""}`).join("; ") || undefined,
    };
    if (failedChecks.length === 0) break;
    if (verifyIteration >= maxVerifyIters) {
      state.feedback.push(
        `Verification still failing after ${maxVerifyIters} fix attempt(s): ${failedChecks.map((c) => c.name).join(", ")}`
      );
      return "failed";
    }
    const findings: ReviewFinding[] = failedChecks.map((c) => ({
      severity: "high" as const,
      filePath: Array.from(state.fileChanges.keys())[0] ?? "",
      description: `${c.name}: ${c.details ?? "check failed"}`,
      suggestion: "Fix the failing check and retry verification.",
    }));
    const implementer = implementerAgent(plan, agents);
    if (!implementer) return "cancelled";
    const codeSubtask = plan.subtasks.find((c) => c.kind === "code_change");
    const fixSubtask = buildFixSubtask({
      key: `fix_verify_${verifyIteration + 1}`,
      title: `Address verification failures (iteration ${verifyIteration + 1})`,
      intro: "Static verification reported failures.",
      findings,
      capability: codeSubtask?.capability ?? CAPABILITY.GENERAL,
      order: plan.subtasks.reduce((max, c) => Math.max(max, c.order), 0) + 1,
    });
    plan.subtasks.push(fixSubtask);
    dynamicKeys.add(fixSubtask.key);
    chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
    fixDepthByKey.set(fixSubtask.key, 1);
    await persistDynamic([fixSubtask], "fix");
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "verification.fix_started",
      payload: { iteration: verifyIteration + 1, findings: findings.length },
      level: "warn",
    });
    const fixRun = await runNodes([fixSubtask]);
    if (fixRun.status !== "completed") return "cancelled";
    if (input.approvalMode !== "ask") {
      const fixPaths = state.appliedFilesBySubtask.get(fixSubtask.key) ?? [];
      const fixChanges = fixPaths
        .map((p) => state.fileChanges.get(p))
        .filter((c): c is FileDiff => Boolean(c));
      const applied = await applyStaged(fixChanges, "orchestrator");
      if ("stop" in applied) return "cancelled";
    }
    verifyIteration += 1;
  }
  return null;
}
