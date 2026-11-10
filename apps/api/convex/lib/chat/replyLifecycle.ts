/**
 * Durable chat replies (t3code idea #1: a side effect is a durable row with a
 * lease and a sweeper; idea only, no code copied).
 *
 * A chat reply runs in a `"use node"` Convex action, which Convex kills after
 * 10 minutes (https://docs.convex.dev/production/state/limits). When that
 * happens (or a deploy / OOM), the action's own catch never runs, so the
 * user message and its streaming bubble must be settled from outside.
 */

/** Convex's hard cap on a Node action. */
export const NODE_ACTION_LIMIT_MS = 10 * 60_000;
/** Default: 15 minutes, comfortably past the action cap. */
export const DEFAULT_CHAT_REPLY_STALE_MS = 15 * 60_000;
/** Never below the action cap plus a margin, or live replies would be cut. */
export const MIN_CHAT_REPLY_STALE_MS = NODE_ACTION_LIMIT_MS + 60_000;
/** Rows touched per sweep (bounded mutation). */
export const CHAT_SWEEP_BATCH = 100;

/** `CHAT_REPLY_STALE_MS` (ms), clamped to at least MIN_CHAT_REPLY_STALE_MS. */
export function chatReplyStaleMs(raw: string | undefined = process.env.CHAT_REPLY_STALE_MS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAT_REPLY_STALE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHAT_REPLY_STALE_MS;
  return Math.max(MIN_CHAT_REPLY_STALE_MS, Math.floor(parsed));
}

export type ReplyStatus = "pending" | "replying" | "answered" | "failed";

/**
 * May a new replyToChat run claim this user message?
 * - pending: yes (fresh send, or Retry reset it).
 * - replying: no while the claim is live; a dead claim is the sweeper's to
 *   settle as failed first, so a slow-but-alive run is never doubled.
 * - answered / failed: no (Retry resets failed to pending explicitly).
 * - legacy rows (no replyStatus): only if nothing replied to them yet.
 */
export function canClaimReply(input: { replyStatus?: ReplyStatus; hasReply: boolean }): boolean {
  if (input.replyStatus === undefined) return !input.hasReply;
  return input.replyStatus === "pending";
}

/** Short, user-facing reason stored on a failed reply. */
export function replyFailureText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line = raw.split("\n")[0]?.trim() ?? "";
  return (line || "The reply stopped before it finished.").slice(0, 300);
}

export const REPLY_INTERRUPTED_TEXT = "The reply stopped before it finished.";

/** A chat user message (project conversation), not a task-thread or worker-queue row. */
export function isChatUserMessage(message: { authorType: string; taskId?: unknown; conversationId?: unknown }): boolean {
  return message.authorType === "user" && !message.taskId && message.conversationId !== undefined;
}
