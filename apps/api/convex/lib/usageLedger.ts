/**
 * Per-call usage ledger (plan 040 P3): the optional tokenUsage fields, and
 * the provider-usage normalizer for the backend chat client.
 *
 * Ledger convention (every provider, worker and chat alike):
 * - `inputTokens`  = ALL prompt tokens, cache reads and writes included.
 * - `outputTokens` = ALL output tokens, reasoning included.
 * - `cachedInputTokens` / `cacheWriteTokens` ⊂ inputTokens,
 *   `reasoningTokens` ⊂ outputTokens; each set only when reported.
 *
 * Provider field names verified 2026-11-10 against openai-node
 * `CompletionUsage` (prompt_tokens_details.cached_tokens / cache_write_tokens,
 * completion_tokens_details.reasoning_tokens; prompt_tokens includes cached)
 * and @anthropic-ai/sdk 1.5.0 `Usage` / `MessageDeltaUsage`
 * (cache_read_input_tokens, cache_creation_input_tokens,
 * output_tokens_details.thinking_tokens; input_tokens EXCLUDES the cache).
 * Same rules as the worker's packages/worker/src/llm/usage.ts.
 */
import { v } from "convex/values";

/** Optional tokenUsage columns added by plan 040 P3 (schema + mutation args). */
export const usageLedgerFields = {
  /** Prompt tokens served from the provider cache (subset of inputTokens). */
  cachedInputTokens: v.optional(v.number()),
  /** Prompt tokens written to the cache (Anthropic cache creation). */
  cacheWriteTokens: v.optional(v.number()),
  /** Reasoning / thinking tokens (subset of outputTokens). */
  reasoningTokens: v.optional(v.number()),
  /** Wall time of the call that served the answer. */
  durationMs: v.optional(v.number()),
  /** Wire kind: "anthropic", "openai-compatible", "opencode", … */
  providerKind: v.optional(v.string()),
  /** planner / decision / executor / reviewer / qa / chat / chat_tool_step / … */
  callRole: v.optional(v.string()),
  /** Which process recorded the row: "worker" or "chat" (absent on older rows). */
  source: v.optional(v.string()),
};

export interface UsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact(usage: UsageBreakdown): UsageBreakdown {
  const out: UsageBreakdown = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) (out as Record<string, number>)[key] = value as number;
  }
  return out;
}

/** OpenAI / OpenAI-compatible `usage`. DeepSeek `prompt_cache_hit_tokens` is a fallback only (not re-verified). */
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

/** Anthropic `usage` (message / message_start / merged stream usage). */
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

/** Merge raw stream usage objects: a later non-null field wins. */
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

/**
 * Estimated cost from registry pricing (per 1k tokens). Undefined unless
 * BOTH sides are priced, like the worker's estimateUsageCost.
 */
export function estimateCostFromPricing(
  pricing: { inputPricePer1k?: number | null; outputPricePer1k?: number | null } | null | undefined,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  const inPrice = pricing?.inputPricePer1k;
  const outPrice = pricing?.outputPricePer1k;
  if (typeof inPrice !== "number" || typeof outPrice !== "number") return undefined;
  return (Math.max(0, inputTokens) / 1000) * inPrice + (Math.max(0, outputTokens) / 1000) * outPrice;
}
