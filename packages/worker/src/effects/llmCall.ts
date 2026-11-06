import { Effect, Schedule } from "effect";
import type { LLMMessage, LLMProvider, LLMResult } from "@/llm";

/**
 * Effect-based LLM call with retry + timeout.
 * Retry 3x with exponential backoff (500ms → 1s → 2s), total timeout 300s per attempt.
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
    Effect.retry(
      Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: retries }))
    )
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
