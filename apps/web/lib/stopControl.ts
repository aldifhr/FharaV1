/**
 * Stop buttons (chat composer, task inspector header, run page): when each
 * one shows, what it says, and the double-press guard. Pure, so the web unit
 * tests cover it without rendering.
 */

/** A reply older than this with no live bubble is the sweeper's, not Stop's (CHAT_REPLY_STALE_MS default). */
export const REPLY_STOP_WINDOW_MS = 15 * 60_000;

type TimelineRow = {
  _id: string;
  _creationTime: number;
  authorType?: string;
  replyStatus?: string;
  replyToMessageId?: string;
  streaming?: boolean;
  interrupted?: boolean;
  /** Optimistic rows (lib/optimisticChat) have no server id yet. */
  optimistic?: boolean;
};

/**
 * The user message whose reply is in flight (pending or streaming), or null.
 * The newest user message counts while its reply is pending/replying; an
 * agent bubble still streaming counts for the message it answers.
 */
export function inFlightReply(timeline: readonly TimelineRow[], now: number): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const m = timeline[i];
    if (m.authorType === "agent" && m.streaming === true && !m.interrupted && m.replyToMessageId) {
      return now - m._creationTime < REPLY_STOP_WINDOW_MS ? m.replyToMessageId : null;
    }
    if (m.authorType !== "user") continue;
    if (m.optimistic) return null;
    const live = m.replyStatus === "pending" || m.replyStatus === "replying";
    return live && now - m._creationTime < REPLY_STOP_WINDOW_MS ? m._id : null;
  }
  return null;
}

/** A settled reply (no typing ghost): answered, failed, or stopped by the user. */
export function isReplySettled(replyStatus: string | undefined): boolean {
  return replyStatus === "answered" || replyStatus === "failed" || replyStatus === "stopped";
}

/** Statuses tasks.cancel can still stop (it refuses done / rejected / cancelled; failed has nothing running). */
const STOPPABLE_TASK_STATUSES = new Set(["queued", "running", "paused", "needs_approval", "waiting_input"]);

export function isTaskStoppable(task: { status?: string; mode?: string | null } | null | undefined): boolean {
  if (!task?.status) return false;
  // Legacy direct threads (removed 2026-11-12) are read-only.
  if (task.mode === "direct") return false;
  return STOPPABLE_TASK_STATUSES.has(task.status);
}

export const TASK_STOP_CONFIRM = {
  title: "Stop this task?",
  message: "Work in progress is lost. The task stops now and is marked as cancelled.",
  confirmLabel: "Stop task",
  icon: "stop" as const,
};

export function stopLabel(stopping: boolean): string {
  return stopping ? "Stopping…" : "Stop";
}

/**
 * Wraps a stop call so a second press while the first is in flight does
 * nothing (resolves false). `onBusy` mirrors the in-flight state for the UI.
 */
export function guardStop<A>(
  call: (args: A) => Promise<unknown>,
  onBusy: (busy: boolean) => void = () => undefined
): (args: A) => Promise<boolean> {
  let busy = false;
  return async (args: A) => {
    if (busy) return false;
    busy = true;
    onBusy(true);
    try {
      await call(args);
      return true;
    } finally {
      busy = false;
      onBusy(false);
    }
  };
}
