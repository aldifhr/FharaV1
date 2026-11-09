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
