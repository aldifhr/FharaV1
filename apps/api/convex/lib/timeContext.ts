/**
 * Time context (pure; shared by the worker and chat).
 *
 * Pattern from DeepSeek Harness (MIT, Copyright (c) 2026 DeepSeek): runtime
 * context is logged AFTER the retained history, so the stable prompt prefix
 * never changes. No code copied.
 *
 * One line, `Current time: …`, goes in the volatile tail of a call (after
 * history, last). Per scope (a task workspace, a chat conversation) the
 * line is stamped at most once per 10 minutes: within the window the same
 * line is reused byte for byte, so it never churns the prompt cache.
 */

import { assemblePrompt } from "./assemblePrompt";

export const DEFAULT_USER_TIME_ZONE = "Asia/Jakarta";
export const TIME_CONTEXT_PREFIX = "Current time:";
export const TIME_CONTEXT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SCOPES = 500;

/** A valid IANA zone name, else null. */
export function normalizeTimeZone(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The zone to use: a valid stored zone, else Asia/Jakarta. */
export function effectiveTimeZone(raw: string | null | undefined): string {
  return normalizeTimeZone(raw) ?? DEFAULT_USER_TIME_ZONE;
}

/** `Current time: Thu 2026-11-12 00:24 (Asia/Jakarta, UTC+07:00).` */
export function formatTimeLine(now: number, timeZone: string): string {
  const zone = effectiveTimeZone(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
  const offset = (parts.timeZoneName ?? "GMT").replace(/^GMT$/, "GMT+00:00").replace(/^GMT/, "UTC");
  return `${TIME_CONTEXT_PREFIX} ${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${zone}, ${offset}).`;
}

/** Per-scope stamping: a new line at most once per interval (or on a zone change). */
export class TimeContextThrottle {
  private readonly stamps = new Map<string, { at: number; zone: string; line: string }>();

  constructor(private readonly intervalMs: number = TIME_CONTEXT_INTERVAL_MS) {}

  line(scope: string, now: number, timeZone: string): string {
    const zone = effectiveTimeZone(timeZone);
    const previous = this.stamps.get(scope);
    if (previous && previous.zone === zone && now >= previous.at && now - previous.at < this.intervalMs) return previous.line;
    const line = formatTimeLine(now, zone);
    this.stamps.delete(scope);
    this.stamps.set(scope, { at: now, zone, line });
    if (this.stamps.size > MAX_SCOPES) {
      const oldest = this.stamps.keys().next().value;
      if (oldest !== undefined) this.stamps.delete(oldest);
    }
    return line;
  }

  clear(): void {
    this.stamps.clear();
  }
}

/**
 * Append the time line to the last user turn (the volatile tail, after
 * history). Returns the messages unchanged when the last turn is not the
 * user's, so a prefilled assistant turn is never split.
 */
export function withTimeTail<T extends { role: string; content: string }>(messages: T[], line: string): T[] {
  const last = messages[messages.length - 1];
  if (!line || !last || last.role !== "user") return messages;
  // D5: the shared layout (stable → history → volatile) places the tail.
  return assemblePrompt({ history: messages, volatile: line });
}
