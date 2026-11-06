import { Effect, Schedule } from "effect";
import type { GlobalLLMConfig, LLMMessage, LLMProvider, LLMResult } from "@/llm";
import type { ProviderHealthRegistry } from "@/llm/health";

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
  options: { retries?: number; timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 300_000;

  const callPromise = () =>
    provider.complete(messages, model, { signal: options.signal }).then((res) => res as LLMResult);

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
  options?: { retries?: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<LLMResult> {
  return Effect.runPromise(llmCallEffect(provider, messages, model, options));
}

/** One stop in an agent's provider chain (structurally = resolver's ResolvedProviderHandle). */
export interface FallbackHandle {
  connectionId: string;
  connectionName: string;
  config: GlobalLLMConfig;
  provider: LLMProvider;
}

/**
 * Call an LLM through an ordered provider chain with in-task fallback
 * (spec §4D): each handle gets the normal local retry policy first; when a
 * handle fails TRANSIENTLY and its local retries are exhausted, the next
 * handle in the chain serves the SAME call within the same task. Permanent
 * errors (4xx) never trigger fallback — retrying the same payload against
 * another provider would fail the same way and hide the real problem.
 *
 * Every outcome is recorded into the health registry: successes close the
 * circuit, transient failures count toward opening it.
 */
export async function runLlmCallWithFallback(
  handles: FallbackHandle[],
  messages: LLMMessage[],
  options: {
    health?: ProviderHealthRegistry;
    retries?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ result: LLMResult; servedBy: FallbackHandle }> {
  if (handles.length === 0) {
    throw new Error("No LLM provider handles available for this call");
  }
  let lastError: unknown;
  for (const handle of handles) {
    try {
      const result = await runLlmCall(handle.provider, messages, handle.config.model, {
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      options.health?.recordSuccess(handle.connectionId);
      return { result, servedBy: handle };
    } catch (error) {
      lastError = error;
      if (!isTransientLlmError(error)) throw error;
      options.health?.recordFailure(handle.connectionId, { transient: true });
      // Transient and retries exhausted on this handle: fall through to
      // the next candidate in the chain (same task, same call).
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${handles.length} LLM providers in the fallback chain failed`);
}
