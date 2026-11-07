/**
 * Plan 006 Phase 3 — context compaction.
 *
 * Deterministic trigger (history > 40 messages OR > 24k chars) decides when
 * to compact. The summary LLM call is budget-gated via `assertBudgetForCall`
 * before any request; the caller persists the summary row via the worker API.
 * The prompt builder carries summary + last 12, replacing the raw last-12
 * history in the router path (chatContext.ts:89-93).
 */

export const COMPACT_MESSAGE_THRESHOLD = 40;
export const COMPACT_CHAR_THRESHOLD = 24_000;
export const PROMPT_TAIL = 12;

export interface HistoryMessage {
  authorType: "user" | "agent" | string;
  content: string;
}

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

export function buildSummaryPrompt(messages: HistoryMessage[]): string {
  const tail = messages.slice(-PROMPT_TAIL);
  const older = messages.slice(0, -PROMPT_TAIL);
  const render = (list: HistoryMessage[]) =>
    list.map((m) => `${m.authorType === "agent" ? "agent" : "user"}: ${m.content}`).join("\n");
  return [
    "Summarize the earlier conversation concisely. Keep only durable facts, decisions, and open questions.",
    "Earlier conversation:",
    older.length > 0 ? render(older) : "(no earlier messages)",
    "Recent tail (do not summarize, context only):",
    render(tail),
  ].join("\n");
}

/**
 * Totally isolates contexts: the task prompt carries only curated task
 * context; the chat prompt carries only chat history (never decision
 * payloads). Exported for `contextScope.test.ts`.
 */
export function buildTaskPrompt(input: {
  assignment: string;
  curatedContext: string;
}): string {
  return [`Task assignment: ${input.assignment}`, "", input.curatedContext]
    .filter(Boolean)
    .join("\n");
}

export function buildChatPrompt(input: {
  history: HistoryMessage[];
  summary?: string;
}): string {
  const tail = input.history.slice(-PROMPT_TAIL);
  const parts: string[] = [];
  if (input.summary) parts.push(`Conversation summary: ${input.summary}`);
  parts.push("Recent conversation:");
  for (const m of tail) {
    parts.push(`${m.authorType === "agent" ? "agent" : "user"}: ${m.content}`);
  }
  return parts.join("\n");
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
