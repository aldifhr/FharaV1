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

/** True for errors/abort reasons that mean "this worker no longer owns the task". */
export function isLeaseLostOrShutdown(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  // Convex wraps server errors ("[CONVEX A(...)] Uncaught Error: Lease lost: ..."),
  // so match anywhere in the message.
  return message.includes(`${LEASE_LOST_PREFIX}:`) || message.includes(LEASE_LOST_PREFIX + " ") ||
    message.startsWith(SHUTDOWN_ABORT_MESSAGE);
}

export function armTaskAbort(policy: ExecutionPolicy, shutdownSignal?: AbortSignal): {
  controller: AbortController;
  bump: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onShutdown = () => controller.abort(new Error(SHUTDOWN_ABORT_MESSAGE));
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
  return {
    controller,
    bump,
    dispose: () => {
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
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
