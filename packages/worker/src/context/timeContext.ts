/**
 * Time context for worker calls (DeepSeek Harness D4, pattern only, MIT,
 * Copyright (c) 2026 DeepSeek; no code copied). The line format and the
 * 10-minute stamping are the pure helpers in lib/timeContext.ts, which chat
 * shares; this module keeps the worker's zone (Settings → General, fetched
 * with the app settings) and one throttle per task workspace.
 */
import { DEFAULT_USER_TIME_ZONE, effectiveTimeZone, TimeContextThrottle } from "@/api/convex/lib/timeContext";

export { TIME_CONTEXT_PREFIX, withTimeTail } from "@/api/convex/lib/timeContext";

let userTimeZone = DEFAULT_USER_TIME_ZONE;
const throttle = new TimeContextThrottle();

/** Settings → worker: the user's zone (invalid or empty → Asia/Jakarta). */
export function setUserTimeZone(raw: string | null | undefined): void {
  userTimeZone = effectiveTimeZone(raw);
}

export function currentUserTimeZone(): string {
  return userTimeZone;
}

/** The time line for one scope (stamped at most once per 10 minutes). */
export function timeContextLine(scope: string, now: number = Date.now()): string {
  return throttle.line(scope, now, userTimeZone);
}

/** Test hook. */
export function resetTimeContextForTest(): void {
  userTimeZone = DEFAULT_USER_TIME_ZONE;
  throttle.clear();
}
