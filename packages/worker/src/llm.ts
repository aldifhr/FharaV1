import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResult } from "@/types/llm";
import { emitObservation } from "@/effects/observationContext";

export type { LLMMessage, LLMResult } from "@/types/llm";
import { mergeRawUsage, normalizeAnthropicUsage, normalizeOpenAiUsage } from "@/llm/usage";

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

/**
 * Surface a truncated answer (finish_reason "length"): the model hit the
 * output cap, so JSON / file content may be cut mid-way. Logged as a
 * warning and reported as a `stall.output_truncated` observation (warn
 * level) when a runner scope is active. Never throws. Returns the result.
 */
export function noteTruncation(result: LLMResult, where: { model: string; baseUrl?: string; maxTokens: number }): LLMResult {
  if (result.finishReason !== "length") return result;
  const reason = `LLM output truncated at the ${where.maxTokens}-token cap (finish_reason "length") for model "${where.model}"; raise ORCHESTRATOR_LLM_MAX_TOKENS if answers are cut off`;
  try {
    console.warn(`[llm] ${reason}`);
  } catch {
    // Logging never breaks the call.
  }
  emitObservation({
    kind: "output_truncated",
    action: "report",
    reason,
    detail: {
      model: where.model,
      maxTokens: where.maxTokens,
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(where.baseUrl ? { host: hostOf(where.baseUrl) } : {}),
    },
  });
  return result;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function anthropicFinishReason(stopReason: string | null | undefined): string | undefined {
  if (!stopReason) return undefined;
  return stopReason === "max_tokens" ? "length" : stopReason;
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
    const maxTokens = opts?.maxTokens ?? llmMaxTokens();
    const res = await this.client.messages.create({
      model: model ?? this.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: user.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    }, { signal: opts?.signal, timeout: effectiveLlmTimeoutMs(opts?.timeoutMs) });
    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");
    const finishReason = anthropicFinishReason(res.stop_reason);
    return noteTruncation(
      {
        content: text,
        ...normalizeAnthropicUsage(res.usage),
        ...(finishReason ? { finishReason } : {}),
      },
      { model: model ?? this.model, maxTokens }
    );
  }

  async stream(messages: LLMMessage[], onChunk: (delta: string) => void, model?: string, opts?: LLMCallOptions): Promise<LLMResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role !== "system");
    const maxTokens = opts?.maxTokens ?? llmMaxTokens();
    const stream = await this.client.messages.create({
      model: model ?? this.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: user.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      stream: true,
    }, { signal: opts?.signal, timeout: effectiveLlmTimeoutMs(opts?.timeoutMs) });
    let full = "";
    let rawUsage: Record<string, unknown> | undefined;
    let finishReason: string | undefined;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        full += event.delta.text;
        onChunk(event.delta.text);
      } else if (event.type === "message_start") {
        // Streaming usage: input tokens arrive on message_start, output
        // tokens (cumulative) on message_delta. Without this the streamed
        // path recorded no usage at all.
        // Cache read/write counts ride on the same events (plan 040 P3).
        rawUsage = mergeRawUsage(rawUsage, event.message.usage);
      } else if (event.type === "message_delta") {
        rawUsage = mergeRawUsage(rawUsage, event.usage);
        finishReason = anthropicFinishReason(event.delta?.stop_reason) ?? finishReason;
      }
    }
    return noteTruncation(
      { content: full, ...normalizeAnthropicUsage(rawUsage), ...(finishReason ? { finishReason } : {}) },
      { model: model ?? this.model, maxTokens }
    );
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
    const maxTokens = opts?.maxTokens ?? llmMaxTokens();
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
        body: JSON.stringify({ model: model ?? this.model, messages, max_tokens: maxTokens }),
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

    return noteTruncation(parseCompletionBody(responseBody), { model: model ?? this.model, baseUrl: this.baseUrl, maxTokens });
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
    const maxTokens = opts?.maxTokens ?? llmMaxTokens();
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
          max_tokens: maxTokens,
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
        return noteTruncation(result, { model: model ?? this.model, baseUrl: this.baseUrl, maxTokens });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let usage: unknown;
      let finishReason: string | undefined;
      const handleLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let payload: {
          choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: unknown;
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
        if (payload.choices?.[0]?.finish_reason) finishReason = payload.choices[0].finish_reason;
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
      return noteTruncation(
        { content, ...normalizeOpenAiUsage(usage), ...(finishReason ? { finishReason } : {}) },
        { model: model ?? this.model, baseUrl: this.baseUrl, maxTokens }
      );
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
    const data = JSON.parse(normalizedBody) as {
      choices?: { message?: { content?: string }; finish_reason?: string | null }[];
      usage?: unknown;
    };
    const finishReason = data.choices?.[0]?.finish_reason ?? undefined;
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      ...normalizeOpenAiUsage(data.usage),
      ...(finishReason ? { finishReason } : {}),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    // A server that answers with SSE even without `stream: true`: the
    // usage (when sent) rides on the last chunk(s). `stream_options` is
    // deliberately not sent — strict OpenAI rejects it on a non-stream
    // request; missing usage is estimated upstream (withUsageEstimate).
    let usage: unknown;
    let finishReason: string | undefined;
    const content = normalizedBody
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
      .map((line) => {
        const payload = JSON.parse(line.slice(5).trim()) as {
          choices?: { delta?: { content?: string }; message?: { content?: string }; finish_reason?: string | null }[];
          usage?: unknown;
        };
        if (payload.usage) usage = payload.usage;
        if (payload.choices?.[0]?.finish_reason) finishReason = payload.choices[0].finish_reason;
        return payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
      })
      .join("");

    return {
      content,
      ...normalizeOpenAiUsage(usage),
      ...(finishReason ? { finishReason } : {}),
    };
  }
}

export function createGlobalLLMProvider(config?: GlobalLLMConfig): LLMProvider {
  const cfg = config ?? getGlobalLLMConfig();
  const provider = cfg.provider.toLowerCase();
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error(`API key missing for global LLM provider (${provider}). Set LLM_API_KEY.`);

  // Only Anthropic speaks the Messages API; every other kind ("openai",
  // "openai-compatible", and free-form ones like "openrouter", "groq",
  // "ollama") speaks OpenAI chat completions — same routing as the backend
  // (apps/api/convex/lib/chat/llmEndpoint.ts).
  if (provider === "anthropic" || provider === "claude" || provider.startsWith("anthropic")) {
    return new AnthropicProvider(apiKey, cfg.model, cfg.baseUrl);
  }
  if (!provider) throw new Error("Unsupported LLM provider: (empty)");
  return new OpenAICompatibleProvider(apiKey, cfg.model, cfg.baseUrl);
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
