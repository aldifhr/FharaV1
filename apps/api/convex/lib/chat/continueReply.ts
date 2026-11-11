/**
 * Interrupted chat replies and "continue" (live test 2026-11-11).
 *
 * A reply that stops mid-stream (idle / total limit, network error) keeps
 * its text as the assistant message with a `cutOff` marker; so does a reply
 * the model ended at its output limit (finish_reason "length"). The next
 * user message "continue" (or the Continue button) streams the rest into
 * the SAME message: the history goes to the model with the partial reply as
 * the last assistant turn plus an instruction to go on from exactly where
 * it stopped, and the new text is appended without repeating the tail.
 *
 * Pure module (no Convex import): the chat action and its tests share it.
 */
import { partialReplyOf } from "./streamLimits";

export type CutOffKind = "interrupted" | "truncated";
export type CutOff = { kind: CutOffKind; reason: string };

export const TRUNCATED_REASON = "Reply stopped: the model reached its output limit";

/** Short continuation requests, in English and Indonesian (lowercase, no punctuation). */
const CONTINUE_RE =
  /^(?:(?:please|pls|ok|okay|oke|ya|yes|tolong)\s+)?(?:continue|go on|keep going|carry on|resume|lanjut|lanjutkan|lanjutin|terusin|teruskan|terus|sambung|sambungkan)(?:\s+(?:please|pls|dong|ya|aja|lagi|aj|deh|yang tadi|the reply|writing|from there))*$/u;

/** Is this user message a bare "continue" (no new request in it)? */
export function isContinueRequest(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 40) return false;
  return CONTINUE_RE.test(normalized);
}

/** How much of the partial reply's ending the instruction quotes. */
const TAIL_CHARS = 240;

export function continueInstruction(partial: string): string {
  const tail = partial.slice(-TAIL_CHARS);
  return [
    "Your previous reply was cut off before it finished.",
    "Continue it from exactly where it stopped: your output is appended directly after the last character above.",
    "Start with the very next characters (finish a cut word or table row first). Do not repeat any text already written, do not restart or summarize, and add no preamble or closing remark about continuing.",
    "",
    "It ended with:",
    '"""',
    `${tail.length < partial.length ? "…" : ""}${tail}`,
    '"""',
  ].join("\n");
}

type ChatMsg = { role: string; content: string };

/**
 * The prompt for a continuation: the conversation up to the cut reply's
 * request, the partial reply as the last assistant turn, then the
 * instruction. `prior` must end before the cut reply (it is added here).
 */
export function buildContinueMessages(prior: ChatMsg[], partial: string): ChatMsg[] {
  const head = prior.length > 0 && prior[0].role === "assistant" ? [{ role: "user", content: "(earlier conversation)" }, ...prior] : [...prior];
  if (head.length === 0) head.push({ role: "user", content: "(the request this reply answers is no longer in the history window)" });
  return [...head, { role: "assistant", content: partial }, { role: "user", content: continueInstruction(partial) }];
}

/** System prompt for a continuation turn: the agent's persona plus the rule. */
export function buildContinueSystem(agent: { name: string; role: string; systemPrompt?: string }, projectName?: string): string {
  return [
    `You are ${agent.name}, the ${agent.role}${projectName ? ` on the project "${projectName}"` : ""}.`,
    agent.systemPrompt?.trim() ?? "",
    "You are finishing your own reply that was cut off. Write only the missing rest of it, in the same language, format and voice.",
    "No tool calls, no [options] block.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Shortest overlap worth trimming (shorter matches are usually coincidence). */
const MIN_OVERLAP = 12;
const MAX_OVERLAP = 2000;

/**
 * Append the continuation to the partial reply. A model that repeats the
 * partial's tail anyway gets the repeated part trimmed.
 */
export function joinContinuation(partial: string, next: string): string {
  if (!next) return partial;
  const limit = Math.min(MAX_OVERLAP, partial.length, next.length);
  for (let k = limit; k >= MIN_OVERLAP; k -= 1) {
    if (partial.endsWith(next.slice(0, k))) return partial + next.slice(k);
  }
  // Trimmed-tail repeat: "…Each is always" + "Each is always shown…".
  const trimmedTail = partial.trimEnd();
  const lead = next.trimStart();
  for (let k = Math.min(MAX_OVERLAP, trimmedTail.length, lead.length); k >= MIN_OVERLAP; k -= 1) {
    if (trimmedTail.endsWith(lead.slice(0, k))) return trimmedTail + lead.slice(k);
  }
  return partial + next;
}

/**
 * The text a failed stream leaves to keep, cleaned by the caller's own
 * visible-text pipeline; "" when nothing worth keeping arrived.
 */
export function keptPartial(error: unknown, clean: (raw: string) => string): { content: string; reasoning: string } | null {
  const partial = partialReplyOf(error);
  if (!partial) return null;
  const content = clean(partial.content);
  return content.trim() ? { content, reasoning: partial.reasoning } : null;
}

/** The cut-off marker of a failed stream (its message is the user-facing reason). */
export function interruptedCutOff(error: unknown): CutOff {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const line = raw.split("\n")[0]?.trim() || "Reply stopped before it finished";
  return { kind: "interrupted", reason: line.slice(0, 300) };
}

/** History rows are oldest first; the latest is the user's continue message. */
export type ContinueHistoryRow = { authorType: string; content: string; messageId?: unknown };

/** History before the cut reply (the reply itself excluded), or all of it when the reply is older than the window. */
export function historyBefore<T extends ContinueHistoryRow>(history: T[], targetId: string): T[] {
  const index = history.findIndex((row) => String(row.messageId ?? "") === targetId);
  if (index >= 0) return history.slice(0, index);
  return [];
}

/** The chat line for a reply that failed before any text arrived. */
export function chatFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  if (message.startsWith("Reply stopped:")) return `${message.split("\n")[0]}, before any text arrived.`;
  return `I couldn't reply (${message}). Check global LLM settings.`;
}
