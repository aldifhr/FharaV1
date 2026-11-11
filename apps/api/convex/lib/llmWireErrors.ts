/**
 * Wording rules for LLM wire failures, shared by the worker's LLM client
 * and the backend's LLM pool (pure module, no Convex import).
 *
 * Context overflow wordings (DeepSeek Harness D2, pattern only, MIT,
 * Copyright (c) 2026 DeepSeek): OpenAI `context_length_exceeded` /
 * "maximum context length", DeepSeek "maximum context length", Anthropic
 * "prompt is too long", plus the common gateway phrasings.
 *
 * Typed wire failures (the "classify the fault, never guess from a bare
 * word" rule of DeepSeek Harness's defensive-patterns docs, pattern only):
 *
 *   connection        the socket dropped before or during the reply
 *                     (undici's bare "terminated"): retryable
 *   malformed         a frame or body that is not valid JSON: retryable
 *   incomplete        a stream that ended with no finish_reason and no
 *                     [DONE] (or no message_stop): retryable; carries the
 *                     partial text so a chat can keep it as interrupted.
 *                     Never a completed answer.
 *   context_overflow  the request is longer than the model's context
 *                     window: neither transient nor permanent; the caller
 *                     shrinks the request and retries the same call
 *
 * A class keeps an "(NNN)" status in its message only when the provider
 * sent one, so the status-based classifiers keep working.
 */

const CONTEXT_OVERFLOW_TEXT =
  /context_length_exceeded|maximum context length|prompt is too long|context window|context length (?:is |of )?exceeded|exceeds? the (?:model'?s? )?(?:maximum )?context|too many tokens in (?:the )?(?:prompt|request|messages)|input is too long|reduce the length of the messages/i;

/** Whether an error text says the request is longer than the model's context window. */
export function isContextOverflowText(text: string | undefined | null): boolean {
  return typeof text === "string" && CONTEXT_OVERFLOW_TEXT.test(text);
}

/**
 * The model's context limit (tokens) named in an overflow text, when the
 * provider gives it: "maximum context length is 65536 tokens",
 * "214031 tokens > 200000 maximum".
 */
export function contextLimitFromText(text: string | undefined | null): number | undefined {
  if (typeof text !== "string") return undefined;
  const named = /maximum context length is (\d[\d,]*)/i.exec(text) ?? /> ?(\d[\d,]*) maximum/i.exec(text) ?? /context window (?:of|is) (\d[\d,]*)/i.exec(text);
  if (!named) return undefined;
  const value = Number(named[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A timeout limit as people read it: "250ms" under a second, else seconds
 * with at most one decimal ("1.5s", "300s"). Never "0s".
 */
export function formatTimeoutLimit(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

export type LlmWireErrorKind = "connection" | "malformed" | "incomplete" | "context_overflow";

export class LlmWireError extends Error {
  readonly kind: LlmWireErrorKind;
  /** HTTP status the provider answered with, when there was one. */
  readonly status?: number;
  constructor(kind: LlmWireErrorKind, message: string, options: { cause?: unknown; status?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmWireError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** The connection dropped mid-request; `partial` is the text that arrived before it. */
export class LlmConnectionError extends LlmWireError {
  readonly partial: string;
  readonly code = "ECONNRESET";
  constructor(message: string, options: { cause?: unknown; partial?: string } = {}) {
    super("connection", message, options);
    this.name = "LlmConnectionError";
    this.partial = options.partial ?? "";
  }
}

export class LlmMalformedResponseError extends LlmWireError {
  readonly partial: string;
  constructor(message: string, options: { cause?: unknown; partial?: string } = {}) {
    super("malformed", message, options);
    this.name = "LlmMalformedResponseError";
    this.partial = options.partial ?? "";
  }
}

/**
 * A reply cut short: the stream ended cleanly but without a finish_reason
 * or [DONE]. `partial` is what arrived. Chat persistence keeps it as an
 * interrupted reply; it is never a completed answer.
 */
export class LlmIncompleteResponseError extends LlmWireError {
  readonly partial: string;
  /** Reasoning text that arrived before the cut (chat streams), "" when none. */
  readonly partialReasoning: string;
  constructor(message: string, options: { partial: string; partialReasoning?: string; cause?: unknown }) {
    super("incomplete", message, options);
    this.name = "LlmIncompleteResponseError";
    this.partial = options.partial;
    this.partialReasoning = options.partialReasoning ?? "";
  }
}

export class LlmContextOverflowError extends LlmWireError {
  /** The model's context limit in tokens, when the provider named it. */
  readonly contextLimit?: number;
  constructor(message: string, options: { status?: number; cause?: unknown; contextLimit?: number } = {}) {
    super("context_overflow", message, options);
    this.name = "LlmContextOverflowError";
    if (options.contextLimit !== undefined) this.contextLimit = options.contextLimit;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return typeof error === "string" ? error : "";
}

function kindOf(error: unknown): LlmWireErrorKind | undefined {
  if (!error || typeof error !== "object") return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return kind === "connection" || kind === "malformed" || kind === "incomplete" || kind === "context_overflow" ? kind : undefined;
}

/** Whether `error` is (or reads as) a context-window overflow. */
export function isContextOverflowError(error: unknown): boolean {
  const kind = kindOf(error);
  if (kind) return kind === "context_overflow";
  return isContextOverflowText(messageOf(error));
}

/**
 * Whether `error` is a reply cut short (no finish_reason / [DONE]): the
 * worker's LlmIncompleteResponseError or the chat client's ChatStreamError
 * of kind "incomplete". Read the text with `partialTextOf`.
 */
export function isIncompleteResponseError(error: unknown): boolean {
  return kindOf(error) === "incomplete";
}

/** The text that arrived before a connection drop, malformed frame or early end ("" when none). */
export function partialTextOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const partial = (error as { partial?: unknown }).partial;
  if (typeof partial === "string") return partial;
  // The chat client's ChatStreamError carries { content, reasoning }.
  const content = (partial as { content?: unknown } | null | undefined)?.content;
  return typeof content === "string" ? content : "";
}

/** The model's context limit an overflow error names, when it names one. */
export function contextLimitOf(error: unknown): number | undefined {
  if (error instanceof LlmContextOverflowError && error.contextLimit !== undefined) return error.contextLimit;
  return contextLimitFromText(messageOf(error));
}

/**
 * undici reports a body cut mid-read as a bare TypeError "terminated"
 * (cause UND_ERR_SOCKET "other side closed"). That word means nothing to
 * a reader, and no classifier recognises it: return a connection error
 * naming what happened, or `undefined` when `error` is something else
 * ("fetch failed" already reads as a connection failure and is kept).
 */
export function asDroppedConnection(error: unknown, where: string, partial = ""): LlmConnectionError | undefined {
  if (!(error instanceof Error) || error.message !== "terminated") return undefined;
  const cause = (error as { cause?: { message?: unknown } }).cause;
  const detail = typeof cause?.message === "string" && cause.message ? ` (${cause.message})` : "";
  const stage = partial ? "mid-reply" : "before the reply finished";
  return new LlmConnectionError(`LLM connection closed ${stage}${detail} at ${where}`, { cause: error, partial });
}
