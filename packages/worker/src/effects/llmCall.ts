import { Effect, Schedule } from "effect";
import type { LLMMessage, LLMProvider, LLMResult } from "@/llm";

/**
 * Whether an LLM call failure is worth retrying.
 * Transient: network errors, timeouts, HTTP 429 and 5xx.
 * Permanent: other HTTP 4xx (bad request, auth, not found) — retrying the
 * same payload cannot succeed. Errors carrying no HTTP status at all are
 * treated as transient (network failures and provider hiccups usually have
 * none), preserving the historical retry-everything behavior for them.
 */
export function isTransientLlmError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  // Some providers throw plain Errors with the status embedded in the
  // message, e.g. "LLM request failed (404): ...".
  if (typeof candidate.message === "string") {
    const embedded = candidate.message.match(/\((\d{3})\)/);
    if (embedded) {
      const code = Number(embedded[1]);
      return code === 429 || code >= 500;
    }
  }
  return true;
}

/**
 * Effect-based LLM call with retry + timeout.
 * Retry up to `retries` times with exponential backoff (500ms → 1s → 2s),
 * but only for transient failures (see isTransientLlmError); permanent 4xx
 * errors fail immediately. Total timeout 300s per attempt.
 */
export function llmCallEffect(
  provider: LLMProvider,
  messages: LLMMessage[],
  model?: string,
  options: { retries?: number; timeoutMs?: number } = {}
) {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 300_000;

  const callPromise = () =>
    provider.complete(messages, model).then((res) => res as LLMResult);

  return Effect.tryPromise({
    try: callPromise,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.retry({
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.upTo({ times: retries })
      ),
      while: (error) => isTransientLlmError(error),
    })
  );
}

/** Run the Effect and return a Promise (drop-in replacement for provider.complete). */
export function runLlmCall(
  provider: LLMProvider,
  messages: LLMMessage[],
  model?: string,
  options?: { retries?: number; timeoutMs?: number }
): Promise<LLMResult> {
  return Effect.runPromise(llmCallEffect(provider, messages, model, options));
}
