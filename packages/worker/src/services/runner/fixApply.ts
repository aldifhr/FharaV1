import type { RunContext } from "./types";
import type { PlanSubtask } from "@/types";
import type { FileDiff } from "@/tools/gitDiff";
import { routeCapability } from "@/orchestrator/capabilities";
import { tryAutoApprove } from "./autoApprove";

export type FixApplyResult = "applied" | "waiting_approval" | "failed";

/**
 * Land a fix subtask's staged changes before the stage (verification or
 * QA) re-runs.
 *
 * - auto mode: apply right away (orchestrator actor).
 * - ask mode + auto_edits / full_access permission mode (plan 020): the
 *   fix is auto-approved (recorded) and applied with no pause.
 * - ask mode, supervised: the approval gate stays authoritative. Instead of re-running
 *   the stage against the UNFIXED workspace (which can never pass), request
 *   an `apply_changes` approval for the fix and pause the task
 *   (`ctx.pendingApproval`). The resumed run applies every staged change,
 *   then re-runs verification and QA.
 */
export async function applyOrRequestFixApproval(
  ctx: RunContext,
  fixSubtask: PlanSubtask,
  stage: "QA" | "verification"
): Promise<FixApplyResult> {
  const { state, input, deps, taskId, project, plan, applyStaged, agents } = ctx;
  const fixPaths = state.appliedFilesBySubtask.get(fixSubtask.key) ?? [];
  const fixChanges = fixPaths
    .map((filePath) => state.fileChanges.get(filePath))
    .filter((change): change is FileDiff => Boolean(change));

  if (input.approvalMode !== "ask") {
    const applied = await applyStaged(fixChanges, "orchestrator");
    return "stop" in applied ? "failed" : "applied";
  }
  // Nothing to apply: let the stage re-run (bounded by its own loop).
  if (fixChanges.length === 0) return "applied";

  const fixer = routeCapability(fixSubtask.capability, agents);
  const fixSummary = `Apply ${stage} fix (${fixChanges.length} file(s)): ${fixChanges
    .map((change) => change.filePath)
    .join(", ")}`;
  // Plan 020: auto-accept edits / full access approve the fix themselves
  // (recorded, decidedBy "auto"): the stage re-runs with no pause.
  const autoApproved = await tryAutoApprove(ctx, {
    kind: "apply_changes",
    summary: fixSummary,
    payload: {
      filePaths: Array.from(state.fileChanges.keys()),
      fixFilePaths: fixChanges.map((change) => change.filePath),
      planVersion: input.planVersion ?? plan.version,
      reason: `${stage.toLowerCase()}_fix`,
    },
    changes: fixChanges,
    subtaskKey: fixSubtask.key,
    requestedByAgentId: fixer?._id,
    planVersion: input.planVersion ?? plan.version,
  });
  if (autoApproved) {
    const applied = await applyStaged(fixChanges, "orchestrator");
    return "stop" in applied ? "failed" : "applied";
  }
  await deps.api.requestApproval({
    taskId,
    projectId: project._id,
    subtaskKey: fixSubtask.key,
    kind: "apply_changes",
    summary: fixSummary,
    payload: {
      // The resumed run applies EVERY staged change (the earlier approved
      // files plus this fix), so the approval must cover all of them: the
      // broker grants only when an approval's filePaths cover every target.
      filePaths: Array.from(state.fileChanges.keys()),
      fixFilePaths: fixChanges.map((change) => change.filePath),
      planVersion: input.planVersion ?? plan.version,
      metrics: {
        files: fixChanges.length,
        stage,
        build: state.verification?.status ?? "not run",
        tests: state.verification?.status ?? "not run",
      },
    },
    requestedByAgentId: fixer?._id as any,
    planVersion: input.planVersion ?? plan.version,
  });
  await deps.api.appendAgentMessage({
    projectId: project._id,
    taskId,
    agentId: fixer?._id as any,
    content: `${stage} found problems and a fix is prepared for ${fixChanges.length} file(s). Approve it to apply the fix; ${stage} re-runs after it is applied.`,
  });
  await deps.api.logEvent({
    taskId,
    projectId: project._id,
    type: "task.stage",
    payload: { stage: "waiting_approval", reason: `${stage.toLowerCase()}_fix`, files: fixChanges.length },
    level: "warn",
  });
  ctx.pendingApproval = true;
  return "waiting_approval";
}
