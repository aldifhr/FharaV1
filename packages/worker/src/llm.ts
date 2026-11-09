import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResult } from "@/types/llm";

export type { LLMMessage, LLMResult } from "@/types/llm";

export interface LLMCallOptions {
  /** External cancellation (task cancel/deadline). Enforcement lands in
   *  Phase 4; the plumbing is here so providers honor it end-to-end. */
  signal?: AbortSignal;
  /**
   * Per-call timeout. Bounded by the configured LLM timeout
   * (ORCHESTRATOR_LLM_TIMEOUT_MS); callers pass the subtask's remaining
   * time so one slow call can never outlive the subtask that made it.
   */
  timeoutMs?: number;
  /** Per-call output cap; defaults to ORCHESTRATOR_LLM_MAX_TOKENS. */
  maxTokens?: number;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], model?: string, opts?: LLMCallOptions): Promise<LLMResult>;
  stream?(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string, opts?: LLMCallOptions): Promise<LLMResult>;
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

export const DEFAULT_LLM_MAX_TOKENS = 8192;
export const DEFAULT_LLM_TIMEOUT_MS = 300_000;

function intEnv(name: string, fallback: number, min: number, max: number, env: Record<string, string | undefined>): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Max output tokens per LLM call (ORCHESTRATOR_LLM_MAX_TOKENS). A hard
 * cap of 4k tokens truncated full-file JSON answers from code-change
 * subtasks, which then failed as "invalid file changes JSON" (e2e ULTRA).
 */
export function llmMaxTokens(env: Record<string, string | undefined> = process.env): number {
  return intEnv("ORCHESTRATOR_LLM_MAX_TOKENS", DEFAULT_LLM_MAX_TOKENS, 256, 200_000, env);
}

/** Ceiling for one LLM request (ORCHESTRATOR_LLM_TIMEOUT_MS). */
export function llmTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return intEnv("ORCHESTRATOR_LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS, 1_000, 3_600_000, env);
}

