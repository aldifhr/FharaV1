/**
 * Plain-text helpers for Settings → Scheduled tasks (GOAT G8): how a
 * schedule, a target, a time and a run read in the list.
 */
import type { api } from "@/api/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type ScheduledTaskRow = FunctionReturnType<typeof api.scheduledTasks.listForViewer>[number];
export type ScheduledRunRow = FunctionReturnType<typeof api.scheduledTasks.listRuns>[number];
export type Schedule = ScheduledTaskRow["schedule"];

export const DEFAULT_ZONE = "Asia/Jakarta";
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MINUTE = 60_000;
export const INTERVAL_UNITS = [
  { value: "minutes", label: "minutes", ms: MINUTE },
  { value: "hours", label: "hours", ms: 60 * MINUTE },
  { value: "days", label: "days", ms: 24 * 60 * MINUTE },
] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number]["value"];

/** The largest unit that divides the interval evenly, for the edit form. */
export function splitInterval(everyMs: number): { amount: number; unit: IntervalUnit } {
  for (const unit of [...INTERVAL_UNITS].reverse()) {
    if (everyMs >= unit.ms && everyMs % unit.ms === 0) return { amount: everyMs / unit.ms, unit: unit.value };
  }
  return { amount: Math.max(1, Math.round(everyMs / MINUTE)), unit: "minutes" };
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word.replace(/s$/, "") : word}`;
}

function weekdaysText(days: readonly number[] | undefined): string {
  const set = [...new Set(days ?? [])].sort((a, b) => a - b);
  if (set.length === 0 || set.length === 7) return "Every day";
  if (set.join() === "1,2,3,4,5") return "Weekdays";
  if (set.join() === "0,6") return "Weekends";
  return set.map((d) => WEEKDAYS[d]).join(", ");
}

export function scheduleText(schedule: Schedule): string {
  if (schedule.type === "interval") {
    const { amount, unit } = splitInterval(schedule.everyMs);
    return `Every ${plural(amount, unit)}`;
  }
  return `${weekdaysText(schedule.weekdays)} at ${schedule.timeOfDay} (${schedule.timeZone ?? DEFAULT_ZONE})`;
}

export function targetText(row: ScheduledTaskRow): string {
  const where = row.projectName ? ` in ${row.projectName}` : "";
  return row.target.kind === "task" ? `Creates a task${where}` : `Sends a message to a conversation${where}`;
}

/** "Thu 12 Nov, 09:00" in the given zone. */
export function formatWhen(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(ms);
  } catch {
    // an unknown zone on an old row: fall back to the browser's own
    return new Date(ms).toLocaleString();
  }
}

const STATUS_TEXT: Record<ScheduledRunRow["status"], string> = {
  dispatched: "Started",
  held: "Skipped (automation held)",
  missed: "Missed (more than 10 min late)",
  failed: "Failed",
};
const TRIGGER_TEXT = { clock: "on schedule", webhook: "by webhook", manual: "run now" } as const;

export function runText(run: ScheduledRunRow): string {
  const trigger = TRIGGER_TEXT[run.trigger ?? "clock"];
  const error = run.status === "failed" && run.error ? `: ${run.error}` : "";
  return `${STATUS_TEXT[run.status]} ${trigger}${error}`;
}

export function lastStatusText(status: ScheduledTaskRow["lastStatus"]): string {
  return status ? STATUS_TEXT[status] : "Not run yet";
}
