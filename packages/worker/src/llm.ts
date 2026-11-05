import Anthropic from "@anthropic-ai/sdk";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResult {
  content: string;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], model?: string): Promise<LLMResult>;
  stream?(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string): Promise<LLMResult>;
}

export type AgentLLMConfig = {
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
};

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
    return { content: text };
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
    const timeout = setTimeout(() => controller.abort(), 30_000);
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
        throw new Error(`LLM request timed out after 30s at ${this.baseUrl}/chat/completions`);
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
      const data = JSON.parse(normalizedBody) as { choices?: { message?: { content?: string } }[] };
      return { content: data.choices?.[0]?.message?.content ?? "" };
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

export function createProviderForAgent(config: AgentLLMConfig): LLMProvider {
  const provider = config.llmProvider ?? "anthropic";
  const apiKey = config.llmApiKey;
  if (!apiKey) throw new Error(`API key missing for ${provider} agent`);

  if (provider === "openai-compatible") {
    return new OpenAICompatibleProvider(
      apiKey,
      config.llmModel ?? "gpt-4o-mini",
      config.llmBaseUrl ?? "https://api.openai.com/v1"
    );
  }
  if (provider === "anthropic") {
    return new AnthropicProvider(apiKey, config.llmModel ?? "claude-sonnet-4-20250514");
  }
  throw new Error(`Unsupported LLM provider: ${provider}`);
}
