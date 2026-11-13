/**
 * LLM-backed chat decision: the Stage B intent classifier (a suggestion that
 * shapes the reply; it never routes and never starts a task). Fails closed —
 * an unavailable or unparseable reply yields null.
 */
import { completeWithAgent, type ChatLlmConfig } from "./llm";
import { parseIntentResult, type IntentResult } from "./intent";
import { INTENT_CLASSIFIER_SYSTEM, buildIntentClassifierPrompt } from "../prompts/chat";

/**
 * Stage B — LLM Intent Classifier. Returns the structured IntentResult.
 * Invalid/unavailable output fails closed to `ask` (never a task).
 */
export async function classifyIntent(
  text: string,
  config: ChatLlmConfig,
  activeTask?: { title: string; status: string } | null
): Promise<IntentResult | null> {
  const prompt = buildIntentClassifierPrompt(text, activeTask);
  const raw = await completeWithAgent(INTENT_CLASSIFIER_SYSTEM, [{ role: "user", content: prompt }], config)
    .then((result) => result.content)
    .catch(() => "");
  return parseIntentResult(raw);
}
