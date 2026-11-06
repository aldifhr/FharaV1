import Anthropic from "@anthropic-ai/sdk";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], model?: string): Promise<LLMResult>;
  stream?(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string): Promise<LLMResult>;
}

export interface GlobalLLMConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export function getGlobalLLMConfig(env?: Record<string, string | undefined>): GlobalLLMConfig {
  const e = env ?? process.env;
  const provider = (e.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const model = e.LLM_MODEL ?? (provider === "openai-compatible" || provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514");
  const baseUrl = e.LLM_BASE_URL ?? (provider === "openai-compatible" || provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1");
  const apiKey = e.LLM_API_KEY ?? e.OPENAI_API_KEY ?? "";
  return { provider, model, baseUrl, apiKey };
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(messages: LLMMessage[], model?: string): Promise<LLMResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role !== "system");
    const res = await this.client.messages.create({
      model: model ?? this.model,
      max_tokens: 4096,
      system: system || undefined,
      messages: user.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    });
    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");
    return {
      content: text,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
    };
  }

  async stream(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string): Promise<LLMResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role !== "system");
    const stream = await this.client.messages.create({
      model: model ?? this.model,
      max_tokens: 4096,
      system: system || undefined,
      messages: user.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      stream: true,
    });
    let full = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        full += event.delta.text;
        onChunk(event.delta.text);
      }
    }
    return { content: full };
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1"
  ) {}

  async complete(messages: LLMMessage[], model?: string): Promise<LLMResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: model ?? this.model, messages, max_tokens: 4096 }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`LLM request timed out after 300s at ${this.baseUrl}/chat/completions`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const responseBody = await response.text();
    if (!response.ok) {
      const details = responseBody.trim().slice(0, 500);
      throw new Error(
        `LLM request failed (${response.status}) for model "${model ?? this.model}" at ${this.baseUrl}/chat/completions${details ? `: ${details}` : ""}`
      );
    }

    const normalizedBody = responseBody.replace(/(?:\r?\n)?data:\s*\[DONE\]\s*$/, "");
    try {
      const data = JSON.parse(normalizedBody) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;

      const content = normalizedBody
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
        .map((line) => {
          const payload = JSON.parse(line.slice(5).trim()) as {
            choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          };
          return payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
        })
        .join("");

      return { content };
    }
  }

  async stream(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string): Promise<LLMResult> {
    const result = await this.complete(messages, model);
    if (result.content) onChunk(result.content);
    return result;
  }
}

export function createGlobalLLMProvider(config?: GlobalLLMConfig): LLMProvider {
  const cfg = config ?? getGlobalLLMConfig();
  const provider = cfg.provider.toLowerCase();
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error(`API key missing for global LLM provider (${provider}). Set LLM_API_KEY.`);

  if (provider === "openai-compatible" || provider === "openai") {
    return new OpenAICompatibleProvider(apiKey, cfg.model, cfg.baseUrl);
  }
  if (provider === "anthropic") {
    return new AnthropicProvider(apiKey, cfg.model);
  }
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

// Back-compat: agent identity no longer carries LLM config. All agents share global LLM.
// Callers that resolved the provider for a specific task pass it explicitly
// via `llmConfig` (no process.env mutation); omitted -> env-based default.
export function createProviderForAgent(
  _agent?: unknown,
  llmConfig?: GlobalLLMConfig
): LLMProvider {
  return createGlobalLLMProvider(llmConfig);
}
