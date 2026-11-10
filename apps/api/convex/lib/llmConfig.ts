/**
 * Global LLM fallback config from Convex env vars (LLM_PROVIDER, LLM_MODEL,
 * LLM_*_BASE_URL, LLM_API_KEY). Used when the provider pool has no usable
 * connection. Shared by the chat client and the prompt enhancer.
 */
import { cenv, cenvRaw } from "@fhara/config/convex";
export type LlmEndpointConfig = { provider: string; model: string; baseUrl: string; apiKey: string };

export function getGlobalLLMConfig(): LlmEndpointConfig {
  // Convex flavour: only "openai" takes the OpenAI defaults; openai-compatible
  // falls back to Anthropic's (the worker differs, D4 / B5).
  const provider = cenv("LLM_PROVIDER");
  const openai = provider === "openai";
  return {
    provider,
    model: cenv("LLM_MODEL", undefined, { fallback: openai ? "gpt-4o-mini" : "claude-sonnet-4-20250514" }),
    baseUrl: openai
      ? (cenvRaw("LLM_OPENAI_BASE_URL") ?? cenvRaw("LLM_BASE_URL") ?? "https://api.openai.com/v1")
      : (cenvRaw("LLM_ANTHROPIC_BASE_URL") ?? cenvRaw("LLM_BASE_URL") ?? "https://api.anthropic.com/v1"),
    apiKey: cenv("LLM_API_KEY"), // alias OPENAI_API_KEY, default ""
  };
}
