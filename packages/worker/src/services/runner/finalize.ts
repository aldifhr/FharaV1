import { feedsResearchSynthesis, isResearchSynthesis } from "@/prompts/research";
import type {
  AgentDefinition,
  ExecutionPlan,
} from "@/types";
import {
  evaluateTask,
  type EvaluationCheck,
  type EvaluationResult,
} from "@/orchestrator/evaluator";
import { runVerification } from "@/execution/verification";
import { verificationStatus } from "@/execution/verifyEnv";
import type {
  WorkerProject,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";
import type { OutstandingIssue } from "@/orchestrator/taskContext";
import type { RunnerDeps, RunState } from "./types";
import { contentFingerprint } from "./applyLedger";
import { pickResponseOwner, responseOwnerAgent } from "@/orchestrator/responseOwner";
import { planSystemLine, postSystemLine } from "./systemLines";

/** The commands the user declined, from the subtask rows ("Declined by user: npm run typecheck"). */
export function declinedCommandsOf(subtasks: Array<{ status: string; error?: string }>): string[] {
  return subtasks
    .filter((subtask) => subtask.status === "skipped" && /^Declined by user\b/i.test(subtask.error ?? ""))
    .map((subtask) => (subtask.error ?? "").replace(/^Declined by user:?\s*/i, "").trim() || "a command");
}

/**
 * Runs static verification if enabled and there are applied code changes.
 * Returns the verification status and checks, or undefined if verification
 * was skipped (no changes, disabled, or already covered by the verification loop).
 *
 * Phase 5 Step 5.1 optimization: verification results are cached by
 * content hash. If no files have changed since the last verification run,
 * the last result is reused instead of re-running the full verification suite.
 */
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
  /** Shared-context outstanding issues at finalize time (plan 013 step 2).
   * Open critical/high issues fail the task with the missing list.
   */
  openIssues?: OutstandingIssue[];
  /** Per-task abort signal (Phase 4): verification steps die with the task.
   */
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
    // Phase 5: check if verification was already run for these exact changes.
    // If the content hashes match the last verification, reuse the result
    // instead of re-running the full suite — this avoids double-verification
    // when the verification loop already validated the same changes.
    const fingerprint = contentFingerprint(appliedChanges);
    const lastVerification = state.verification;

    if (lastVerification?.checks && state.lastContentHash === fingerprint) {
      // Reuse last verification result: same files, same content hashes.
      // state.verification already holds its status.
      verificationChecks = lastVerification.checks;
    } else {
      // Run verification for these changes.
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
      // Record the result and the content it ran against for future reuse.
      state.verification = { ...verificationStatus(verification.checks), checks: verification.checks };
      state.lastContentHash = fingerprint;
    }
  } else if (deps.policy.verificationEnabled && hasCodeChange && appliedChanges.length === 0) {
    // No applied changes but verification is enabled: record skipped status.
    state.verification = verificationStatus([]);
  }

  // O7: a failed /research angle whose synthesis completed on the other
  // angles is settled, not a failure: it is reported like a skip.
  const synthesisDone = input.plan.subtasks
    .filter(isResearchSynthesis)
    .every((synthesis) => input.subtasks.some((row) => row.key === synthesis.key && row.status === "completed"));
  const toleratedAngle = (subtask: { key: string; status: string }) =>
    subtask.status === "failed" && synthesisDone && feedsResearchSynthesis(input.plan.subtasks, subtask.key);
  const evaluation = await evaluateTask({
    workspacePath: input.workspacePath,
    subtasks: input.subtasks.map((subtask) => ({
      key: subtask.key,
      kind: subtask.kind,
      status: toleratedAngle(subtask) ? "skipped" : subtask.status,
      error: toleratedAngle(subtask)
        ? `research angle failed, the synthesis answered without it: ${(subtask.error ?? "failed").slice(0, 300)}`
        : subtask.error,
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

  // O2: the ONE report message for the whole task, posted as the Response
  // Owner (the plan's primary role, orchestrator/responseOwner.ts); the QA
  // and review evidence is inside it. Plan details live in events.
  const reviewVerdicts = Object.values(state.reviewVerdicts);
  const reviewedFiles = reviewVerdicts.length > 0 ? state.fileChanges.size : 0;
  const reviewLine =
    reviewVerdicts.length === 0
      ? ""
      : reviewVerdicts.every((r) => r.verdict === "approved")
        ? `Review: approved${reviewedFiles > 0 ? ` (${reviewedFiles} file${reviewedFiles === 1 ? "" : "s"} reviewed, no blocking findings)` : ""}.`
        : `Review: changes requested.`;
  const qaValues = Object.entries(state.qaVerdicts);
  const blockedQa = qaValues.filter(([, verdict]) => verdict === "blocked");
  const blockedDetail = blockedQa
    .flatMap(([key]) => state.qaChecks?.[key] ?? [])
    .find((check) => check.label === "qa-environment")?.details;
  const qaLine =
    qaValues.length === 0
      ? ""
      : blockedQa.length > 0
        ? `QA blocked — ${blockedDetail ?? "the QA environment could not run browser checks"}. Browser checks did not run.`
        : qaValues.every(([, verdict]) => verdict === "passed")
          ? "QA: structural browser checks passed."
          : "";
  const declined = declinedCommandsOf(input.subtasks);
  const ranNothing = declined.length > 0 && input.subtasks.every((subtask) => subtask.status === "skipped");
  const message = [
    ranNothing
      ? "Not run."
      : evaluation.verdict === "inconclusive"
        ? `Finished, but verification is inconclusive: ${details || "not all checks were performed"}.`
        : "Done.",
    declined.length > 0
      ? `Declined by user: ${declined.map((line) => `\`${line}\``).join(", ")}. ${declined.length === 1 ? "That command was" : "Those commands were"} not run.`
      : "",
    reviewLine,
    qaLine,
    ranNothing
      ? "Verification: skipped (the command was declined)."
      : declined.length > 0
        ? `Verification: ${evaluation.verdict} for the work that ran; the declined command was not checked.`
        : `Verification: ${evaluation.verdict}.`,
    // Environment-skipped steps (missing dependencies in the workspace) are
    // reported, never silently counted as passed.
    state.verification?.status === "skipped_env"
      ? `Verification skipped_env — ${state.verification.details ?? "the workspace environment could not run some checks"}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const owner = responseOwnerAgent(pickResponseOwner(plan, input.agents), input.agents);
  await deps.api.appendAgentMessage({
    projectId: project._id,
    taskId: task._id,
    content: message,
    agentId: owner?._id as any,
  });
  // QA that could not run (no browser, no deps) does not fail the task
  // (policy.qaRequired decides that), but the Done it ends in carries a
  // visible "QA blocked" warning instead of reading as fully checked.
  const qaWarning =
    blockedQa.length > 0
      ? `QA blocked: ${blockedDetail ?? "the QA environment could not run browser checks"}`.slice(0, 500)
      : undefined;
  await deps.api.completeTask({ taskId: task._id, status: "done", ...(qaWarning ? { completionWarning: qaWarning } : {}) });
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
    degradedReason?: string;
    /** Task Estimator result (apps/api/convex/lib/estimate.ts). */
    estimate?: unknown;
    /** The run's agents: the Response Owner is routed against them (O2). */
    agents?: AgentDefinition[];
  }
): Promise<void> {
  // O2: the Response Owner is recomputed for every stored version (a
  // replan or edit can move the primary role) and kept on the task row.
  const responseOwner = pickResponseOwner(input.plan, input.agents) ?? undefined;
  input = { ...input, plan: { ...input.plan, ...(responseOwner ? { responseOwner } : {}) } };
  await deps.api.setPlanning({
    taskId: input.taskId,
    classification: input.classification,
    strategy: input.plan.strategy,
    planVersion: input.version,
    ...(responseOwner ? { responseOwner } : {}),
  });
  await deps.api.savePlan({
    taskId: input.taskId,
    projectId: input.projectId,
    version: input.version,
    strategy: input.plan.strategy,
    createdBy: input.createdBy,
    goal: input.plan.goal,
    payload: input.plan,
    // Replan Reasoning is planner output, not a subtask row field (the
    // row validator is strict); it is kept on payload.replan instead.
    subtasks: input.plan.subtasks.map(({ replanReasoning: _reasoning, ...subtask }) => subtask),
    ...(input.createdBy === "fallback" && input.degradedReason
      ? { degradedReason: input.degradedReason.slice(0, 500) }
      : {}),
    ...(input.estimate ? { estimate: input.estimate } : {}),
  });
  await postSystemLine(deps, { taskId: input.taskId, projectId: input.projectId, content: planSystemLine(input.plan, input.version) });
}
