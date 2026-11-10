import { existsSync } from "node:fs";
import * as path from "node:path";
import { wantsVisualQa } from "@/orchestrator/planner";
import type { ReviewResult } from "@/utils/json";
import type { FileDiff } from "@/tools/gitDiff";
import { commitWorktree, describeCommit } from "@/tools/gitWorktree";
import type { RunContext } from "./types";
import { implementerAgent, resolveWorkspacePath } from "./setup";
import { mayAutoApproveEdits, tryAutoApprove } from "./autoApprove";
import { newFilesOnlyFixWarning } from "./noTargetGuard";
import { generateCommitMessage } from "./commitMessage";
import { scanStagedChanges, secretFlag, secretWarning } from "@/utils/secretScan";
import { checkDependencyChanges, dependencyWarning, type DepCheckResult } from "@/execution/depHardening";

/** What the apply stage hands the approval request. */
export interface PreparedApply {
  preparedChanges: FileDiff[];
  reviewSnapshotId: string;
  approvedVerdicts: ReviewResult[];
  dryRunSummary?: { filePaths: string[]; count: number; changes: string[] };
}

/**
 * O8: the dependency check on the staged changes (package.json, lockfiles,
 * CI workflows). Lockfile lookups read the task's worktree when it has one,
 * else the project workspace. Never throws: a problem is a "skipped" result.
 */
