/**
 * Native questions in direct (ACP) threads (plan N7).
 *
 * OpenCode's own `question` tool is allowed to ask (vendor/threadbear/acp/
 * agents.ts). Its permission request never runs the tool: the session
 * turns it into a question card (`approval.requested {kind: "question",
 * options}`, written by the store), answers the request `cancelled`, and
 * notes that the question was answered in chat. The agent was told in the
 * preamble to end its turn after asking; the answer arrives as the next
 * `user.message`, from the user, or from the CTO's decision turn when the
 * question is technical and inside the CTO's ceiling (G13,
 * apps/api/convex/lib/questionPolicy.ts). Secrets, push and destructive
 * questions always reach the user: the backend routes, not the worker.
 */
import { isPlainObject } from "@/vendor/threadbear/acp/normalize";

/** One question as the card shows it. */
export interface NativeQuestion {
  question: string;
  /** Option labels (at most 6), in the agent's order. */
  options: string[];
  /** The agent allows more than one option. */
  multiple?: boolean;
}

/** The session's request to the runner. */
export interface QuestionAskCall extends NativeQuestion {
  itemId: string;
}

/** Who answers: the user (the card), or the CTO's decision turn. */
export interface QuestionRouted {
  route: "user" | "cto";
  questionId: string;
  reason: string;
}

export const QUESTION_TEXT_MAX = 2000;
const OPTION_MAX = 200;
const OPTIONS_MAX = 6;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function optionLabel(o: unknown): string {
  if (typeof o === "string") return o.trim();
  if (isPlainObject(o)) return str(o.label) || str(o.value) || str(o.name);
  return "";
}

/** True when a tool call is OpenCode's question tool (by its name, or its input's shape). */
export function isQuestionCall(call: { title?: string; name?: string; rawInput?: Record<string, unknown> }): boolean {
  const names = [call.title, call.name].map((n) => str(n).toLowerCase());
  if (names.includes("question")) return true;
  return Array.isArray(call.rawInput?.questions) && call.rawInput!.questions.length > 0;
}

/**
 * The question a call asks, or null when it isn't one or says nothing.
 * OpenCode's input: `{questions: [{question, header, options: [{label,
 * description}], multiple}]}`. Several questions become one card: each on
 * its own line; options only when there is a single question.
 */
export function questionFromToolCall(call: { title?: string; name?: string; rawInput?: Record<string, unknown> }): NativeQuestion | null {
  if (!isQuestionCall(call)) return null;
  const raw = call.rawInput ?? {};
  const list = Array.isArray(raw.questions) ? raw.questions.filter(isPlainObject) : str(raw.question) ? [raw] : [];
  const items = list
    .map((q) => ({
      text: str(q.question),
      header: str(q.header),
      options: (Array.isArray(q.options) ? q.options : []).map(optionLabel).filter(Boolean),
      multiple: q.multiple === true,
    }))
    .filter((q) => q.text);
  if (!items.length) return null;
  if (items.length === 1) {
    const [q] = items;
    const options = [...new Set(q.options.map((o) => o.slice(0, OPTION_MAX)))].slice(0, OPTIONS_MAX);
    return { question: q.text.slice(0, QUESTION_TEXT_MAX), options, ...(q.multiple ? { multiple: true } : {}) };
  }
  const text = items
    .map((q, i) => `${i + 1}. ${q.header ? `${q.header}: ` : ""}${q.text}${q.options.length ? ` (${q.options.join(" / ")})` : ""}`)
    .join("\n");
  return { question: text.slice(0, QUESTION_TEXT_MAX), options: [] };
}

/** What the transcript says once the call was answered cancelled. */
export function answeredInChatNote(route: QuestionRouted["route"]): string {
  return route === "cto"
    ? "The question went to the CTO; the tool call was answered in chat (cancelled), and the answer arrives as the next message."
    : "The question is shown to the user; the tool call was answered in chat (cancelled), and the answer arrives as the next message.";
}

/** Said once in the preamble of every new ACP session. */
export const QUESTION_PREAMBLE =
  "When you need a decision from the user, ask it with the question tool and then end your turn at once. The call comes back cancelled because the question is answered in the chat: the answer arrives as the next message. Don't guess the answer and don't ask the same question again in that turn.";
