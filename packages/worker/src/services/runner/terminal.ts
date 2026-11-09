import type { BudgetTracker } from "@/orchestrator/budget";
import type { WorkerProject, WorkerTask } from "@/workerApi";
import type { RunnerDeps } from "./types";
import { isLeaseLostOrShutdown } from "./abort";

/** Terminal task statuses: a task in one of these is finished for good. */
export function isTerminalTaskStatus(status: string | undefined): boolean {
  return status === "done" || status === "failed" || status === "rejected";
}

/**
 * End a task run as BUDGET EXHAUSTED (Phase 5). The backend has no
 * dedicated budget status — like cancellation, the task row lands on
 * "failed" — so the distinction lives in the dedicated
 * `budget.exhausted` event (with the final tracker snapshot) and the
 * error message. Completed subtask outputs are untouched: they were
 * persisted as they finished and remain visible in the task timeline.
 * The backend completeTask terminal guard makes this a no-op if the
 * task already reached a terminal status by another path.
 */
export async function finishBudgetExhaustedTask(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  budget: BudgetTracker;
  reason: string;
}): Promise<void> {
  const { deps, task, project, budget, reason } = input;
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "budget.exhausted",
    payload: { reason, budget: budget.snapshot() },
    level: "error",
  });
  await deps.api
    .recordLifecycle?.({
      taskId: task._id,
      projectId: project._id,
      state: "FAILED",
      prevState: "RUNNING",
    })
    ?.catch(() => undefined);
  await deps.api.completeTask({
    taskId: task._id,
    status: "failed",
    errorMessage: `Budget exhausted: ${reason}`,
  });
}

/**
 * Whether a failure SUMMARY carries a budget stop. Failure summaries
 * are the per-subtask feedback entries joined with "; ", each entry
 * prefixed with its subtask key ("s3 (attempt 1): Budget exhausted:
 * ..."), so the raw summary never STARTS with the prefix — the
 * recognition scans for it at any entry boundary (Phase 5).
 */
export function summaryHasBudgetFailure(summary: string): boolean {
  return summary
    .split("; ")
    .some((entry) => entry.includes("Budget exhausted:"));
}

/** The budget reason carried by a failure summary (prefix stripped). */
export function budgetReasonFromSummary(summary: string): string {
  const entry = summary
    .split("; ")
    .find((candidate) => candidate.includes("Budget exhausted:"));
  if (!entry) return summary;
  return entry.slice(entry.indexOf("Budget exhausted: ") + "Budget exhausted: ".length);
}

/**
 * End a task run as cancelled (Phase 4 hardening). The backend has no
 * "cancelled" task status — tasks.cancel itself stores a user
 * cancellation as status "failed" + "Cancelled by user" — so the
 * outcome maps to completeTask("failed") with a cancellation message,
 * while the dedicated `task.cancelled` event preserves the distinction
 * (user cancel vs deadline) in the task timeline. The backend
 * completeTask guard makes this call a no-op when the task already
 * reached a terminal status by another path, so a late cancel ending
 * can never overwrite a real completion either.
 */
export async function finishCancelledTask(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  signal: AbortSignal;
}): Promise<void> {
  const { deps, task, project, signal } = input;
  const reasonText =
    signal.reason instanceof Error ? signal.reason.message : "";
  // Worker shutdown / lost lease: this worker no longer owns the task.
  // Do NOT fail it — leave it for lease-expiry recovery (another worker
  // re-claims it) and just record why this run stopped.
  if (isLeaseLostOrShutdown(signal.reason)) {
    await deps.api
      .logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "task.interrupted",
        payload: { reason: reasonText },
        level: "warn",
      })
      .catch(() => undefined);
    return;
  }
  const timedOut = reasonText.startsWith("Task deadline exceeded");
  const errorMessage = timedOut ? reasonText : "Task cancelled";
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.cancelled",
    payload: { reason: errorMessage, timedOut },
    level: "warn",
  });
  await deps.api
    .recordLifecycle?.({
      taskId: task._id,
      projectId: project._id,
      state: "FAILED",
      prevState: "RUNNING",
    })
    ?.catch(() => undefined);
  await deps.api.completeTask({
    taskId: task._id,
    status: "failed",
    errorMessage,
  });
}

/**
 * End a task run as FAILED with a visible error: a `task.error` event,
 * the FAILED lifecycle transition (unless `lifecycle: false`), then
 * completeTask("failed"). The event payload is capped at 2000 chars; the
 * task error message is the full text.
 */
export async function failTaskWithError(input: {
  deps: RunnerDeps;
  taskId: string;
  projectId: string;
  message: string;
  lifecycle?: boolean;
}): Promise<void> {
  const { deps, taskId, projectId, message } = input;
  await deps.api.logEvent({
    taskId,
    projectId,
    type: "task.error",
    payload: { message: message.slice(0, 2000) },
    level: "error",
  });
  if (input.lifecycle !== false) {
    await deps.api
      .recordLifecycle?.({
        taskId,
        projectId,
        state: "FAILED",
        prevState: "RUNNING",
      })
      ?.catch(() => undefined);
  }
  await deps.api.completeTask({
    taskId,
    status: "failed",
    errorMessage: message,
  });
}

/**
 * Plan 005 Step 5.4: the decision step bound is terminal — fail the task
 * explicitly, never mark it done or replan it.
 */
export async function failStepLimit(input: {
  deps: RunnerDeps;
  taskId: string;
  projectId: string;
}): Promise<void> {
  const { deps, taskId, projectId } = input;
  await deps.api.logEvent({
    taskId,
    projectId,
    type: "orchestrator.step_limit",
    payload: { maxDecisionSteps: deps.policy.maxDecisionSteps },
    level: "error",
  });
  await deps.api
    .recordLifecycle?.({
      taskId,
      projectId,
      state: "FAILED",
      prevState: "RUNNING",
    })
    ?.catch(() => undefined);
  await deps.api.completeTask({
    taskId,
    status: "failed",
    errorMessage: "Decision step limit reached",
  });
}
