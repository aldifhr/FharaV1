export const PROMPT_TAIL = 12;

export interface HistoryMessage {
  authorType: "user" | "agent" | string;
  content: string;
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
