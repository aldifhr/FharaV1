/**
 * Global LLM fallback config from Convex env vars (LLM_PROVIDER, LLM_MODEL,
 * LLM_*_BASE_URL, LLM_API_KEY). Used when the provider pool has no usable
 * connection. Shared by the chat client and the prompt enhancer.
 */
export type LlmEndpointConfig = { provider: string; model: string; baseUrl: string; apiKey: string };

export function getGlobalLLMConfig(): LlmEndpointConfig {
  const env: Record<string, string | undefined> =
    (globalThis as any).process?.env ?? {};
  const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  return {
    provider,
    model: env.LLM_MODEL ?? (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514"),
    baseUrl: provider === "openai"
      ? (env.LLM_OPENAI_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1")
      : (env.LLM_ANTHROPIC_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.anthropic.com/v1"),
    apiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? "",
  };
}
