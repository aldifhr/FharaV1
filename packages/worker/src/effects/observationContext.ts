import { AsyncLocalStorage } from "node:async_hooks";
import type { StallObservation } from "@/utils/stallDetector";

/**
 * Per-node observation scope. The runner enters it around each subtask's
 * execution, so code deep in the call stack (the LLM fallback chain) can
 * report a typed observation and a progress heartbeat without threading a
 * sink through every executor signature.
 */
export interface ObservationScope {
  nodeKey?: string;
  emit?: (observation: StallObservation) => void;
  /** Heartbeat for the scheduler's stall watchdog. */
  progress?: () => void;
}

const storage = new AsyncLocalStorage<ObservationScope>();

export function runWithObservationScope<T>(scope: ObservationScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentObservationScope(): ObservationScope | undefined {
  return storage.getStore();
}

/** Report an observation to the current scope (no-op outside one). */
export function emitObservation(observation: StallObservation): void {
  const scope = storage.getStore();
  if (!scope?.emit) return;
  try {
    scope.emit({ ...observation, nodeKey: observation.nodeKey ?? scope.nodeKey });
  } catch {
    // Observability never breaks the call it observes.
  }
}

/** Mark progress for the current node (no-op outside a scope). */
export function markProgress(): void {
  storage.getStore()?.progress?.();
}
