import { llmFallbackConfig, schemaDefault } from "@fhara/config";
import { wenv } from "@fhara/config/worker";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResult } from "@/types/llm";
import { emitObservation } from "@/effects/observationContext";

export type { LLMMessage, LLMResult } from "@/types/llm";
import { firstTokenClock, mergeRawUsage, normalizeAnthropicUsage, normalizeOpenAiUsage } from "@/llm/usage";
import { contextLimitFromText, formatTimeoutLimit, isContextOverflowText } from "@/api/convex/lib/llmWireErrors";
import { asDroppedConnection, LlmContextOverflowError, LlmIncompleteResponseError, LlmMalformedResponseError } from "@/llm/errors";

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
  // B5: one fallback for the worker and Convex (@fhara/config llmFallbackConfig).
  return llmFallbackConfig(env);
}

export const DEFAULT_LLM_MAX_TOKENS = schemaDefault("ORCHESTRATOR_LLM_MAX_TOKENS") as number;
export const DEFAULT_LLM_TIMEOUT_MS = schemaDefault("ORCHESTRATOR_LLM_TIMEOUT_MS") as number;

/**
 * Max output tokens per LLM call (ORCHESTRATOR_LLM_MAX_TOKENS). A hard
 * cap of 4k tokens truncated full-file JSON answers from code-change
 * subtasks, which then failed as "invalid file changes JSON" (e2e ULTRA).
 */
export function llmMaxTokens(env?: Record<string, string | undefined>): number {
  return wenv("ORCHESTRATOR_LLM_MAX_TOKENS", env);
}

/** Ceiling for one LLM request (ORCHESTRATOR_LLM_TIMEOUT_MS). */
export function llmTimeoutMs(env?: Record<string, string | undefined>): number {
  return wenv("ORCHESTRATOR_LLM_TIMEOUT_MS", env);
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
    const clock = firstTokenClock();
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
        if (event.delta.text) clock.mark();
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
      { content: full, ...normalizeAnthropicUsage(rawUsage), ...clock.fields(), ...(finishReason ? { finishReason } : {}) },
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
        throw new Error(`LLM request timed out after ${formatTimeoutLimit(timeoutMs)} at ${this.baseUrl}/chat/completions`);
      }
      throw asDroppedConnection(error, `${this.baseUrl}/chat/completions`) ?? error;
    } finally {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
    if (!response.ok) throw httpError(response.status, responseBody, model ?? this.model, this.baseUrl);

    return noteTruncation(parseCompletionBody(responseBody, `model "${model ?? this.model}" at ${this.baseUrl}/chat/completions`), {
      model: model ?? this.model,
      baseUrl: this.baseUrl,
      maxTokens,
    });
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
    const clock = firstTokenClock();
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
      if (!response.ok) throw httpError(response.status, await response.text(), model ?? this.model, this.baseUrl);
      const where = `model "${model ?? this.model}" at ${this.baseUrl}/chat/completions`;
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body || !/event-stream/i.test(contentType)) {
        const result = parseCompletionBody(await response.text(), where);
        if (result.content) onChunk(result.content);
        return noteTruncation(result, { model: model ?? this.model, baseUrl: this.baseUrl, maxTokens });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let usage: unknown;
      let finishReason: string | undefined;
      let sawDone = false;
      const handleLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") sawDone = true;
        if (!data || data === "[DONE]") return;
        let payload: {
          choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: unknown;
          error?: { message?: string } | string;
        };
        try {
          payload = JSON.parse(data);
        } catch (cause) {
          // Keep-alives are ":" comment lines and never reach here. A
          // `data:` frame that is not JSON lost part of the reply: skipping
          // it would return a reply with a hole as a success (D2).
          throw new LlmMalformedResponseError(`LLM stream sent a malformed frame for ${where}: ${data.slice(0, 120)}`, { cause, partial: content });
        }
        if (payload.error) {
          const message = typeof payload.error === "string" ? payload.error : payload.error.message ?? "unknown error";
          throw new Error(`LLM stream error for model "${model ?? this.model}" at ${this.baseUrl}/chat/completions: ${message.slice(0, 500)}`);
        }
        if (payload.usage) usage = payload.usage;
        if (payload.choices?.[0]?.finish_reason) finishReason = payload.choices[0].finish_reason;
        const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
        if (delta) {
          clock.mark();
          content += delta;
          onChunk(delta);
        }
      };
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw asDroppedConnection(error, `${this.baseUrl}/chat/completions`, content) ?? error;
        }
        const { value, done } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
      if (!finishReason && !sawDone) {
        // The body ended cleanly but the reply never said it was done: a
        // cut stream, not an answer (D2). The partial text rides along.
        throw new LlmIncompleteResponseError(
          `LLM stream ended before the reply finished (no finish_reason, no [DONE]) for ${where}`,
          { partial: content }
        );
      }
      return noteTruncation(
        { content, ...normalizeOpenAiUsage(usage), ...clock.fields(), ...(finishReason ? { finishReason } : {}) },
        { model: model ?? this.model, baseUrl: this.baseUrl, maxTokens }
      );
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
        if (opts?.signal?.aborted) {
          throw new Error(`LLM request aborted by caller at ${this.baseUrl}/chat/completions`);
        }
        throw new Error(`LLM request timed out after ${formatTimeoutLimit(timeoutMs)} at ${this.baseUrl}/chat/completions`);
      }
      throw asDroppedConnection(error, `${this.baseUrl}/chat/completions`) ?? error;
    } finally {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * The error for a non-2xx answer. A context-window overflow gets its own
 * class (D2); the message keeps the "(NNN)" status and provider text.
 */
function httpError(status: number, body: string, model: string, baseUrl: string): Error {
  const details = body.trim().slice(0, 500);
  const message = `LLM request failed (${status}) for model "${model}" at ${baseUrl}/chat/completions${details ? `: ${details}` : ""}`;
  if (status >= 400 && status < 500 && isContextOverflowText(details)) {
    return new LlmContextOverflowError(`${message} [context overflow: the request is longer than the model's context window]`, {
      status,
      contextLimit: contextLimitFromText(details),
    });
  }
  return new Error(message);
}

/**
 * Parse a /chat/completions body: one JSON object, or SSE lines from a
 * server that streams even without `stream: true`. A body that is neither
 * (cut mid-way, HTML, garbage) is an error, never an empty success (D2).
 */
function parseCompletionBody(responseBody: string, where = "the model"): LLMResult {
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
    const frames = normalizedBody.split(/\r?\n/).filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]");
    if (frames.length === 0) {
      throw new LlmMalformedResponseError(
        `LLM response body is not valid JSON for ${where} (${normalizedBody.length} bytes, cut or not a completion): ${normalizedBody.trim().slice(0, 120)}`,
        { cause: error }
      );
    }
    const content = frames
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.slice(5).trim());
        } catch (cause) {
          throw new LlmMalformedResponseError(`LLM response sent a malformed frame for ${where}: ${line.slice(5, 125).trim()}`, { cause });
        }
        const payload = parsed as {
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
