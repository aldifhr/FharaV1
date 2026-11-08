import type {
  AgentDefinition,
  ExecutionPlan,
} from "@/orchestrator/types";
import {
  evaluateTask,
  type EvaluationCheck,
  type EvaluationResult,
} from "@/orchestrator/evaluator";
import { runVerification } from "@/execution/verification";
import type {
  WorkerProject,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";
import type { OutstandingIssue } from "@/orchestrator/taskContext";
import type { RunnerDeps, RunState } from "./types";

export async function finalize(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  workspacePath: string;
  plan: ExecutionPlan;
  planVersion: number;
  agents: AgentDefinition[];
  subtasks: WorkerSubtask[];
  state: RunState;
  /**
   * Shared-context outstanding issues at finalize time (plan 013 step 2).
   * Open critical/high issues fail the task with the missing list.
   */
  openIssues?: OutstandingIssue[];
  /** Per-task abort signal (Phase 4): verification steps die with the task. */
  signal?: AbortSignal;
}): Promise<EvaluationResult> {
  const { deps, task, project, planVersion, state, plan } = input;
  const applyApprovals = await deps.api.getApprovals({ taskId: task._id });
  const hasApprovalPlan = applyApprovals.some(
    (approval) => approval.kind === "apply_changes" && approval.status === "approved"
  );
  const changes = await deps.api.getFileChanges({ taskId: task._id });

  const appliedChanges = changes.filter((change) => change.appliedAt);
  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  let verificationChecks: EvaluationCheck[] | undefined;

  if (deps.policy.verificationEnabled && hasCodeChange && appliedChanges.length > 0) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "static-verification", files: appliedChanges.length },
    });

    const verification = await runVerification({
      workspacePath: input.workspacePath,
      changedFiles: appliedChanges.map((change) => change.filePath),
      includeBuild: deps.policy.verificationIncludeBuild,
      timeoutMs: deps.policy.verificationTimeoutMs,
      signal: input.signal,
      onCheck: async (check) => {
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "task.check",
          payload: {
            label: `verify:${check.name}`,
            status: check.status,
            details: check.details,
          },
        });
      },
    });

    verificationChecks = verification.checks;
    // Phase 5 Step 5.1: record the result on the run state so the
    // objective evaluation sees it on later replans. A check with no
    // failures is "passed"; inconclusive evidence is skipped, not failed.
    const failedChecks = verification.checks.filter((check) => check.status === "failed");
    const allPassed =
      verification.checks.length > 0 &&
      verification.checks.every((check) => check.status === "passed");
    state.verification = {
      status: failedChecks.length > 0 ? "failed" : allPassed ? "passed" : "skipped",
      details: failedChecks
        .map((check) => `${check.name}: ${check.details ?? ""}`)
        .join("; ") || undefined,
    };
  }

  const evaluation = await evaluateTask({
    workspacePath: input.workspacePath,
    subtasks: input.subtasks.map((subtask) => ({
      key: subtask.key,
      kind: subtask.kind,
      status: subtask.status,
      error: subtask.error,
    })),
    fileChanges: changes.map((change) => ({
      filePath: change.filePath,
      changeType: change.changeType,
      oldContentHash: change.oldContentHash,
      newContentHash: change.newContentHash,
      newContent: change.newContent,
      appliedAt: change.appliedAt,
    })),
    hasApprovalPlan: hasApprovalPlan || plan.requiresApproval,
    qaVerdicts: state.qaVerdicts,
    verificationChecks,
    openIssues: input.openIssues,
  });

  await deps.api.recordEvaluation({
    taskId: task._id,
    projectId: project._id,
    planVersion,
    verdict: evaluation.verdict,
    checks: evaluation.checks,
    notes: evaluation.notes.join("; ") || undefined,
  });

  const details = evaluation.checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.name} (${check.status}): ${check.details ?? ""}`)
    .join("; ");

  // Plan 013 step 2: inconclusive verification (or unresolved severe
  // findings, which already fail their check) can never conclude as
  // `done` — the task fails with the missing list instead.
  const finalizeFailed = evaluation.verdict === "failed" || evaluation.verdict === "inconclusive";
  if (finalizeFailed) {
    const message =
      evaluation.verdict === "inconclusive"
        ? `Verification inconclusive: ${details || "not all checks were performed"}.`
        : details || "Evaluation failed";
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.error",
      payload: { message },
      level: "error",
    });
    await deps.api.completeTask({
      taskId: task._id,
      status: "failed",
      errorMessage: message,
    });
    return evaluation;
  }

  // The ONE CTO chat message for the whole task: the outcome summary
  // (plan details live in events, not repeated here).
  const reviewVerdicts = Object.values(state.reviewVerdicts);
  const reviewedFiles = reviewVerdicts.length > 0 ? state.fileChanges.size : 0;
  const reviewLine =
    reviewVerdicts.length === 0
      ? ""
      : reviewVerdicts.every((r) => r.verdict === "approved")
        ? `Review: approved${reviewedFiles > 0 ? ` (${reviewedFiles} file${reviewedFiles === 1 ? "" : "s"} reviewed, no blocking findings)` : ""}.`
        : `Review: changes requested.`;
  const message = [
    evaluation.verdict === "inconclusive"
      ? `Finished, but verification is inconclusive: ${details || "not all checks were performed"}.`
      : "Done.",
    reviewLine,
    `Verification: ${evaluation.verdict}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const ctoAgent = input.agents.find((candidate) => /^cto$/i.test(candidate.role));
  await deps.api.appendAgentMessage({
    projectId: project._id,
    taskId: task._id,
    content: message,
    agentId: ctoAgent?._id as any,
  });
  await deps.api.completeTask({ taskId: task._id, status: "done" });
  return evaluation;
}

export async function persistPlan(
  deps: RunnerDeps,
  input: {
    taskId: string;
    projectId: string;
    plan: ExecutionPlan;
    version: number;
    createdBy: "orchestrator" | "fallback";
    classification: string;
  }
): Promise<void> {
  await deps.api.setPlanning({
    taskId: input.taskId,
    classification: input.classification,
    strategy: input.plan.strategy,
    planVersion: input.version,
  });
  await deps.api.savePlan({
    taskId: input.taskId,
    projectId: input.projectId,
    version: input.version,
    strategy: input.plan.strategy,
    createdBy: input.createdBy,
    goal: input.plan.goal,
    payload: input.plan,
    subtasks: input.plan.subtasks,
  });
}
