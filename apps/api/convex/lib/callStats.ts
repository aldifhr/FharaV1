/**
 * Per-call stats on a Context Snapshot (D5): prompt-cache reads and time to
 * first token, plus the pure math the Context Inspector shows (cache hit %,
 * tokens/s). Validators live here because schema.ts is at its line budget.
 *
 * Conventions follow the usage ledger (packages/worker/src/llm/usage.ts):
 * `cachedInputTokens` is a subset of `inputTokens`; both absent when the
 * provider did not report them. `ttftMs` is set only on streamed calls.
 */
import { v } from "convex/values";

/** One section's size in a snapshot (shared by the table and the record args). */
export const sectionStatValidator = v.object({
  key: v.string(),
  label: v.string(),
  chars: v.number(),
  tokens: v.number(),
  truncated: v.optional(v.boolean()),
});

/** Additive optional fields on `contextSnapshots` and its record meta. */
export const snapshotCallStatsFields = {
  cachedInputTokens: v.optional(v.number()),
  ttftMs: v.optional(v.number()),
};

export interface CallStatsInput {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  usageEstimated?: boolean;
  durationMs?: number;
  ttftMs?: number;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Share of the prompt served from the provider's cache, whole percent.
 * Undefined when the provider reported no cache field or the input count is
 * an estimate (a ratio of a guess is not a hit rate).
 */
export function cacheHitPercent(s: CallStatsInput): number | undefined {
  if (s.usageEstimated || !finite(s.cachedInputTokens) || !finite(s.inputTokens) || s.inputTokens <= 0) return undefined;
  return Math.round((Math.min(s.cachedInputTokens, s.inputTokens) / s.inputTokens) * 100);
}

/**
 * Output tokens per second over the generation window (after the first
 * token when TTFT is known, else the whole call). Undefined for estimated
 * usage or a window under 1 ms.
 */
export function tokensPerSecond(s: CallStatsInput): number | undefined {
  if (s.usageEstimated || !finite(s.outputTokens) || !finite(s.durationMs)) return undefined;
  const window = s.durationMs - (finite(s.ttftMs) && s.ttftMs < s.durationMs ? s.ttftMs : 0);
  if (window < 1) return undefined;
  return Math.round((s.outputTokens / window) * 1000 * 10) / 10;
}

/** Uncached prompt tokens (what a cache miss costs), when cache data exists. */
export function uncachedInputTokens(s: CallStatsInput): number | undefined {
  if (!finite(s.cachedInputTokens) || !finite(s.inputTokens)) return undefined;
  return Math.max(0, s.inputTokens - s.cachedInputTokens);
}
