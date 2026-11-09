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
