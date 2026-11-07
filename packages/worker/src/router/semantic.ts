import type { IntentResult } from "./route";

/**
 * Stage B — Semantic classifier prompt for the lightweight LLM call.
 * Reuses the shared provider pool (no hardcoded key). The result is parsed
 * with parseIntentResult(); invalid output fails closed to `chat`.
 */
export function buildSemanticPrompt(input: { text: string; capabilities?: string[] }): string {
  return [
    "You are an intent classifier for a software engineering workspace.",
    "Return ONLY JSON: {\"intent\":\"execute_task\"|\"chat\"|\"clarify\",\"confidence\":0..1,\"actionability\":\"explicit\"|\"implied\"|\"discussion\"|\"uncertain\",\"projectScope\":\"current_project\"|\"other_project\"|\"none\",\"requiresConfirmation\":bool,\"clarificationQuestion\":\"?\",\"summary\":\"...\"}",
    "",
    "Choose `execute_task` when the user wants the AI team to DO work in this project (migrate, refactor, create, fix, setup, switch stack, add Docker, build UI). Choose `chat` for pure questions/discussion. Choose `clarify` when ambiguous and needs confirmation.",
    "",
    "The text may be Indonesian, English, mixed, or informal. Judge by meaning, not by word list.",
    "",
    `User text: ${input.text}`,
    input.capabilities?.length ? `Suggested capabilities: ${input.capabilities.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseIntentResult(raw: string): IntentResult | null {
  const text = raw.trim();
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const o = JSON.parse(json[0]) as Partial<IntentResult>;
    if (!o.intent || !["execute_task", "chat", "clarify"].includes(o.intent)) return null;
    if (typeof o.confidence !== "number") o.confidence = 0.5;
    o.confidence = Math.max(0, Math.min(1, o.confidence));
    return {
      intent: o.intent as IntentResult["intent"],
      confidence: o.confidence,
      actionability: (o.actionability as IntentResult["actionability"]) ?? "implied",
      projectScope: (o.projectScope as IntentResult["projectScope"]) ?? "current_project",
      requiresConfirmation: Boolean(o.requiresConfirmation),
      clarificationQuestion: typeof o.clarificationQuestion === "string" ? o.clarificationQuestion : undefined,
      summary: typeof o.summary === "string" ? o.summary : "",
    };
  } catch {
    return null;
  }
}
