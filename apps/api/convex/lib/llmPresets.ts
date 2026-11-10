/**
 * Provider presets for Settings → LLM & Models.
 *
 * A preset is what the user picks instead of a wire format: it fills the
 * wire format (`provider`), the base URL and a "get a key" link, so adding a
 * provider is a name plus a key. Pure data, shared by the web form and the
 * backend (model discovery uses `authStyleFor`).
 *
 * Only plain API-key (or local, keyless) vendors. No OAuth or
 * client-impersonating presets.
 */

/** Wire formats the resolver and the chat client understand. */
export type LlmWireFormat = "anthropic" | "openai" | "openai-compatible";

export interface LlmProviderPreset {
  id: string;
  label: string;
  /** Wire format stored in `llmProviders.provider`. */
  provider: LlmWireFormat;
  baseUrl: string;
  /** Where the user gets a key (absent for local servers). */
  apiKeyUrl?: string;
  /** False for local servers that accept requests without a key. */
  needsKey: boolean;
  /**
   * Env var read when no key is stored (Advanced). Vendor-specific so a
   * keyless local server never receives another vendor's LLM_API_KEY.
   */
  apiKeyEnv: string;
  /** Placeholder for the model id field. */
  modelHint?: string;
}

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  {
    id: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    modelHint: "claude-sonnet-4-5",
  },
  {
    id: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    label: "OpenAI",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
    modelHint: "gpt-4o-mini",
  },
  {
    id: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    provider: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyUrl: "https://openrouter.ai/keys",
    needsKey: true,
    modelHint: "anthropic/claude-sonnet-4.5",
  },
  {
    id: "gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    label: "Google Gemini",
    provider: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
    modelHint: "gemini-2.5-flash",
  },
  {
    id: "deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
    modelHint: "deepseek-chat",
  },
  {
    id: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    label: "Groq",
    provider: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyUrl: "https://console.groq.com/keys",
    needsKey: true,
    modelHint: "llama-3.3-70b-versatile",
  },
  {
    id: "mistral",
    apiKeyEnv: "MISTRAL_API_KEY",
    label: "Mistral",
    provider: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    needsKey: true,
    modelHint: "mistral-large-latest",
  },
  {
    id: "together",
    apiKeyEnv: "TOGETHER_API_KEY",
    label: "Together AI",
    provider: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyUrl: "https://api.together.ai/settings/api-keys",
    needsKey: true,
    modelHint: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    id: "ollama",
    apiKeyEnv: "OLLAMA_API_KEY",
    label: "Ollama (local)",
    provider: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    modelHint: "llama3.2",
  },
  {
    id: "lmstudio",
    apiKeyEnv: "LMSTUDIO_API_KEY",
    label: "LM Studio (local)",
    provider: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
  },
  {
    id: "custom",
    apiKeyEnv: "LLM_API_KEY",
    label: "Custom (OpenAI-compatible)",
    provider: "openai-compatible",
    baseUrl: "",
    needsKey: false,
  },
];

export function findPreset(id: string | undefined | null): LlmProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Best-effort preset for an existing row (no stored preset id). */
export function guessPreset(row: { provider: string; baseUrl: string }): LlmProviderPreset {
  const base = row.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const exact = LLM_PROVIDER_PRESETS.find(
    (preset) => preset.baseUrl && preset.baseUrl.toLowerCase() === base
  );
  if (exact) return exact;
  if (row.provider === "anthropic") return LLM_PROVIDER_PRESETS[0];
  return LLM_PROVIDER_PRESETS[LLM_PROVIDER_PRESETS.length - 1];
}

/**
 * HTTP request for a provider's model list. Anthropic authenticates with
 * `x-api-key` + `anthropic-version`, not `Authorization: Bearer`; every
 * other wire format uses Bearer. A keyless local server gets no auth header.
 */
export function modelListHeaders(
  provider: string,
  apiKey: string | undefined
): Record<string, string> {
  const key = apiKey?.trim();
  if (provider.toLowerCase() === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      ...(key ? { "x-api-key": key } : {}),
    };
  }
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** Model ids out of a `/models` answer (OpenAI `data`, Gemini/Ollama `models`). */
export function parseModelList(data: unknown): string[] {
  const body = (data ?? {}) as { data?: unknown; models?: unknown };
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const ids = list
    .map((m: unknown) =>
      typeof m === "string"
        ? m
        : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name
    )
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    .map((id: string) => id.replace(/^models\//, ""));
  return [...new Set(ids)].sort();
}
