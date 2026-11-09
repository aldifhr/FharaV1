/**
 * LLM-backed chat decisions: the Stage B intent classifier and the CTO's
 * ASK responder chooser. Both fail closed — an unavailable or unparseable
 * reply yields null and the caller falls back to a safe deterministic path.
 */
import { completeWithAgent, type ChatLlmConfig } from "./llm";
import { parseIntentResult, type IntentResult } from "./intent";
import { parseResponderSelection, type ChatAgent } from "./team";
import {
  ASK_RESPONDER_SYSTEM,
  INTENT_CLASSIFIER_SYSTEM,
  buildAskResponderPrompt,
  buildIntentClassifierPrompt,
} from "../prompts/chat";

/**
 * CTO role selection for ASK (plan 016): the LLM picks the one conversational
 * agent whose role best answers the question (e.g. a styling question →
 * Frontend, a security question → Reviewer). Returns the agent id, or null
 * when the call fails / the reply is unparseable — the caller then falls
 * back to pickConversationalAgent. The pool excludes the orchestrator
 * roles; an explicit mention has already won before this chooser runs.
 */
export async function chooseAskResponder(
  candidates: ChatAgent[],
  userText: string,
  config: ChatLlmConfig
): Promise<string | null> {
  if (candidates.length <= 1) return candidates.length === 1 ? String(candidates[0]._id) : null;
  const prompt = buildAskResponderPrompt(candidates, userText);
  const raw = await completeWithAgent(ASK_RESPONDER_SYSTEM, [{ role: "user", content: prompt }], config)
    .then((result) => result.content)
    .catch(() => "");
  return parseResponderSelection(raw, candidates.map((a) => String(a._id)));
}

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
