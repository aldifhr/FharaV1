/**
 * Chat stream limits (live test 2026-11-11: a slow model was cut at a fixed
 * 120 s from the start of the stream while it was still sending text).
 *
 * Two separate limits:
 * - idle: no byte from the provider for `idleMs` (waiting for the first
 *   byte counts too). A model that keeps streaming is never cut by it.
 * - total: a generous cap per stream, kept under Convex's 10 min Node
 *   action limit so the reply is settled by its own run, with its text.
 *
 * A stream cut by either limit (or by a network error) throws a
 * ChatStreamError carrying the text streamed so far, so the caller keeps
 * it as an interrupted reply instead of discarding it.
 */
import { cenvRaw, cenvParse } from "@fhara/config/convex";
import { formatTimeoutLimit } from "../llmWireErrors";

export type ChatStreamLimits = { idleMs: number; totalMs: number };

/** CHAT_LLM_IDLE_TIMEOUT_MS / CHAT_LLM_STREAM_MAX_MS (schema defaults: 180 s / 540 s). */
export function chatStreamLimits(source?: {
  idle?: string | undefined;
  total?: string | undefined;
}): ChatStreamLimits {
  const idleMs = cenvParse("CHAT_LLM_IDLE_TIMEOUT_MS", source ? source.idle : cenvRaw("CHAT_LLM_IDLE_TIMEOUT_MS"));
  const totalMs = cenvParse("CHAT_LLM_STREAM_MAX_MS", source ? source.total : cenvRaw("CHAT_LLM_STREAM_MAX_MS"));
  return { idleMs, totalMs: Math.max(totalMs, idleMs) };
}

export type PartialReply = { content: string; reasoning: string };

/**
 * Why a stream stopped. "incomplete": it ended with no finish_reason /
 * [DONE] / message_stop; "malformed": a frame was not valid JSON
 * (lib/llmWireErrors.ts kinds, DeepSeek Harness D2).
 */
export type StreamStopKind = "idle" | "total" | "network" | "incomplete" | "malformed";

/** A stream that stopped before the model finished, with what it sent so far. */
export class ChatStreamError extends Error {
  readonly kind: StreamStopKind;
  partial: PartialReply;
  constructor(kind: StreamStopKind, message: string, partial: PartialReply = { content: "", reasoning: "" }) {
    super(message);
    this.name = "ChatStreamError";
    this.kind = kind;
    this.partial = partial;
  }
}

// "250ms" under a second, never "0s" (D2).
const seconds = (ms: number) => formatTimeoutLimit(ms);

export function idleStopMessage(idleMs: number): string {
  return `Reply stopped: the model went silent for ${seconds(idleMs)}`;
}

export function totalStopMessage(totalMs: number): string {
  return `Reply stopped: it ran past the ${seconds(totalMs)} limit for one reply`;
}

/**
 * Read one chunk, failing when nothing arrives within the idle window or
 * the total deadline passes first. The timer never outlives the read.
 */
export async function readWithLimits<T>(
  read: () => Promise<T>,
  limits: ChatStreamLimits,
  deadline: number,
  now: () => number = Date.now,
): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new ChatStreamError("total", totalStopMessage(limits.totalMs));
  const waitMs = Math.min(limits.idleMs, remaining);
  const kind: StreamStopKind = waitMs < limits.idleMs ? "total" : "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ChatStreamError(kind, kind === "idle" ? idleStopMessage(limits.idleMs) : totalStopMessage(limits.totalMs)),
        ),
      waitMs,
    );
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The partial text an error carries, if it is a cut stream with any. */
export function partialReplyOf(error: unknown): PartialReply | null {
  if (error instanceof ChatStreamError) return error.partial;
  const partial = (error as { partial?: unknown } | null)?.partial as Partial<PartialReply> | undefined;
  if (partial && typeof partial.content === "string") {
    return { content: partial.content, reasoning: typeof partial.reasoning === "string" ? partial.reasoning : "" };
  }
  return null;
}

/** Wrap any mid-stream failure so it carries the text sent so far. */
export function withPartial(error: unknown, partial: PartialReply): ChatStreamError {
  if (error instanceof ChatStreamError) {
    error.partial = partial;
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new ChatStreamError("network", `Reply stopped: the connection to the model failed (${reason})`, partial);
}
