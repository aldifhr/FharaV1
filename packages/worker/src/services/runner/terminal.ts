import type { BudgetTracker } from "@/orchestrator/budget";
import type { WorkerProject, WorkerTask } from "@/workerApi";
import type { RunnerDeps } from "./types";
import { isLeaseLostOrShutdown } from "./abort";
import { classifyProviderHold } from "@/api/convex/lib/providerHold";

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
    payload: { reason: errorMessage, timedOut },
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
 * O3 bug c: the provider error behind a replan, when there is one. A 429
 * (or an offline / out-of-quota / refused provider) on a subtask reaches
 * the decision step as a failed node, the engine asks for a replan, and
 * the replan is rejected as a repeat of the same node, so the task FAILED
 * instead of being held. The replan feedback and the run's feedback list
 * are checked here; the first provider failure found is returned as the
 * original provider message (the `node:` / `node (attempt n):` prefix the
 * runner adds is dropped) so the caller routes it to the hold path.
 */
export function findProviderHoldMessage(texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!text || !classifyProviderHold(text)) continue;
    const stripped = text.replace(/^[\w.:-]+(?: \(attempt \d+\))?: /, "");
    return classifyProviderHold(stripped) ? stripped : text;
  }
  return null;
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
  // O3 + L7: a provider failure (offline, 429, quota, auth) is a hold, not
  // a failure: the backend's completeTask parks the task (paused, pausedBy
  // "held") and resumes it with backoff. No task.error, no FAILED.
  const hold = classifyProviderHold(message);
  if (hold) {
    await deps.api.logEvent({
      taskId,
      projectId,
      type: "llm.provider_hold",
      payload: { kind: hold.kind, reason: hold.reason, message: message.slice(0, 500) },
      level: "warn",
    });
    await deps.api.completeTask({ taskId, status: "failed", errorMessage: message });
    return;
  }
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

const NO_EFFECTIVE_CHANGE = /No effective change: (.+?) would be identical to the current content/;
const NO_FILE_CHANGES = /^The implementation produced no file changes$/;

/**
 * A run whose only failures are "No effective change" (every file the
 * executor wrote already had that content) and that staged nothing: the
 * requested change is already in the repository. Replanning would ask for
 * the same edit again and be rejected as a repeat (e2e mock round 2), so
 * the caller ends the task cleanly instead. Returns the files that were
 * already up to date, or null when any other failure is present, a change
 * is staged, or a verify-fix loop set its own terminal failure.
 */
export function alreadyDoneFiles(state: {
  feedback: ReadonlyArray<string>;
  fileChanges: { size: number };
  terminalFailure?: string;
}): string[] | null {
  if (state.terminalFailure || state.fileChanges.size > 0) return null;
  const entries = state.feedback.filter((line) => line && line.trim());
  if (entries.length === 0) return null;
  const files = new Set<string>();
  for (const line of entries) {
    const stripped = line.replace(/^[\w.:-]+(?: \(attempt \d+\))?: /, "");
    const noop = NO_EFFECTIVE_CHANGE.exec(stripped);
    if (noop) {
      for (const file of noop[1].split(",")) if (file.trim()) files.add(file.trim());
      continue;
    }
    if (NO_FILE_CHANGES.test(stripped.trim())) continue;
    return null;
  }
  return files.size > 0 ? [...files] : null;
}

/**
 * End a no-op run as DONE with a clear `task.no_change` event and a CTO
 * message ("No change needed: … already has the requested content"),
 * never a replan or a failure.
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
