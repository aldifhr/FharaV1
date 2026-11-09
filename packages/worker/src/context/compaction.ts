/**
 * Plan 006 Phase 3 — context compaction.
 *
 * Deterministic trigger (history > 40 messages OR > 24k chars) decides when
 * to compact. The summary LLM call is budget-gated via `assertBudgetForCall`
 * before any request; the caller persists the summary row via the worker API.
 * The prompt builder carries summary + last 12, replacing the raw last-12
 * history in the router path (chatContext.ts:89-93).
 */

import { buildSummaryPrompt, type HistoryMessage } from "@/prompts/compaction";

export const COMPACT_MESSAGE_THRESHOLD = 40;
export const COMPACT_CHAR_THRESHOLD = 24_000;

// Prompt text lives in `@/prompts/compaction`; re-exported for existing importers.
export {
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

export function shouldCompact(messages: HistoryMessage[]): boolean {
  return (
    messageCount(messages) > COMPACT_MESSAGE_THRESHOLD ||
    charCount(messages) > COMPACT_CHAR_THRESHOLD
  );
}

export async function compactIfNeeded(input: {
  history: HistoryMessage[];
  assertBudgetForCall?: () => void;
  summarize: (prompt: string) => Promise<string>;
}): Promise<{ compacted: boolean; summary?: string }> {
  if (!shouldCompact(input.history)) return { compacted: false };
  input.assertBudgetForCall?.();
  const prompt = buildSummaryPrompt(input.history);
  const summary = await input.summarize(prompt);
  return { compacted: true, summary };
}
