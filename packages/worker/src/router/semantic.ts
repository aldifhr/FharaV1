import type { IntentResult, IntentSubtype } from "./route";

/**
 * Stage B — LLM Intent Classifier prompt (plan 016). Returns a single
 * structured object; parsed with parseIntentResult(). Invalid output fails
 * closed to `chat`.
 */
export function buildSemanticPrompt(input: { text: string; capabilities?: string[] }): string {
  return [
    "You are an intent classifier for a software engineering workspace.",
    "Return ONLY JSON with this exact schema:",
    `{"intent":"ask"|"task"|"continue"|"pause"|"cancel"|"status"|"approve"|"reject","subtype":"explanation"|"recommendation"|"research"|"audit"|"implementation"|"debugging"|"testing"|"continue"|"pause"|"cancel"|"status"|"approve"|"reject"|"other","requiresWorkspace":bool,"requiresExecution":bool,"target":"?","confidence":0..1,"reasoning":"..."}`,
    "",
    "Choose `task` when the user wants the AI team to DO work (build, fix, test, refactor, migrate). Choose `ask` for pure questions/discussion. Choose `continue` to extend the active task, `pause` to hold it, `cancel` to stop it, `status` to ask progress, `approve`/`reject` to answer a pending approval. Subtypes: explanation/recommendation/research/audit ask; implementation/debugging/testing task.",
    "",
    "The text may be Indonesian, English, mixed, or informal. Judge by meaning, not by word list.",
    "",
    `User text: ${input.text}`,
    input.capabilities?.length ? `Suggested capabilities: ${input.capabilities.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

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
