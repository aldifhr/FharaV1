/**
 * GOAT G5: hidden-ref checkpoints of a task worktree (audit/goat-plan-2026-11-11.md, idea #1a).
 *
 * The worker (tools/gitCheckpoint.ts) captures the whole worktree after
 * each subtask and after apply as a commit under
 * `refs/fhara/checkpoints/<taskId>/<n>`, built in a temporary index, so
 * HEAD, the branch and the real index never move. The refs live in the
 * repository's common ref store, shared by the main checkout and every
 * worktree, so they outlive `git worktree remove`; the worktree sweep
 * deletes them with `removeTaskGitState`.
 *
 * The ref layout is a pattern from GOAT (apps/server/src/vcs/GitVcsDriver.ts,
 * `refs/goat/.../checkpoints/<thread>/<n>`); see THIRD_PARTY_NOTICES.md.
 * Pure: git runs through the injected `GitSync` (no node: imports).
 */
import { taskWorktreesFromPorcelain } from "./taskBranch";

export const CHECKPOINT_REF_ROOT = "refs/fhara/checkpoints";

/** Runs git with argv in the repo and returns stdout; throws on a non-zero exit. */
export type GitSync = (args: string[]) => string;

/** A Convex id (or a test id): letters, digits, `_` and `-` only, so it is always a valid ref component. */
function assertRefSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`Invalid task id for a checkpoint ref: ${JSON.stringify(taskId)}`);
}

export function checkpointRefPrefix(taskId: string): string {
  assertRefSafeTaskId(taskId);
  return `${CHECKPOINT_REF_ROOT}/${taskId}/`;
}

export function checkpointRefName(taskId: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Checkpoint number must be a positive integer, got ${n}`);
  return `${checkpointRefPrefix(taskId)}${n}`;
}

/** `n` of `refs/fhara/checkpoints/<taskId>/<n>`, else null. */
export function checkpointNumber(ref: string, taskId: string): number | null {
  const prefix = checkpointRefPrefix(taskId);
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  return /^[1-9]\d*$/.test(rest) ? Number(rest) : null;
}

/** Every checkpoint ref of the task, oldest number first. */
export function listTaskCheckpointRefs(git: GitSync, taskId: string): string[] {
  const out = git(["for-each-ref", "--format=%(refname)", checkpointRefPrefix(taskId)]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((ref) => checkpointNumber(ref, taskId) !== null)
    .sort((a, b) => checkpointNumber(a, taskId)! - checkpointNumber(b, taskId)!);
}

/** Deletes every checkpoint ref of the task; returns the deleted names. A ref that fails stays listed out. */
export function deleteTaskCheckpointRefs(git: GitSync, taskId: string): string[] {
  const deleted: string[] = [];
  for (const ref of listTaskCheckpointRefs(git, taskId)) {
    try {
      git(["update-ref", "-d", ref]);
      deleted.push(ref);
    } catch {
      // Best effort: the next sweep retries.
    }
  }
  return deleted;
}

/**
 * The worktree sweep for one task: remove each of its worktrees (never the
 * main checkout), prune, and delete its checkpoint refs. Branches are kept.
 * Every step is best effort, as the sweep always was.
 *
 * GOAT G6: `beforeRemove` runs first for each worktree (the sweep's
 * snapshot, lib/checkpointRestore.ts). When it throws, that worktree is
 * kept and the checkpoint refs too (`kept`), so the next sweep retries.
 */
export function removeTaskGitState(
  git: GitSync,
  taskId: string,
  isMainCheckout: (worktreePath: string) => boolean,
  beforeRemove?: (worktreePath: string) => void,
): { removed: string[]; refsDeleted: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  try {
    // Porcelain output, matched on the branch: the human `worktree list`
    // lines start with the path followed by sha and branch.
    const porcelain = git(["worktree", "list", "--porcelain"]);
    for (const wtPath of taskWorktreesFromPorcelain(porcelain, taskId)) {
      if (isMainCheckout(wtPath)) continue;
      try {
        beforeRemove?.(wtPath);
      } catch {
        kept.push(wtPath);
        continue;
      }
      try {
        git(["worktree", "remove", "--force", wtPath]);
        removed.push(wtPath);
      } catch {}
    }
    try {
      git(["worktree", "prune"]);
    } catch {}
  } catch {}
  let refsDeleted: string[] = [];
  if (kept.length > 0) return { removed, refsDeleted, kept };
  try {
    refsDeleted = deleteTaskCheckpointRefs(git, taskId);
  } catch {}
  return { removed, refsDeleted, kept };
}
