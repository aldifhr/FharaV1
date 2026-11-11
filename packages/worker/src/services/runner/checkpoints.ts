/**
 * GOAT G5: capture the task worktree as a hidden-ref checkpoint after each
 * finished subtask and after apply (tools/gitCheckpoint.ts), and record the
 * row in Convex (`checkpoints.record`). Isolated worktrees only: a task
 * running in the project checkout itself is not captured.
 *
 * Best effort: a failed capture or report never fails the run. Captures of
 * one worktree run one at a time, so parallel subtasks get distinct
 * numbers without racing on the ref store.
 */
import { api } from "@/api/convex/_generated/api";
import type { Id } from "@/api/convex/_generated/dataModel";
import { CHECKPOINT_FILES_LIMIT } from "@/api/convex/lib/checkpointValidators";
import { captureCheckpoint, type CapturedCheckpoint } from "@/tools/gitCheckpoint";
import type { WorkerApi } from "@/workerApi";
import type { RunContext } from "./types";

export type CheckpointKind = "subtask" | "apply";

const queues = new Map<string, Promise<unknown>>();

/** Runs `job` after every earlier capture of the same worktree settled. */
function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(job);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => undefined);
  return next;
}

/** The `checkpoints.record` arguments for one capture (files capped to the row limit). */
export function checkpointRecordArgs(
  taskId: string,
  captured: CapturedCheckpoint,
  kind: CheckpointKind,
  subtaskKey?: string
) {
  const files = captured.files.slice(0, CHECKPOINT_FILES_LIMIT).map((file) => ({
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    additions: file.additions,
    deletions: file.deletions,
  }));
  return {
    taskId: taskId as Id<"tasks">,
    n: captured.n,
    ref: captured.ref,
    commitSha: captured.commitSha,
    treeSha: captured.treeSha,
    ...(captured.headSha ? { headSha: captured.headSha } : {}),
    ...(captured.previousSha ? { previousSha: captured.previousSha } : {}),
    kind,
    ...(subtaskKey ? { subtaskKey } : {}),
    files,
    ...(captured.files.length > files.length ? { filesTruncated: true } : {}),
    filesChanged: captured.files.length,
    additions: captured.additions,
    deletions: captured.deletions,
  };
}

/** Not a WorkerApi method: workerApi.ts is at its line budget. */
async function recordCheckpoint(workerApi: WorkerApi, args: ReturnType<typeof checkpointRecordArgs>): Promise<void> {
  await workerApi.client.action(api.checkpoints.record, workerApi.args(args));
}

/** Captures and records one checkpoint; returns it, or null when skipped or failed. */
export async function captureRunCheckpoint(
  ctx: Pick<RunContext, "input" | "deps" | "taskId">,
  kind: CheckpointKind,
  subtaskKey?: string
): Promise<CapturedCheckpoint | null> {
  const worktreePath = ctx.input.worktree?.worktreePath;
  if (!worktreePath) return null;
  try {
    return await serialized(worktreePath, async () => {
      const captured = await captureCheckpoint(worktreePath, ctx.taskId);
      await recordCheckpoint(ctx.deps.api, checkpointRecordArgs(ctx.taskId, captured, kind, subtaskKey));
      return captured;
    });
  } catch (err) {
    console.warn(`[checkpoint] ${kind}${subtaskKey ? ` ${subtaskKey}` : ""} not captured: ${(err as Error)?.message ?? err}`);
    return null;
  }
}
