/**
 * Provider usage → the normalized per-call ledger shape (plan 040 P3).
 *
 * Ledger convention (every provider):
 * - `inputTokens`  = ALL prompt tokens, cache reads and cache writes included.
 * - `outputTokens` = ALL output tokens, reasoning included (the billed total).
 * - `cachedInputTokens` / `cacheWriteTokens` are subsets of `inputTokens`;
 *   `reasoningTokens` is a subset of `outputTokens`.
 * A breakdown field is set only when the provider actually returned it.
 *
 * Field names verified against (2026-11-10):
 * - OpenAI chat completions `CompletionUsage` (openai-node
 *   src/resources/completions.ts): `prompt_tokens`, `completion_tokens`,
 *   `prompt_tokens_details.cached_tokens`,
 *   `prompt_tokens_details.cache_write_tokens`,
 *   `completion_tokens_details.reasoning_tokens`. `prompt_tokens` includes
 *   the cached tokens; `completion_tokens` includes reasoning.
 * - Anthropic `Usage` / `MessageDeltaUsage` (@anthropic-ai/sdk 1.5.0
 *   resources/messages/messages.d.ts): `input_tokens`, `output_tokens`,
 *   `cache_read_input_tokens`, `cache_creation_input_tokens`,
 *   `output_tokens_details.thinking_tokens`. Anthropic's `input_tokens`
 *   EXCLUDES the cache: total input = input + cache_creation + cache_read.
 * - DeepSeek `prompt_cache_hit_tokens` is read only as a fallback when
 *   `prompt_tokens_details.cached_tokens` is absent (not re-verified).
 */
import type { LLMResult } from "@/types/llm";

export type UsageBreakdown = Pick<
  LLMResult,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens"
>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Drop undefined keys so spreading never overwrites a known value. */
function compact(usage: UsageBreakdown): UsageBreakdown {
  const out: UsageBreakdown = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) (out as Record<string, number>)[key] = value as number;
  }
  return out;
}

/** OpenAI / OpenAI-compatible `usage` object (null/absent → {}). */
export function normalizeOpenAiUsage(raw: unknown): UsageBreakdown {
  const usage = record(raw);
  if (!usage) return {};
  const prompt = record(usage.prompt_tokens_details);
  const completion = record(usage.completion_tokens_details);
  return compact({
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    cachedInputTokens: count(prompt?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens),
    cacheWriteTokens: count(prompt?.cache_write_tokens),
    reasoningTokens: count(completion?.reasoning_tokens),
  });
}

/**
 * Anthropic `usage` (message, message_start or message_delta). Input is
 * reported as the ledger total (uncached + cache read + cache write) only
 * when `input_tokens` is present.
 */
export function normalizeAnthropicUsage(raw: unknown): UsageBreakdown {
  const usage = record(raw);
  if (!usage) return {};
  const base = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const details = record(usage.output_tokens_details);
  return compact({
    inputTokens: base === undefined ? undefined : base + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: count(usage.output_tokens),
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: count(details?.thinking_tokens),
  });
}

/**
 * Merge raw usage objects from successive stream events: a later event's
 * non-null field wins (Anthropic message_delta counts are cumulative, and
 * its cache fields may be null). Normalize the merged object once.
 */
export function mergeRawUsage(
  previous: Record<string, unknown> | undefined,
  next: unknown
): Record<string, unknown> | undefined {
  const add = record(next);
  if (!add) return previous;
  const out: Record<string, unknown> = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(add)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}
