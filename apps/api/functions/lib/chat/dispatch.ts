/**
 * Chat routing helpers that are NOT language classification: deterministic
 * timing rules, copy and code-target detection. Owner selection comes from
 * the validated structured classifier (lib/chat/routingClassification.ts);
 * no domain/role regex table is used to guess what a message means.
 */
import { isSystemLine } from "../systemLine";
import { backendWordPattern } from "../backendDomain";
import type { RoutingKind } from "./routingClassification";

export type DispatchDomain = RoutingKind | null;

type HistoryRow = { authorType: string; content: string; agentId?: string; voice?: string };

/**
 * Whether a chat message goes through the deterministic pre-route at all.
 * Chat is everything without an explicit task trigger (Create task button,
 * /task, a leading kerjakan/jalankan/eksekusi, a go reply to a CTO offer).
 */
export function chatPreRouteAllowed(input: {
  text: string;
  intent: { intent: string; subtype: string };
  optionPick: boolean;
  pasted: boolean;
  workShaped: boolean;
  runRequest: boolean;
}): boolean {
  if (input.optionPick || input.pasted || input.workShaped || input.runRequest) return false;
  if (input.intent.intent === "task" && input.intent.subtype === "implementation") return false;
  return input.intent.intent === "ask" || input.intent.intent === "task";
}

const CODE_PATH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|css|scss|json|md|ya?ml|sql))(?=$|[\s`'"),.:;!?])/;
const BACKTICKED = /`([^`\n]{2,80})`/;
const CAMEL_IDENT = /\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/;
const CODE_WORD = /\b(kode|code|fungsi|function|modul|module|file|class|kelas|method|komponen|component|hook)\b/i;

/** The code path or identifier a message names, if any (syntax, not meaning). */
export function codeTargetOf(text: string): string | undefined {
  return (BACKTICKED.exec(text)?.[1] ?? CODE_PATH.exec(text)?.[1] ?? CAMEL_IDENT.exec(text)?.[1])?.trim();
}

/** Whether the message names repo code/files (a path, an identifier or a code word). */
export function mentionsCode(text: string): boolean {
  return Boolean(codeTargetOf(text)) || CODE_WORD.test(text);
}

/** Kept for callers that still import the domain word source. */
export { backendWordPattern };

/**
 * The agent who answered most recently before the latest user message, if it
 * is still on the team. System lines are routing, not replies.
 */
export function previousResponder<T extends { _id: string; name: string; role: string }>(
  history: HistoryRow[],
  team: T[]
): T | null {
  let i = history.length - 1;
  while (i >= 0 && history[i].authorType !== "user") i -= 1;
  for (i -= 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row.authorType !== "agent" || isSystemLine(row) || !row.agentId || !row.content?.trim()) continue;
    const agent = team.find((a) => String(a._id) === String(row.agentId));
    if (agent) return agent;
  }
  return null;
}

/** System's routing line (§2.5): English only, no @name, no opinion. */
export function systemRoutingLine(agents: Array<{ name: string }>): string {
  const names = agents.map((a) => a.name.trim()).filter(Boolean);
  if (names.length === 0) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Sent to ${list}`;
}

/**
 * The answer subtype for a routed specialist reply. A code review or security
 * question is an audit; an implementation label becomes an explanation (a
 * routed message is chat, never a plan).
 */
export function routedAnswerSubtype<S extends string>(
  domain: DispatchDomain,
  subtype: S
): S | "audit" | "explanation" {
  if (domain === "audit") return "audit";
  if (domain === "research" && subtype === "implementation") return "explanation";
  return subtype === "implementation" ? "explanation" : subtype;
}
