/**
 * Global LLM fallback config from Convex env vars (LLM_PROVIDER, LLM_MODEL,
 * LLM_*_BASE_URL, LLM_API_KEY). Used when the provider pool has no usable
 * connection. Shared by the chat client and the prompt enhancer.
 */
import { llmFallbackConfig } from "@fhara/config";
export type LlmEndpointConfig = { provider: string; model: string; baseUrl: string; apiKey: string };

/** B5: the same fallback as the worker (openai-compatible → OpenAI defaults). */
export function getGlobalLLMConfig(): LlmEndpointConfig {
  return llmFallbackConfig();
}
