import { CheckCircle2, Clock, Hand, Loader2, MinusCircle, XCircle, type LucideIcon } from "lucide-react";

/** Task statuses from `apps/api/convex/schema.ts` `taskStatus`. */
export const TASK_STATUSES = [
  "queued",
  "running",
  "needs_approval",
  "waiting_input",
  "paused",
  "done",
  "failed",
  "rejected",
  "cancelled",
] as const;

export const TASK_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  needs_approval: "Needs approval",
  waiting_input: "Waiting for you",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

/**
 * Label for a task status. Pass the task when you have it: a legacy direct
 * thread (removed 2026-11-12) parked in `waiting_input` reads "Idle", not
 * "Waiting for you" (same rule as the API's `isAwaitingUserAnswer`).
 */
export function taskStatusLabel(
  status: string | undefined,
  task?: { mode?: string | null } | null,
): string {
  if (!status) return "Unknown";
  if (isParkedLegacyDirect(status, task)) return "Idle";
  return TASK_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

/** legacy: a direct thread (removed 2026-11-12) left in waiting_input; nothing is asked of the user. */
export function isParkedLegacyDirect(status: string | undefined, task?: { mode?: string | null } | null): boolean {
  return status === "waiting_input" && task?.mode === "direct";
}

/** Pill colours per task status (light + dark). */
export const TASK_STATUS_PILL: Record<string, string> = {
  queued: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  running: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  needs_approval: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  waiting_input: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  paused: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  rejected: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  cancelled: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export const NEUTRAL_PILL = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";

/** Terminal task statuses: the task will not progress on its own. */
export function isClosedStatus(status: string | undefined): boolean {
  return status === "done" || status === "failed" || status === "rejected" || status === "cancelled";
}

/** Subtask statuses from `schema.ts` `subtaskStatus`. */
export const SUBTASK_STATUS: Record<string, { label: string; cls: string; icon: LucideIcon }> = {
  pending: { label: "pending", cls: "text-gray-500 dark:text-gray-400", icon: Clock },
  ready: { label: "ready", cls: "text-gray-600 dark:text-gray-300", icon: Clock },
  running: { label: "running", cls: "text-sky-600 dark:text-sky-400", icon: Loader2 },
  waiting_approval: { label: "needs you", cls: "text-orange-600 dark:text-orange-400", icon: Hand },
  completed: { label: "done", cls: "text-emerald-600 dark:text-emerald-400", icon: CheckCircle2 },
  failed: { label: "failed", cls: "text-red-600 dark:text-red-400", icon: XCircle },
  blocked: { label: "blocked", cls: "text-amber-600 dark:text-amber-400", icon: Clock },
  skipped: { label: "skipped", cls: "text-gray-400 dark:text-gray-500", icon: MinusCircle },
};

export function subtaskStatusMeta(status: string | undefined) {
  return SUBTASK_STATUS[status ?? ""] ?? SUBTASK_STATUS.pending;
}
