import type { RunnerDeps } from "./types";

/**
 * Plan 022: this run stopped because the user paused the task (running
 * work drained, nothing new started). Hand the task back: the backend
 * clears this worker's lease and keeps it `paused` (it never auto-resumes),
 * or — when the user already pressed Resume while the run drained —
 * re-queues it so a fresh claim continues from the stored plan.
 */
export async function releaseAfterPause(deps: RunnerDeps, taskId: string, projectId: string): Promise<void> {
  const released = await deps.api
    .releasePausedTask?.({ taskId: taskId as never, workerId: deps.workerId })
    ?.catch(() => null);
  await deps.api
    .logEvent({
      taskId,
      projectId,
      type: "task.pause_drained",
      payload: { result: (released as { result?: string } | null | undefined)?.result ?? "unknown" },
    })
    .catch(() => undefined);
}