export async function stagedDependencyCheck(
  ctx: Pick<RunContext, "deps" | "project" | "input">,
  changes: ReadonlyArray<FileDiff>
): Promise<DepCheckResult> {
  try {
    const root = ctx.input.worktree?.worktreePath ?? resolveWorkspacePath(ctx.deps.workspaceRoot, ctx.project.workspacePath);
    return await checkDependencyChanges(changes, { fileExists: (rel) => existsSync(path.join(root, rel)) });
  } catch (error) {
    return {
      status: "skipped",
      high: 0,
      findings: [],
      summary: `dependency check could not run: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
    };
  }
}

/** Every warning for the apply approval card: the no-target / scope / syntax guards plus the O8 dependency check. */
export async function applyWarnings(
  ctx: Pick<RunContext, "deps" | "project" | "input">,
  changes: FileDiff[]
): Promise<{ warning: string | null; dependency: DepCheckResult }> {
  const dependency = await stagedDependencyCheck(ctx, changes);
  const parts = [newFilesOnlyFixWarning(ctx.input.task.command, changes), dependencyWarning(dependency)].filter(
    (part): part is string => Boolean(part)
  );
  return { warning: parts.length > 0 ? parts.join("\n\n") : null, dependency };
}

/**
 * Request the user's approval for the prepared changes and pause the
 * task (`needs_approval`, lease released by the backend). Shared by the
 * plan-level `requiresApproval` gate AND the permission broker's "ask"
 * decision: an "ask" without an approval row would leave the task
 * `running` forever with nothing for the user to click (core H2).
 */
export async function requestApplyApproval(
  ctx: RunContext,
  prepared: PreparedApply,
  reason: "plan" | "broker"
): Promise<{ status: "waiting_approval" }> {
  const { deps, project, plan, state, input, taskId, reviewNodes, qaNodes } = ctx;
  const { preparedChanges, approvedVerdicts, reviewSnapshotId, dryRunSummary } = prepared;
  const implementer = implementerAgent(plan, input.agents);
  const { warning: noTarget, dependency } = await applyWarnings(ctx, preparedChanges);
  // L2: staged secrets are flagged on the approval (secret_detected).
  const secrets = scanStagedChanges(preparedChanges);
  const secretNote = secretWarning(secrets);
  const summary = `Apply changes to ${preparedChanges.length} file(s): ${preparedChanges
    .map((change) => change.filePath)
    .join(", ")}${noTarget ? `\n\n${noTarget}` : ""}${secretNote ? `\n\n${secretNote}` : ""}`;
  // Metrics reflect what actually ran: verification and QA run AFTER the
  // apply, so before approval they are "not run" unless a previous
  // invocation recorded a real result.
  const verificationMetric = state.verification
    ? state.verification.status
    : "not run";
  await deps.api.requestApproval({
    taskId,
    projectId: project._id,
    subtaskKey: plan.subtasks.find((subtask) => subtask.kind === "code_change")?.key,
    kind: "apply_changes",
    summary,
    payload: {
      filePaths: preparedChanges.map((change) => change.filePath),
      planVersion: plan.version,
      reviewSnapshotId: approvedVerdicts.length > 0 ? reviewSnapshotId : undefined,
      policyDryRun: dryRunSummary,
      ...(noTarget ? { warning: noTarget } : {}),
      ...secretFlag(secrets),
      ...(dependency.status !== "skipped"
        ? { dependencyCheck: { status: dependency.status, high: dependency.high, summary: dependency.summary } }
        : {}),
      metrics: {
        files: preparedChanges.length,
        review: approvedVerdicts.length > 0 ? "approved" : reviewNodes.length > 0 ? "not approved" : "not run",
        build: verificationMetric,
        tests: verificationMetric,
        qa:
          qaNodes.length > 0
            ? (plan.visualQa ?? wantsVisualQa(input.task.command))
              ? "Visual QA planned (runs after apply)"
              : "Structural QA planned (runs after apply)"
            : "not requested",
      },
    },
    requestedByAgentId: implementer?._id as any,
    planVersion: plan.version,
  });
  await deps.api.appendAgentMessage({
    projectId: project._id,
    taskId,
    agentId: implementer?._id as any,
    content: `Changes are prepared${
      approvedVerdicts.length > 0 ? " and review-approved" : ""
    } (${preparedChanges.length} file(s)). Verification${
      qaNodes.length > 0 ? " and QA run" : " runs"
    } after they are applied. Please approve the diff.${noTarget ? `\n\n${noTarget}` : ""}`,
  });
  await deps.api.logEvent({
    taskId,
    projectId: project._id,
    type: "task.stage",
    payload: { stage: "waiting_approval", files: preparedChanges.length, reason },
    level: "warn",
  });
  await deps.api.recordAudit({
    taskId,
    projectId: project._id,
    workerId: deps.workerId,
    actor: implementer?.name ?? "orchestrator",
    tool: "apply_changes",
    action: "request",
    decision: "pending",
    target: preparedChanges.map((change) => change.filePath).join(","),
    details: { dryRun: dryRunSummary, reason },
  });
  return { status: "waiting_approval" };
}

/**
 * L2: staged secrets stop the apply for a human look in EVERY permission
 * mode (auto-accept and auto approval included). Returns the approval
 * status, or null when there is nothing to flag or the user already
 * approved this batch (the approval they saw carried the flag).
 */
export async function secretGate(
  ctx: RunContext,
  prepared: PreparedApply
): Promise<"waiting_approval" | null> {
  if (ctx.input.approvalResolved) return null;
  const findings = scanStagedChanges(prepared.preparedChanges);
  if (findings.length === 0) return null;
  await ctx.deps.api
    .logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "secret.detected",
      payload: { stage: "apply", findings: findings.map((f) => ({ filePath: f.filePath, reasons: f.reasons })) },
      level: "warn",
    })
    .catch(() => undefined);
  return (await requestApplyApproval(ctx, prepared, "broker")).status;
}

/**
 * Plan 015: broker pre-check before applying. Deny → stop with an audit
 * event; Ask (non-auto project) → request approval wait; Allow → apply.
 * Returns the terminal status to end the invocation with, or null when
 * the changes were applied and the run continues.
 */
export async function brokerCheckAndApply(
  ctx: RunContext,
  prepared: PreparedApply
): Promise<"failed" | "cancelled" | "waiting_approval" | null> {
  const { deps, project, plan, input, taskId } = ctx;
  const { preparedChanges } = prepared;
  const firstApplied = preparedChanges[0];
  // The broker resolves every target against the workspace root (core
  // H4): send ALL prepared files (absolute, resolved by the same
  // resolver the apply phase uses), the plan version for approval
  // matching, and the worker's resolved root for relative project paths.
  const resolvedRoot = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
  const targetPaths = preparedChanges.map((change) => path.join(resolvedRoot, change.filePath));
  const broker = await deps.api.checkPermission({
    taskId,
    projectId: project._id,
    kind: "apply_changes",
    targetPath: targetPaths[0] ?? resolvedRoot,
    targetPaths,
    planVersion: input.planVersion ?? plan.version,
    workspaceRoot: resolvedRoot,
  });
  if (broker.decision === "deny") {
    await deps.api.recordAudit({
      taskId,
      projectId: project._id,
      workerId: deps.workerId,
      actor: "permission-broker",
      tool: "apply_changes",
      action: "deny",
      decision: "denied",
      target: firstApplied?.filePath ?? project.workspacePath ?? ".",
      details: { reason: broker.reason },
    });
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "permission.denied",
      payload: { action: "apply_changes", reason: broker.reason },
      level: "error",
    });
    return "failed";
  }
  // L2: a staged secret always asks, whatever the mode.
  const secretStop = await secretGate(ctx, prepared);
  if (secretStop) return secretStop;
  let autoApproved = false;
  // A fix that only adds new files is flagged for a human look: never
  // auto-approved by the permission mode (noTargetGuard).
  const noTarget = newFilesOnlyFixWarning(input.task.command, preparedChanges);
  // O8: a high dependency finding (known-bad version, typosquat, no
  // lockfile, …) is never auto-approved, by the permission mode or an
  // auto-approval project: a person looks first. A user's own approval
  // (approvalResolved) still applies.
  if (!input.approvalResolved) {
    const dependency = await stagedDependencyCheck(ctx, preparedChanges);
    if (dependency.high > 0) {
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "dependency_check", status: dependency.status, high: dependency.high, summary: dependency.summary },
        level: "warn",
      });
      return (await requestApplyApproval(ctx, prepared, "broker")).status;
    }
  }
  if (broker.decision === "ask" && input.approvalMode !== "auto" && noTarget) {
    return (await requestApplyApproval(ctx, prepared, "broker")).status;
  }
  if (broker.decision === "ask" && input.approvalMode !== "auto") {
    // Plan 020: the task's permission mode may approve this batch itself.
    // The row is recorded (decidedBy "auto") and the run continues with no
    // needs_approval pause and no resume cycle.
    autoApproved = await tryAutoApprove(ctx, {
      kind: "apply_changes",
      summary: `Apply changes to ${preparedChanges.length} file(s): ${preparedChanges
        .map((change) => change.filePath)
        .join(", ")}`,
      payload: {
        filePaths: preparedChanges.map((change) => change.filePath),
        planVersion: plan.version,
        policyDryRun: prepared.dryRunSummary,
      },
      changes: preparedChanges,
      subtaskKey: plan.subtasks.find((subtask) => subtask.kind === "code_change")?.key,
      requestedByAgentId: implementerAgent(plan, input.agents)?._id,
      planVersion: input.planVersion ?? plan.version,
    });
    if (!autoApproved) {
      // Never return waiting_approval without an approval row (core H2):
      // the task would stay `running`, its lease renewed by heartbeat,
      // with nothing for the user to approve.
      return (await requestApplyApproval(ctx, prepared, "broker")).status;
    }
  }
  const applied = await ctx.applyStaged(
    preparedChanges,
    input.approvalResolved && !autoApproved ? "user" : "orchestrator"
  );
  if ("stop" in applied) {
    return applied.stop;
  }
  if (input.approvalResolved && applied.applied.length > 0) {
    await deps.api.appendAgentMessage({
      projectId: project._id,
      taskId,
      agentId: implementerAgent(plan, input.agents)?._id as any,
      content: `Approved changes applied to ${applied.applied.length} file(s). Running verification.`,
    });
  }
  return null;
}

/**
 * Who accepted this run's changes for the merge, or null when nobody did.
 * "user": the user approved the apply (this invocation resumed from that
 * approval). "auto": the user picked a mode that accepts edits on its own
 * (Auto-accept edits / Full access, or a project set to auto approval).
 * Acceptance gates and coverage have already passed when this is asked.
 */
export function mergeAcceptance(ctx: Pick<RunContext, "input">): "user" | "auto" | null {
  if (ctx.input.approvalResolved) return "user";
  if (ctx.input.approvalMode === "auto" || mayAutoApproveEdits(ctx)) return "auto";
  return null;
}

/**
 * Worktree isolation: commit the task branch, record the push card
 * (plan 019, best-effort), then merge. Runs after the acceptance stage and
 * merges only accepted work (`accepted`); unaccepted work stays committed
 * on its branch (push card recorded) with a `branch.merge_deferred` event.
 * Returns false when the commit or merge failed (the failure is recorded
 * in state.feedback).
 */
export async function commitAndMergeWorktree(
  ctx: RunContext,
  worktree: { branchName: string; worktreePath: string },
  options: { accepted?: "user" | "auto" | null } = { accepted: "user" }
): Promise<boolean> {
  const { deps, project, plan, state, input, taskId, task } = ctx;
  try {
    // R9: message from the staged diff (budget-gated), else this fallback.
    const committed = await commitWorktree(worktree.worktreePath, `Fhara: ${task.title}`, Array.from(state.fileChanges.keys()), {
      messageFromDiff: (diff) =>
        generateCommitMessage(diff, {
          agent: implementerAgent(plan, input.agents),
          llmResolver: input.llmResolver,
          assertBudgetForCall: input.assertBudgetForCall ?? (input.budget ? () => input.budget!.assertLlmCallAllowed() : undefined),
          llmTaskGate: input.llmTaskGate,
          onTokenUsage: input.onTokenUsage,
          signal: input.taskAbort?.signal,
          context: `Task: ${task.title}`,
        }),
    });
    // Plan 019: the push card. Recorded before the local merge (which
    // removes the task branch); the commit stays reachable by sha, which
    // is what the push request pushes. Best-effort: the card never
    // decides whether the task completes.
    if (committed) {
      try {
        const summary = await describeCommit(worktree.worktreePath, project.mainBranch ?? "main");
        await deps.api.recordTaskCommit({
          taskId,
          projectId: project._id,
          agentId: implementerAgent(plan, input.agents)?._id,
          branchName: worktree.branchName,
          commitSha: summary.sha,
          commitMessage: summary.message,
          filesChanged: summary.filesChanged,
          additions: summary.additions,
          deletions: summary.deletions,
          ahead: summary.ahead,
          behind: summary.behind,
          comparedTo: summary.comparedTo,
        });
      } catch (error) {
        await deps.api
          .logEvent({
            taskId,
            projectId: project._id,
            type: "card.post_failed",
            payload: { kind: "push", message: error instanceof Error ? error.message : String(error) },
            level: "warn",
          })
          .catch(() => undefined);
      }
    }
    if (!options.accepted) {
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "branch.merge_deferred",
        payload: { branchName: worktree.branchName, reason: "changes were not accepted (no approval, supervised mode)" },
        level: "warn",
      });
      await deps.api
        .appendAgentMessage({
          projectId: project._id,
          taskId,
          agentId: implementerAgent(plan, input.agents)?._id as any,
          content: `Changes are committed on branch ${worktree.branchName} and were not merged: nobody accepted them yet.`,
        })
        .catch(() => undefined);
      return true;
    }
    await deps.api.mergeBranch({ taskId });
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "branch.merged",
      payload: { branchName: worktree.branchName, acceptedBy: options.accepted },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "branch.merge_failed",
      payload: { branchName: worktree.branchName, message },
      level: "error",
    });
    state.feedback.push(`Worktree merge failed: ${message}`);
    return false;
  }
}
