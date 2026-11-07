import { classifyCommand } from "../orchestrator/classifier";
import type { AgentDefinition, Classification } from "../orchestrator/types";
import { selectAgentsForChat } from "./selectAgents";

export type RouterIntent =
  | "chat"
  | "question"
  | "advice"
  | "research"
  | "audit"
  | "task"
  | "ambiguous";

export interface RouteResult {
  intent: RouterIntent;
  classification: Classification;
  /** Agents that should answer in chat. Empty for `task` (orchestrator picks later). */
  agentIds: string[];
  reasons: string[];
}

export interface RouterInput {
  text: string;
  agents: AgentDefinition[];
  chatMaxAgents?: number;
  /**
   * LLM advisor for `ambiguous` input only (plan 006 Phase 4 wires the real
   * one behind the budget gate). Returns an intent string OR anything —
   * invalid output falls back to `chat`, never to `task`.
   */
  advise?: (text: string, capabilities: string[]) => Promise<string>;
}

const ALL_INTENTS: RouterIntent[] = [
  "chat",
  "question",
  "advice",
  "research",
  "audit",
  "task",
  "ambiguous",
];

const CHAT_INTENTS: ReadonlySet<RouterIntent> = new Set([
  "chat",
  "question",
  "advice",
  "research",
  "audit",
]);

// Boundary guard: imperative change requests ("Add a login form") do not
// match; question/advice shapes ("How do I add…?", "Should I use…?") do —
// even when they contain a change verb. This is the platform rule that
// questions, advice and analysis never become tasks.
const QUESTION_SHAPE =
  /\b(how do i|how to|how can|how does|why|what is|what are|what's|what does|what do|where is|explain|describe|summari[sz]e|document|understand)\b/i;
const ADVICE_SHAPE =
  /\b(should i|recommend|best (practice|way)|suggest|advice|prefer)\b/i;

/**
 * Intent/context router (plan 006 Phase 1). Deterministic first; the LLM
 * advisor is consulted only for `ambiguous` input, and its invalid output
 * fails closed to chat — an advisor can enable a *chat* answer, never
 * silently create a task.
 */
export async function routeMessage(input: RouterInput): Promise<RouteResult> {
  const { text, agents, advise } = input;
  const chatMaxAgents = Math.max(1, input.chatMaxAgents ?? 1);
  const classification = classifyCommand(text);
  const reasons: string[] = [...classification.reasons];

  let intent: RouterIntent;
  if (classification.kind === "conversation") {
    intent = "chat";
  } else if (ADVICE_SHAPE.test(text)) {
    intent = "advice";
  } else if (QUESTION_SHAPE.test(text)) {
    intent = "question";
  } else if (classification.kind === "audit") {
    intent = "audit";
  } else if (classification.kind === "research") {
    intent = "research";
  } else if (classification.kind === "multi") {
    intent = "task";
  } else if (classification.kind === "code_change") {
    // The classifier *defaults* unmatched text to a change task; the
    // "defaulted" reason marks the no-evidence case, which must not become
    // a task without an advisor saying so.
    intent = classification.reasons.some((reason) =>
      reason.startsWith("defaulted")
    )
      ? "ambiguous"
      : "task";
  } else {
    intent = "ambiguous";
  }

  if (intent === "ambiguous") {
    if (advise) {
      try {
        const answer = await advise(text, classification.suggestedCapabilities);
        if (ALL_INTENTS.includes(answer as RouterIntent)) {
          intent = answer as RouterIntent;
          reasons.push(`advisor: ${intent}`);
        } else {
          intent = "chat";
          reasons.push("advisor returned an invalid intent; safe chat fallback");
        }
      } catch {
        intent = "chat";
        reasons.push("advisor unavailable; safe chat fallback");
      }
    } else {
      intent = "chat";
      reasons.push("ambiguous input, no advisor; safe chat fallback");
    }
  }

  const agentIds = CHAT_INTENTS.has(intent)
    ? selectAgentsForChat(
        agents,
        classification.suggestedCapabilities,
        chatMaxAgents
      ).agentIds
    : [];

  return { intent, classification, agentIds, reasons };
}
