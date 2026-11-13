import type { ExecutionPolicy } from "@/orchestrator/policy";

/**
 * One AbortController per task run (Phase 4): fired by the runner's
 * cancel polling when the task row turns terminal, by the
 * policy.taskTimeoutMs wall-clock deadline, and by the MausBot-style
 * idle watchdog — the task aborts only after policy.idleTimeoutMs of NO
 * observable progress (bump() is called on every logged event, usage
 * record, and staged change). Every consumer — scheduler node signals,
 * LLM calls, QA, verification — observes this one signal, so a cancel
 * or a timeout stops the whole task, not just whichever node happens to
 * be scheduled. dispose() disarms everything.
 */
export const SHUTDOWN_ABORT_MESSAGE = "Worker shutting down";
export const LEASE_LOST_PREFIX = "Lease lost";
/** The abort reason of a user Stop (tasks.cancel): finishCancelledTask records it as "cancelled". */
export const USER_CANCEL_MESSAGE = "Cancelled by user";
/** How often a running task re-reads its own status for a user Stop. */
export const TASK_CANCEL_POLL_MS = 2_000;

/** A user Stop: the task row turned "cancelled". Other statuses are the run's own to write (a deleted task is the DAG poll's). */
export function isUserCancelStatus(status: string | null | undefined): boolean {
  return status === "cancelled";
}

/** The status read armTaskAbort polls, when this api can do it (test doubles may not). */
export function taskStatusReader(deps: { api: object }, taskId: string): (() => Promise<string | null>) | undefined {
  const api = deps.api as { getTaskStatus?: (id: string) => Promise<string | null> };
  if (typeof api.getTaskStatus !== "function") return undefined;
  return () => api.getTaskStatus!(String(taskId));
}

/** True for errors/abort reasons that mean "this worker no longer owns the task". */
export function isLeaseLostOrShutdown(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  // Convex wraps server errors ("[CONVEX A(...)] Uncaught Error: Lease lost: ..."),
  // so match anywhere in the message.
  return message.includes(`${LEASE_LOST_PREFIX}:`) || message.includes(LEASE_LOST_PREFIX + " ") ||
    message.startsWith(SHUTDOWN_ABORT_MESSAGE);
}

export function armTaskAbort(
  policy: ExecutionPolicy,
  shutdownSignal?: AbortSignal,
  /** Task Stop: reads the task's status (deps.api.getTaskStatus); polled every cancelPollMs. */
  readStatus?: () => Promise<string | null | undefined>,
  cancelPollMs = TASK_CANCEL_POLL_MS
): {
  controller: AbortController;
  bump: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  // The run signal fires on worker shutdown OR on lease loss (index.ts
  // aborts a task whose heartbeat reported it lost). Keep a "Lease lost"
  // reason as-is so the run ends as "no longer owned", not as a failure.
  const onShutdown = () => {
    const reason: unknown = shutdownSignal?.reason;
    const leaseLost = reason instanceof Error && reason.message.startsWith(LEASE_LOST_PREFIX);
    controller.abort(leaseLost ? reason : new Error(SHUTDOWN_ABORT_MESSAGE));
  };
  if (shutdownSignal?.aborted) onShutdown();
  else shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Task deadline exceeded (${policy.taskTimeoutMs}ms)`)
    );
  }, policy.taskTimeoutMs);
  timer.unref?.();
  let lastActivity = Date.now();
  const bump = () => {
    lastActivity = Date.now();
  };
  const idleMs = policy.idleTimeoutMs ?? 0;
  const idleTimer =
    idleMs > 0
      ? setInterval(() => {
          if (controller.signal.aborted) return;
          if (Date.now() - lastActivity > idleMs) {
            controller.abort(
              new Error(`Task idle exceeded (${idleMs}ms)`)
            );
          }
        }, Math.min(5_000, Math.max(1_000, idleMs / 4)))
      : undefined;
  idleTimer?.unref?.();
  // Task Stop: tasks.cancel only writes the row, so the run polls it and
  // aborts the shared signal; planning, the DAG, executors and LLM calls all
  // observe it. One read at a time; a failed read is retried next tick.
  let reading = false;
  const cancelTimer = readStatus
    ? setInterval(() => {
        if (reading || controller.signal.aborted) return;
        reading = true;
        readStatus()
          .then((status) => {
            if (isUserCancelStatus(status) && !controller.signal.aborted) controller.abort(new Error(USER_CANCEL_MESSAGE));
          })
          .catch(() => undefined)
          .finally(() => {
            reading = false;
          });
      }, cancelPollMs)
    : undefined;
  (cancelTimer as { unref?: () => void } | undefined)?.unref?.();
  return {
    controller,
    bump,
    dispose: () => {
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      shutdownSignal?.removeEventListener("abort", onShutdown);
    },
  };
}

/** A signal that fires when ANY of the given signals fires. */
export function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}
