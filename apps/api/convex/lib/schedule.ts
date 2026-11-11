// Adapted from GOAT (https://github.com/goat-si/goat) apps/server/src/scheduledTasks/Schedule.ts @ 718f5b11,
// MIT License, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors. See THIRD_PARTY_NOTICES.md.
// Modified by Fhara, 2026-11 (GOAT G7): Effect DateTime became epoch milliseconds,
// and a fixed-time schedule carries an IANA time zone (default Asia/Jakarta)
// resolved with Intl, so wall-clock times stay put across daylight saving.
// Webhook schedules (G8) have no clock time and are not handled here.

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;
export const DEFAULT_SCHEDULE_TIME_ZONE = "Asia/Jakarta";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type ScheduledTaskSchedule =
  | { type: "interval"; everyMs: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays?: number[]; timeZone?: string };

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall clock in `timeZone` at the instant `ms`. */
export function zonedParts(ms: number, timeZone: string): WallClock {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Wall clock minus UTC at `ms`, in milliseconds (Asia/Jakarta: +7 h). */
function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function sameWall(ms: number, timeZone: string, w: WallClock): boolean {
  const p = zonedParts(ms, timeZone);
  return p.year === w.year && p.month === w.month && p.day === w.day && p.hour === w.hour && p.minute === w.minute;
}

/**
 * The instant a wall-clock time happens in `timeZone`. An ambiguous time
 * (clocks fall back) takes the earlier instant; a time the zone skips
 * (clocks spring forward) lands that many minutes later, as the clock reads it.
 */
export function zonedTimeToUtc(w: WallClock, timeZone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const before = guess - offsetMs(guess - DAY_MS, timeZone);
  const after = guess - offsetMs(guess + DAY_MS, timeZone);
  const valid = [before, after].filter((t) => sameWall(t, timeZone, w));
  if (valid.length > 0) return Math.min(...valid);
  return before;
}

export function nextScheduledRunAt(schedule: ScheduledTaskSchedule, from: number): number | null {
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return from + Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS);
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const timeZone = schedule.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) return null;
  const weekdays = schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  const today = zonedParts(from, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    // Walk local calendar days, then place the wall-clock time on each.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (weekdays !== null && !weekdays.has(date.getUTCDay())) continue;
    const candidate = zonedTimeToUtc(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: time.hour, minute: time.minute, second: 0 },
      timeZone,
    );
    if (candidate <= from) continue;
    return candidate;
  }
  return null;
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].sort((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
    (a.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE) === (b.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE)
  );
}

export const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

/** A fixed-time run more than 10 minutes late is skipped, not fired late. */
export function isMissedFixedTimeRun(schedule: ScheduledTaskSchedule, dueAt: number, now: number): boolean {
  if (schedule.type !== "fixed_time") return false;
  return now - dueAt > MISSED_FIXED_TIME_GRACE_MS;
}

/** The next run as stored, or null when disabled or the occurrence is unrepresentable. */
export function nextRunAt(task: { enabled: boolean; schedule: ScheduledTaskSchedule }, from: number): number | null {
  if (!task.enabled) return null;
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(next) && Math.abs(next) <= 8.64e15 ? next : null;
  } catch {
    return null;
  }
}

/** One fire per scheduled task and occurrence: the dedupe key for its run and its task. */
export function scheduledFireKey(scheduledTaskId: string, dueAt: number): string {
  return `sched:${scheduledTaskId}:${dueAt}`;
}
