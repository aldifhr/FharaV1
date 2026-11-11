/**
 * B5 (D4): the one global LLM fallback, used by the worker (llm.ts) and
 * Convex (lib/llmConfig.ts). Before B5 Convex gave openai-compatible the
 * Anthropic defaults while the worker gave it OpenAI's, and only Convex
 * honoured LLM_OPENAI_BASE_URL / LLM_ANTHROPIC_BASE_URL.
 *
 *   provider  LLM_PROVIDER (lowercased, default anthropic)
 *   model     LLM_MODEL, else the flavour default
 *   baseUrl   the flavour's own URL var, else LLM_BASE_URL, else the flavour default
 *   apiKey    LLM_API_KEY (alias OPENAI_API_KEY), else ""
 *
 * The OpenAI flavour is `openai` and `openai-compatible`; everything else
 * takes the Anthropic defaults.
 */
import { type EnvSource, readVar } from "./read";
import { isOpenAIFlavour } from "./schema/llm";
import { processEnv } from "./runtime/processEnv";

export interface LlmFallbackConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export function llmFallbackConfig(source: EnvSource = processEnv()): LlmFallbackConfig {
  const provider = readVar("LLM_PROVIDER", source) as string;
  const flavourUrl = readVar(isOpenAIFlavour(provider) ? "LLM_OPENAI_BASE_URL" : "LLM_ANTHROPIC_BASE_URL", source) as string | undefined;
  return {
    provider,
    model: readVar("LLM_MODEL", source) as string,
    baseUrl: flavourUrl ?? (readVar("LLM_BASE_URL", source) as string),
    apiKey: readVar("LLM_API_KEY", source) as string,
  };
}
