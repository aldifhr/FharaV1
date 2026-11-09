import { classifyCommand } from "../orchestrator/classifier";
import type { AgentDefinition, Classification } from "@/types";
import { selectAgentsForChat } from "./selectAgents";

export type RouterIntent =
  | "chat"
  | "question"
  | "advice"
  | "research"
  | "audit"
  | "task"
  | "ambiguous";

/** Structured LLM intent output (plan 016). */
export type Intent = "ask" | "task" | "continue" | "pause" | "cancel" | "status" | "approve" | "reject";

export type IntentSubtype =
  | "explanation"
  | "recommendation"
  | "research"
  | "audit"
  | "implementation"
  | "debugging"
  | "testing"
  | "continue"
  | "pause"
  | "cancel"
  | "status"
  | "approve"
  | "reject"
  | "other";

export interface IntentResult {
  intent: Intent;
  subtype: IntentSubtype;
  requiresWorkspace: boolean;
  requiresExecution: boolean;
  target?: string;
  confidence: number;
  reasoning: string;
}

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
   * LLM Intent Classifier for `ambiguous` input only (plan 006 Phase 4 wires the real
   * one behind the budget gate). Returns a structured IntentResult OR a legacy
   * intent string. Invalid output falls back to `chat`, never silently to `task`.
   */
  advise?: (text: string, capabilities: string[]) => Promise<IntentResult | string>;
}

// Boundary guard: imperative change requests ("Add a login form") do not
// match; question/advice shapes ("How do I add…?", "Should I use…?") do —
// even when they contain a change verb. This is the platform rule that
// questions, advice and analysis never become tasks.
const QUESTION_SHAPE =
  /\b(how do i|how to|how can|how does|why|what is|what are|what's|what does|what do|where is|explain|describe|summari[sz]e|document|understand)\b/i;
const ADVICE_SHAPE =
  /\b(should i|recommend|best (practice|way)|suggest|advice|prefer)\b/i;
// "can you …?" / "bisa kan? …" — a question to the agent, not an order to
// build something. Kept in sync with apps/api/convex/chat.ts.
const CONFIRMATION_SHAPE =
  /\b(can you|can u|are you able|bisa (nggak|ga|tidak)?|bisa kah|kamu bisa|apakah)\b/i;

const ASK_SUBTYPE_TO_INTENT: Record<IntentSubtype, RouterIntent> = {
  explanation: "question",
  recommendation: "advice",
  research: "research",
  audit: "audit",
  implementation: "question",
  debugging: "question",
  testing: "question",
  continue: "question",
  pause: "question",
  cancel: "question",
  status: "question",
  approve: "question",
  reject: "question",
  other: "question",
};

/**
 * Intent/context router (plan 006 Phase 1, upgraded by plan 016).
 * Deterministic shapes are a fast path; the LLM Intent Classifier decides the
 * ambiguous rest; invalid output fails closed to chat — an advisor can enable
 * a *chat* answer, never silently create a task.
 */
export async function routeMessage(input: RouterInput): Promise<RouteResult> {
  const { text, agents, advise } = input;
  const chatMaxAgents = Math.max(1, input.chatMaxAgents ?? 1);
  const classification = classifyCommand(text);
  const reasons: string[] = [...classification.reasons];
  const chatAgents = () =>
    selectAgentsForChat(agents, classification.suggestedCapabilities, chatMaxAgents).agentIds;

  // Fast path 1: greeting / small talk.
  if (classification.kind === "conversation") {
    return { intent: "chat", classification, agentIds: chatAgents(), reasons };
  }
  // Fast path 2: question / advice / capability-confirmation shapes.
  if (QUESTION_SHAPE.test(text) || CONFIRMATION_SHAPE.test(text)) {
    return {
      intent: "question",
      classification,
      agentIds: chatAgents(),
      reasons: [...reasons, "question shape"],
    };
  }
  if (ADVICE_SHAPE.test(text)) {
    return {
      intent: "advice",
      classification,
      agentIds: chatAgents(),
      reasons: [...reasons, "advice shape"],
    };
  }
  // Fast path 3: read-only audit / research.
  if (classification.kind === "audit") {
    return { intent: "audit", classification, agentIds: chatAgents(), reasons };
  }
  if (classification.kind === "research") {
    return { intent: "research", classification, agentIds: chatAgents(), reasons };
  }
  // Fast path 4: clear change requests.
  if (classification.kind === "multi") {
    return { intent: "task", classification, agentIds: [], reasons };
  }
  if (classification.kind === "code_change" && !reasons.some((reason) => reason.startsWith("defaulted"))) {
    return { intent: "task", classification, agentIds: [], reasons };
  }

  // Ambiguous / defaulted → LLM Intent Classifier.
  if (advise) {
    try {
      const raw = await advise(text, classification.suggestedCapabilities);
      const parsed: IntentResult | null =
        typeof raw === "string"
          ? legacyStringToIntent(raw)
          : ((raw as IntentResult)?.intent ? (raw as IntentResult) : null);
      if (parsed && ["ask", "task", "continue", "pause", "cancel", "status", "approve", "reject"].includes(parsed.intent)) {
        if (parsed.intent === "task") {
          return {
            intent: "task",
            classification,
            agentIds: [],
            reasons: [...reasons, `semantic: task/${parsed.subtype} (${parsed.confidence})`],
          };
        }
        if (parsed.intent === "continue" || parsed.intent === "pause" || parsed.intent === "cancel" || parsed.intent === "status" || parsed.intent === "approve" || parsed.intent === "reject") {
          return {
            intent: "question",
            classification,
            agentIds: chatAgents(),
            reasons: [...reasons, `semantic: ${parsed.intent} (${parsed.confidence})`],
          };
        }
        return {
          intent: ASK_SUBTYPE_TO_INTENT[parsed.subtype] ?? "question",
          classification,
          agentIds: chatAgents(),
          reasons: [...reasons, `semantic: ask/${parsed.subtype} (${parsed.confidence})`],
        };
      }
      return {
        intent: "chat",
        classification,
        agentIds: chatAgents(),
        reasons: [...reasons, "advisor returned an invalid intent; safe chat fallback"],
      };
    } catch {
      return {
        intent: "chat",
        classification,
        agentIds: chatAgents(),
        reasons: [...reasons, "advisor unavailable; safe chat fallback"],
      };
    }
  }

  return {
    intent: "chat",
    classification,
    agentIds: chatAgents(),
    reasons: [...reasons, "ambiguous input, no advisor; safe chat fallback"],
  };
}

/** Legacy string advisor output → structured result. Uppercase is invalid. */
function legacyStringToIntent(raw: string): IntentResult | null {
  if (raw === "task") {
    return {
      intent: "task",
      subtype: "other",
      requiresWorkspace: true,
      requiresExecution: true,
      confidence: 0.85,
      reasoning: "advisor: task",
    };
  }
  if (raw === "chat") {
    return {
      intent: "ask",
      subtype: "other",
      requiresWorkspace: false,
      requiresExecution: false,
      confidence: 0.85,
      reasoning: "advisor: chat",
    };
  }
  return null;
}
