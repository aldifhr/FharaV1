/**
 * Shared date/time formatting for the UI. Formats are fixed (not the
 * browser locale) so labels read the same everywhere: 24-hour "14:05"
 * times and "Nov 9" dates.
 */

/** "14:05" */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "Nov 9" */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** True when `ms` falls on the same calendar day as `reference` (default now). */
export function isSameDay(ms: number, reference: number = Date.now()): boolean {
  return new Date(ms).toDateString() === new Date(reference).toDateString();
}
