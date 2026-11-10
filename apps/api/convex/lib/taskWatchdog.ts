/**
 * Backend task watchdog (pure part). The worker has its own watchdogs
 * (planning stall, idle timeout, subtask stall), but a hung worker keeps
 * renewing its lease through the heartbeat, and a dead worker leaves
 * recovery to the next worker that boots. The backend cron catches both:
 *
 *  - lapsed leases are recovered (requeued or failed) by recoverStale even
 *    when no worker is running, and
 *  - a `running` task whose LAST PROGRESS (task row write, task event,
 *    live subtask output, execution start) is older than the stuck window
 *    is failed with a visible reason instead of staying in limbo.
 *
 * Exported for unit tests (taskWatchdog.test.ts).
 */
import { cenvParse, cenvRaw } from "@fhara/config/convex";

/** Default stuck window: no progress at all for this long fails the task. */
export const DEFAULT_TASK_STUCK_MS = 30 * 60_000;
/** Lower bound so a misconfigured env never kills healthy tasks. */
export const MIN_TASK_STUCK_MS = 5 * 60_000;
/** Tasks examined per watchdog pass. */
export const WATCHDOG_BATCH = 50;

/** The stuck window from `TASK_WATCHDOG_STUCK_MS` (0 disables the stuck check). */
export function taskStuckMs(raw: string | undefined = cenvRaw("TASK_WATCHDOG_STUCK_MS")): number {
  // Blank/invalid → default; ≤ 0 → 0 (off); at least MIN_TASK_STUCK_MS (schema).
  return cenvParse("TASK_WATCHDOG_STUCK_MS", raw);
}

/** Latest progress timestamp among the given signals (undefined ignored). */
export function lastProgressAt(signals: Array<number | undefined | null>): number {
  let latest = 0;
  for (const value of signals) {
    if (typeof value === "number" && Number.isFinite(value) && value > latest) latest = value;
  }
  return latest;
}

export function isStuck(lastProgress: number, now: number, stuckMs: number): boolean {
  if (stuckMs <= 0) return false;
  return now - lastProgress > stuckMs;
}

/** The visible reason a stuck task is failed with. */
export function stuckReason(lastProgress: number, now: number, lastEventType?: string): string {
  const minutes = Math.max(1, Math.round((now - lastProgress) / 60_000));
  const where = lastEventType ? ` (last event: ${lastEventType})` : "";
  return (
    `Watchdog: no progress for ${minutes} min${where}. ` +
    "The task was stopped instead of staying in limbo; Retry to plan and run it again."
  );
}
