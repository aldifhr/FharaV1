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

// Prompt text lives in `@/prompts/classifier`; re-exported for existing importers.
export { buildSemanticPrompt } from "@/prompts/classifier";

const SUBTYPES: IntentSubtype[] = [
  "explanation",
  "recommendation",
  "research",
  "audit",
  "implementation",
  "debugging",
  "testing",
  "continue",
  "pause",
  "cancel",
  "status",
  "approve",
  "reject",
  "other",
];

export function parseIntentResult(raw: string): IntentResult | null {
  const text = raw.trim();
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const o = JSON.parse(json[0]) as Partial<IntentResult>;
    if (!["ask", "task", "continue", "pause", "cancel", "status", "approve", "reject"].includes(o.intent as string)) return null;
    const subtype: IntentSubtype = SUBTYPES.includes(o.subtype as IntentSubtype)
      ? (o.subtype as IntentSubtype)
      : "other";
    if (typeof o.confidence !== "number") o.confidence = 0.5;
    o.confidence = Math.max(0, Math.min(1, o.confidence));
    const needsExec = o.intent === "task" || o.intent === "continue" || o.intent === "approve";
    return {
      intent: o.intent as IntentResult["intent"],
      subtype,
      requiresWorkspace: Boolean(o.requiresWorkspace),
      requiresExecution: needsExec ? true : Boolean(o.requiresExecution),
      target: typeof o.target === "string" ? o.target : undefined,
      confidence: o.confidence,
      reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    };
  } catch {
    return null;
  }
}
