export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * True when the provider reported no usage and the token counts were
   * estimated (chars/4) by runLlmCallWithFallback. Recorded as
   * `estimated` on the tokenUsage row and shown as "≈" in the UI.
   */
  usageEstimated?: boolean;
  /**
   * Usage breakdown (plan 040 P3), set only when the provider returned it.
   * `inputTokens` counts every prompt token (cache included) and
   * `outputTokens` every output token (reasoning included); these are
   * subsets. See llm/usage.ts for the verified provider field names.
   */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Wall time of the call that served this result (set by runLlmCallWithFallback). */
  durationMs?: number;
  /** Time to the first streamed text delta (D5); absent on non-streamed calls. */
  ttftMs?: number;
  /**
   * Why the model stopped, as the provider reported it (OpenAI
   * `finish_reason`; Anthropic `stop_reason` "max_tokens" is mapped to
   * "length"). "length" means the answer was cut at the output cap.
   */
  finishReason?: string;
}

/**
 * Per-call usage attribution (Phase 5): which provider connection and
 * registry model actually served a call, and its estimated cost. Fields
 * are absent — never guessed — when the serving handle has no registry
 * identity (env fallback) or no pricing.
 */
export interface TokenUsageMeta {
  providerId?: string;
  modelRowId?: string;
  estimatedCost?: number;
  /** Token counts are a chars/4 estimate (the provider reported no usage). */
  estimated?: boolean;
  /** Plan 040 P3 ledger fields; each absent when unknown. */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  /** Wire kind that served the call: "anthropic", "openai-compatible", "opencode", … */
  providerKind?: string;
  /** planner / decision / executor / reviewer / qa / …, from the snapshot scope. */
  callRole?: string;
}

/**
 * Task-level usage sink (planner, decision advisor, runner): feeds the
 * budget tracker and the persisted tokenUsage table.
 */
export type TokenUsageFn = (
  inputTokens: number,
  outputTokens: number,
  model: string,
  agentName: string,
  agentId?: string,
  meta?: TokenUsageMeta
) => Promise<void>;

/** Subtask-level usage sink: the executor reports its own agent's calls. */
export type SubtaskTokenUsageFn = (
  inputTokens: number,
  outputTokens: number,
  model: string,
  meta?: TokenUsageMeta
) => Promise<void>;
