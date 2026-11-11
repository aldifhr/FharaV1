/**
 * Chat activity timeline (Feature 1): the pure pieces the chat action uses
 * to describe what an agent is doing while it answers.
 *
 * - `stripInternalPhrasing` removes planning shorthand that leaked into a
 *   reply in the e2e run ("Security — skipped: no auth change; add when:
 *   …"). It drops whole lines, so no dangling bullet is left behind.
 * - `intentLineFor` / `firstReasoningSentence` produce the one-sentence
 *   "Bekerja" line: the model's own first reasoning sentence when it is in
 *   the user's language and clean, else a line from the classifier intent.
 * - `toolStepFor` turns one tool call into the compact row stored on the
 *   message (`messages.toolSteps`).
 *
 * Pure: no Convex APIs, so it is unit-tested and importable from the web.
 */
import { isPromptEchoLine } from "./reasoningDisplay";
import type { IntentSubtype } from "./intent";
import { looksIndonesian, normalizeRepoToolArgs } from "./toolCallText";

export interface ChatToolStep {
  tool: string;
  target?: string;
  lines?: string;
  ok: boolean;
  at: number;
}

/** Steps kept per message (the timeline is a summary, not a log). */
export const MAX_TOOL_STEPS = 30;

/** A line carrying internal planning shorthand ("— skipped: …", "add when: …"). */
const INTERNAL_LINE = /(?:^|\s)[—–-]{1,2}\s*skipped:|\bskipped:\s.*\badd when:|\badd when:/i;

/** Remove lines with leaked internal phrasing; keeps everything else verbatim. */
export function stripInternalPhrasing(text: string): string {
  if (!text || !/skipped:|add when:/i.test(text)) return text;
  const kept = text.split("\n").filter((line) => !INTERNAL_LINE.test(line));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const INTENT_LINES: Record<"id" | "en", Partial<Record<IntentSubtype, string>> & { other: string; task: string }> = {
  id: {
    explanation: "Menelusuri kode yang relevan untuk menjelaskannya.",
    recommendation: "Menimbang pilihan untuk memberi rekomendasi.",
    research: "Meneliti pertanyaan ini.",
    audit: "Memeriksa bagian yang relevan untuk audit.",
    implementation: "Menyusun rencana perubahan.",
    debugging: "Mencari penyebab masalahnya.",
    testing: "Memeriksa cara mengujinya.",
    other: "Memahami permintaanmu.",
    task: "Menyusun rencana kerja.",
  },
  en: {
    explanation: "Tracing the relevant code to explain it.",
    recommendation: "Weighing the options to recommend one.",
    research: "Researching the question.",
    audit: "Checking the relevant parts for the audit.",
    implementation: "Drafting a plan for the change.",
    debugging: "Looking for the cause of the problem.",
    testing: "Checking how to test it.",
    other: "Working out what you need.",
    task: "Drafting a work plan.",
  },
};

/** The "Bekerja" line from the classifier intent, in the user's language. */
export function intentLineFor(intent: { intent: string; subtype?: IntentSubtype } | null | undefined, userText: string): string {
  const lang = looksIndonesian(userText) ? "id" : "en";
  const table = INTENT_LINES[lang];
  if (intent?.intent === "task" && (!intent.subtype || intent.subtype === "other")) return table.task;
  return (intent?.subtype && table[intent.subtype]) || table.other;
}

const UNSAFE_REASONING = /[{}<>`]|\btool\b|\bjson\b|system prompt|repo tools off|skipped:|add when:|\[tool result/i;

/**
 * First complete sentence of the model's reasoning, cleaned for display, or
 * null when it is unfinished, too short/long, internal-looking, or in a
 * different language than the user writes.
 */
export function firstReasoningSentence(reasoning: string | undefined, userText: string): string | null {
  const text = (reasoning ?? "").replace(/[*_#>]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match = text.match(/^(.{12,180}?[.!?])(\s|$)/);
  if (!match) return null;
  const sentence = match[1].trim();
  if (UNSAFE_REASONING.test(sentence) || isPromptEchoLine(sentence)) return null;
  if (looksIndonesian(sentence) !== looksIndonesian(userText)) return null;
  return stripInternalPhrasing(sentence) || null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Compact timeline row for one tool call (target clipped; read range as "a–b"). */
export function toolStepFor(call: { tool: string; args?: Record<string, unknown> }, ok: boolean, at: number): ChatToolStep {
  const a = normalizeRepoToolArgs(call.args ?? {}) as Record<string, unknown>;
  const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  let target = "";
  let lines: string | undefined;
  switch (call.tool) {
    case "read_file": {
      target = str(a.path);
      const start = Number(a.start);
      const count = Number(a.lines);
      if (Number.isFinite(start) && start > 0) {
        lines = Number.isFinite(count) && count > 0 ? `${start}–${start + count - 1}` : `${start}`;
      }
      break;
    }
    case "grep":
      target = str(a.pattern);
      break;
    case "list_files":
      target = str(a.path) || ".";
      break;
    case "load_skill":
      target = str(a.name) || str(a.skill);
      break;
    default:
      target = str(a.role) || str(a.target);
  }
  return { tool: call.tool, ...(target ? { target: clip(target) } : {}), ...(lines ? { lines } : {}), ok, at };
}