/** Effective timeout of one call: the per-call bound, never above the ceiling. */
export function effectiveLlmTimeoutMs(requested?: number): number {
  const ceiling = llmTimeoutMs();
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514", baseUrl?: string) {
    this.client = new Anthropic({
      apiKey,
      // Honor custom base URLs (direct provider / gateway) exactly like
      // the OpenAI-compatible path; previously baseUrl was ignored here.
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      // Same ceiling as the OpenAI-compatible path; retries are owned
      // by the llmCall layer, not the SDK.
      timeout: llmTimeoutMs(),
      maxRetries: 0,
    });
    this.model = model;
  }

  async complete(messages: LLMMessage[], model?: string, opts?: LLMCallOptions): Promise<LLMResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role !== "system");
    const res = await this.client.messages.create({
      model: model ?? this.model,
      max_tokens: opts?.maxTokens ?? llmMaxTokens(),
      system: system || undefined,
      messages: user.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    }, { signal: opts?.signal, timeout: effectiveLlmTimeoutMs(opts?.timeoutMs) });
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

  async stream(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string, opts?: LLMCallOptions): Promise<LLMResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role !== "system");
    const stream = await this.client.messages.create({
      model: model ?? this.model,
      max_tokens: opts?.maxTokens ?? llmMaxTokens(),
      system: system || undefined,
      messages: user.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      stream: true,
    }, { signal: opts?.signal, timeout: effectiveLlmTimeoutMs(opts?.timeoutMs) });
    let full = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        full += event.delta.text;
        onChunk(event.delta.text);
      } else if (event.type === "message_start") {
        // Streaming usage: input tokens arrive on message_start, output
        // tokens (cumulative) on message_delta. Without this the streamed
        // path recorded no usage at all.
        inputTokens = event.message.usage?.input_tokens ?? inputTokens;
        outputTokens = event.message.usage?.output_tokens ?? outputTokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      }
    }
    return { content: full, inputTokens, outputTokens };
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1"
  ) {}

  async complete(messages: LLMMessage[], model?: string, opts?: LLMCallOptions): Promise<LLMResult> {
    const controller = new AbortController();
    const timeoutMs = effectiveLlmTimeoutMs(opts?.timeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // Combine the internal timeout with the caller's signal: whichever
    // aborts first cancels the request.
    const onExternalAbort = () => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let response: Response;
    let responseBody: string;
    // The timeout and the caller's abort cover the WHOLE request,
    // including reading the body (core M16): a stalled body no longer
    // hangs until the subtask timeout, and a task cancel is observed.
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: model ?? this.model, messages, max_tokens: opts?.maxTokens ?? llmMaxTokens() }),
        signal: controller.signal,
      });
      responseBody = await response.text();
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === "AbortError") ||
        (controller.signal.aborted && error instanceof Error && error.name === "AbortError")
      ) {
        if (opts?.signal?.aborted) {
          throw new Error(`LLM request aborted by caller at ${this.baseUrl}/chat/completions`);
        }
        throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s at ${this.baseUrl}/chat/completions`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
    if (!response.ok) {
      const details = responseBody.trim().slice(0, 500);
      throw new Error(
        `LLM request failed (${response.status}) for model "${model ?? this.model}" at ${this.baseUrl}/chat/completions${details ? `: ${details}` : ""}`
      );
    }

    return parseCompletionBody(responseBody);
  }

  /**
   * Real SSE streaming (`stream: true`): text deltas reach `onChunk` as
   * they arrive, so the live output tail moves while the model writes.
   * Same timeout/abort coverage as complete() (the whole body read), same
   * error shape. A server that ignores `stream` and answers with one JSON
   * body is parsed like complete() and emitted as a single chunk. Usage
   * is read when the server sends it; `stream_options` is not sent (strict
   * servers reject unknown fields), missing usage is estimated upstream.
   */
  async stream(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string, opts?: LLMCallOptions): Promise<LLMResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timeoutMs = effectiveLlmTimeoutMs(opts?.timeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: model ?? this.model,
          messages,
          max_tokens: opts?.maxTokens ?? llmMaxTokens(),
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = (await response.text()).trim().slice(0, 500);
        throw new Error(
          `LLM request failed (${response.status}) for model "${model ?? this.model}" at ${this.baseUrl}/chat/completions${details ? `: ${details}` : ""}`
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body || !/event-stream/i.test(contentType)) {
        const result = parseCompletionBody(await response.text());
        if (result.content) onChunk(result.content);
        return result;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const handleLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let payload: {
          choices?: { delta?: { content?: string | null }; message?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          error?: { message?: string } | string;
        };
        try {
          payload = JSON.parse(data);
        } catch {
          return; // a malformed keep-alive/comment line is not fatal
        }
        if (payload.error) {
          const message = typeof payload.error === "string" ? payload.error : payload.error.message ?? "unknown error";
          throw new Error(`LLM stream error for model "${model ?? this.model}" at ${this.baseUrl}/chat/completions: ${message.slice(0, 500)}`);
        }
        if (payload.usage) usage = payload.usage;
        const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
        if (delta) {
          content += delta;
          onChunk(delta);
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
      return { content, inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
        if (opts?.signal?.aborted) {
          throw new Error(`LLM request aborted by caller at ${this.baseUrl}/chat/completions`);
        }
        throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s at ${this.baseUrl}/chat/completions`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Parse a /chat/completions body: one JSON object, or SSE lines from a
 * server that streams even without `stream: true`.
 */
function parseCompletionBody(responseBody: string): LLMResult {
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

    // A server that answers with SSE even without `stream: true`: the
    // usage (when sent) rides on the last chunk(s). `stream_options` is
    // deliberately not sent — strict OpenAI rejects it on a non-stream
    // request; missing usage is estimated upstream (withUsageEstimate).
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const content = normalizedBody
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
      .map((line) => {
        const payload = JSON.parse(line.slice(5).trim()) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        if (payload.usage) usage = payload.usage;
        return payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
      })
      .join("");

    return { content, inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
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
    return new AnthropicProvider(apiKey, cfg.model, cfg.baseUrl);
  }
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

/**
 * Build the provider for ONE agent from that agent's resolution.
 *
 * Per-agent provider/model independence (spec §2/§4C) lives in the
 * resolver (llm/resolver.ts): it maps the agent's assignment and the pool
 * to a concrete ResolvedLlm. This factory takes that resolution — either
 * the ResolvedLlm itself or its plain GlobalLLMConfig — and constructs the
 * client for it. Called without a resolution it falls back to the
 * worker-env config (no providers configured in Settings).
 */
export function createProviderForAgent(
  _agent?: unknown,
  resolved?: GlobalLLMConfig | { config: GlobalLLMConfig }
): LLMProvider {
  const config =
    resolved && "config" in resolved ? resolved.config : resolved;
  return createGlobalLLMProvider(config);
}
