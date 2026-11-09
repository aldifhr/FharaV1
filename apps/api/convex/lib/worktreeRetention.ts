/**
 * Stale worktree cleanup (pure rules; the sweep lives in worktreeNode and
 * orchestration). A finished task's worktree is removed once it has been
 * finished for the retention window, unless a pull request for it is still
 * open (draft/open) or a push is in flight. The task branch itself is kept,
 * so committed work stays reachable.
 */

export const FINISHED_TASK_STATUSES = ["done", "failed", "rejected", "cancelled"] as const;

/** Default retention: 72 h. Override with FHARA_WORKTREE_RETENTION_HOURS (1–720). */
export const DEFAULT_WORKTREE_RETENTION_HOURS = 72;

export function worktreeRetentionMs(raw: string | undefined = process.env.FHARA_WORKTREE_RETENTION_HOURS): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  const hours = Number.isFinite(parsed)
    ? Math.min(720, Math.max(1, Math.floor(parsed)))
    : DEFAULT_WORKTREE_RETENTION_HOURS;
  return hours * 60 * 60 * 1000;
}

export interface WorktreeCleanupCandidate {
  status: string;
  worktreePath?: string;
  /** When the task last changed (completedAt preferred by the caller). */
  finishedAt?: number;
  pushes: Array<{ status: string; prState?: string }>;
}

export function worktreeCleanupBlocker(
  task: WorktreeCleanupCandidate,
  now: number,
  retentionMs: number
): string | null {
  if (!task.worktreePath) return "no worktree";
  if (!(FINISHED_TASK_STATUSES as readonly string[]).includes(task.status)) return "task not finished";
  if (task.finishedAt === undefined || now - task.finishedAt < retentionMs) return "inside retention window";
  if (task.pushes.some((push) => push.prState === "open" || push.prState === "draft")) return "pull request still open";
  if (task.pushes.some((push) => push.status === "requested" || push.status === "pushing")) return "push in flight";
  return null;
}
