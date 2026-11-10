/**
 * Plan 006 Phase 3 — context compaction.
 *
 * Deterministic trigger (history > 40 messages OR > 24k chars) decides when
 * to compact. The summary LLM call is budget-gated via `assertBudgetForCall`
 * before any request; the caller persists the summary row via the worker API.
 * The prompt builder carries summary + last 12, replacing the raw last-12
 * history in the router path (chatContext.ts:89-93).
 *
 * R10 additions: an `isOverflow` trigger beside the message/char rule
 * (ported from opencode v1.0.0 session/compaction.ts `isOverflow`, MIT,
 * Copyright (c) 2025 opencode; modified by Fhara: plain numbers instead of
 * opencode's model and token records), and the first `KEEP_FIRST` messages
 * (the task statement) are never summarised, like OpenHands'
 * LLMSummarizingCondenser `keep_first` (pattern only).
 */

import { buildSummaryPrompt, KEEP_FIRST, type HistoryMessage } from "@/prompts/compaction";

export const COMPACT_MESSAGE_THRESHOLD = 40;
export const COMPACT_CHAR_THRESHOLD = 24_000;

// Prompt text lives in `@/prompts/compaction`; re-exported for existing importers.
export {
  KEEP_FIRST,
  PROMPT_TAIL,
  buildSummaryPrompt,
  buildTaskPrompt,
  buildChatPrompt,
  type HistoryMessage,
} from "@/prompts/compaction";

export function messageCount(messages: HistoryMessage[]): number {
  return messages.length;
}

export function charCount(messages: HistoryMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

/** opencode's cap on the output reserve when the model reports none. */
export const OUTPUT_TOKEN_MAX = 32_000;

/**
 * opencode `isOverflow`: the last call's tokens (input + cache read +
 * output) exceed the model context minus the output reserve. A context of
 * 0 (unknown) never overflows.
 */
export function isOverflow(input: {
  tokens: { input: number; output: number; cacheRead?: number };
  model: { context: number; output?: number };
}): boolean {
  const context = input.model.context;
  if (!context) return false;
  const count = input.tokens.input + (input.tokens.cacheRead ?? 0) + input.tokens.output;
  const output = Math.min(input.model.output ?? OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
  return count > context - output;
}

export function shouldCompact(
  messages: HistoryMessage[],
  usage?: Parameters<typeof isOverflow>[0]
): boolean {
  return (
    messageCount(messages) > COMPACT_MESSAGE_THRESHOLD ||
    charCount(messages) > COMPACT_CHAR_THRESHOLD ||
    (usage !== undefined && isOverflow(usage))
  );
}

export async function compactIfNeeded(input: {
  history: HistoryMessage[];
  assertBudgetForCall?: () => void;
  summarize: (prompt: string) => Promise<string>;
  /** Last call's usage and the model limits, for the overflow trigger. */
  usage?: Parameters<typeof isOverflow>[0];
}): Promise<{ compacted: boolean; summary?: string; kept?: HistoryMessage[] }> {
  if (!shouldCompact(input.history, input.usage)) return { compacted: false };
  input.assertBudgetForCall?.();
  const prompt = buildSummaryPrompt(input.history);
  const summary = await input.summarize(prompt);
  // The head is carried verbatim, never through the summary.
  return { compacted: true, summary, kept: input.history.slice(0, KEEP_FIRST) };
}
