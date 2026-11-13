import type { BudgetTracker } from "@/orchestrator/budget";
import type { FailureKind } from "@/orchestrator/decisionEngine";
import type { WorkerProject, WorkerTask } from "@/workerApi";
import type { RunnerDeps } from "./types";
import { isLeaseLostOrShutdown } from "./abort";
import { classifyProviderHold } from "@/api/convex/lib/providerHold";
// P1b phase 2: the replan trigger facts live with the replan decision.
export {
  alreadyDoneFiles,
  budgetReasonFromSummary,
  findProviderHoldMessage,
  summaryHasBudgetFailure,
} from "@/orchestrator/decisionEngine/replan";

/** Terminal task statuses: a task in one of these is finished for good. */
export function isTerminalTaskStatus(status: string | undefined): boolean {
  return status === "done" || status === "failed" || status === "rejected" || status === "cancelled";
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
    payload: { reason, budget: budget.snapshot(), failureKind: "budget_exhausted" },
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
 * End a task run as cancelled (Phase 4 hardening). A user stop lands on
 * the terminal "cancelled" status (tasks.cancel already wrote it, so this
 * call is usually a no-op); a deadline is a real failure and lands on
 * "failed" with the deadline message. The dedicated `task.cancelled`
 * event records which of the two it was in the task timeline. The backend
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
  // Deadline and idle watchdog aborts are failures with a visible reason,
  // never a silent "cancelled": only a user stop is a cancellation.
  const timedOut =
    reasonText.startsWith("Task deadline exceeded") || reasonText.startsWith("Task idle exceeded");
  const errorMessage = timedOut ? reasonText : "Cancelled by user";
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.cancelled",
    payload: { reason: errorMessage, timedOut, failureKind: timedOut ? "error" : "cancelled" },
    level: "warn",
  });
  await deps.api
    .recordLifecycle?.({
      taskId: task._id,
      projectId: project._id,
      state: timedOut ? "FAILED" : "CANCELLED",
      prevState: "RUNNING",
    })
    ?.catch(() => undefined);
  await deps.api.completeTask({
    taskId: task._id,
    status: timedOut ? "failed" : "cancelled",
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
  /** Item 7: why the run failed (defaults to "error"); provider holds are always "provider_hold". */
  failureKind?: FailureKind;
}): Promise<void> {
  const { deps, taskId, projectId, message } = input;
  // O3 + L7: a provider failure (offline, 429, quota, auth) is a hold, not
  // a failure: the backend's completeTask parks the task (paused, pausedBy
  // "held") and resumes it with backoff. No task.error, no FAILED.
  const hold = classifyProviderHold(message);
  if (hold) {
    await deps.api.logEvent({
      taskId,
      projectId,
      type: "llm.provider_hold",
      payload: { kind: hold.kind, reason: hold.reason, message: message.slice(0, 500), failureKind: "provider_hold" },
      level: "warn",
    });
    await deps.api.completeTask({ taskId, status: "failed", errorMessage: message });
    return;
  }
  await deps.api.logEvent({
    taskId,
    projectId,
    type: "task.error",
    payload: { message: message.slice(0, 2000), failureKind: input.failureKind ?? "error" },
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
    payload: { maxDecisionSteps: deps.policy.maxDecisionSteps, failureKind: "budget_exhausted" },
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

/**
 * End a no-op run as DONE with a clear `task.no_change` event and a
 * message from the Response Owner (O2; callers pass its agent id): "No
 * change needed: … already has the requested content", never a replan or
 * a failure.
 */
export async function finishAlreadyDone(input: {
  deps: RunnerDeps;
  taskId: string;
  projectId: string;
  files: string[];
  agentId?: string;
  lifecycle?: boolean;
}): Promise<void> {
  const { deps, taskId, projectId, files } = input;
  const list = files.slice(0, 10).join(", ") + (files.length > 10 ? ", …" : "");
  const message = `No change needed: ${list} already ${files.length === 1 ? "has" : "have"} the requested content, so nothing was staged or applied.`;
  await deps.api.logEvent({
    taskId,
    projectId,
    type: "task.no_change",
    payload: { files, message },
    level: "info",
  });
  await deps.api
    .appendAgentMessage({ projectId, taskId, content: message, agentId: input.agentId as any })
    .catch(() => undefined);
  if (input.lifecycle !== false) {
    await deps.api
      .recordLifecycle?.({ taskId, projectId, state: "COMPLETED", prevState: "RUNNING" })
      ?.catch(() => undefined);
  }
  await deps.api.completeTask({ taskId, status: "done" });
}
