import { isSystemLine } from "@/api/convex/lib/systemLine";

export const PROMPT_TAIL = 12;
/** R10: the first messages (the task statement) are kept verbatim, never summarised. */
export const KEEP_FIRST = 2;

export interface HistoryMessage {
  authorType: "user" | "agent" | string;
  content: string;
  /** "system" = a System status line (lib/systemLine.ts): never model input. */
  voice?: string;
}

/** The one System-line rule, shared with the chat transcript (buildChatMessages). */
const modelRows = (messages: HistoryMessage[]) => messages.filter((m) => !isSystemLine(m));

export function buildSummaryPrompt(all: HistoryMessage[]): string {
  const messages = modelRows(all);
  const head = messages.slice(0, Math.min(KEEP_FIRST, Math.max(0, messages.length - PROMPT_TAIL)));
  const tail = messages.slice(-PROMPT_TAIL);
  const older = messages.slice(head.length, -PROMPT_TAIL);
  const render = (list: HistoryMessage[]) =>
    list.map((m) => `${m.authorType === "agent" ? "agent" : "user"}: ${m.content}`).join("\n");
  return [
    "Summarize the earlier conversation concisely. Keep only durable facts, decisions, and open questions.",
    ...(head.length > 0
      ? ["Opening messages (kept verbatim elsewhere; do not summarize, context only):", render(head)]
      : []),
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
  const tail = modelRows(input.history).slice(-PROMPT_TAIL);
  const parts: string[] = [];
  if (input.summary) parts.push(`Conversation summary: ${input.summary}`);
  parts.push("Recent conversation:");
  for (const m of tail) {
    parts.push(`${m.authorType === "agent" ? "agent" : "user"}: ${m.content}`);
  }
  return parts.join("\n");
}
