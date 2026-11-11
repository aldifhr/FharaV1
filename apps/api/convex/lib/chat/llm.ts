/**
 * Backend chat LLM client: one streaming completion against an
 * OpenAI-compatible or Anthropic endpoint, plus config resolution from the
 * shared provider pool (llmResolver) with the env-var global fallback.
 */
import { withoutOpencode } from "../opencodeProvider";
import { resolveConnectionKey, type PoolConnectionPayload, type PoolModelPayload } from "../llmResolver";

import { getGlobalLLMConfig, type LlmEndpointConfig } from "../llmConfig";
import { applySelectionMode, orderPoolPairs } from "../llmOrder";
import { cooldownForFailure, errorStatus, isEmptyCompletion, StickyRotationCursor } from "../llmRotation";
import { describeEndpoint, endpointCandidates, llmHttpError, wireProtocolFor } from "./llmEndpoint";
import { ChatStreamError, chatStreamLimits, readWithLimits, withPartial, type ChatStreamLimits, type PartialReply } from "./streamLimits";
import { mergeRawUsage, normalizeAnthropicUsage, normalizeOpenAiUsage, type UsageBreakdown } from "../usageLedger";
import { asDroppedConnection, formatTimeoutLimit } from "../llmWireErrors";

/**
 * Endpoint + credentials for one chat completion. `fallbacks` is the rest
 * of the ordered pool (resolveConfigFromProviders): completeWithAgent
 * walks it when the first config fails or answers with nothing.
 * `connectionId` names the pool connection (for the in-memory cooldown).
 */
/** Registry identity + pricing of the pair a config serves (plan 040 P3 usage ledger). */
type ServedIdentity = {
  connectionId?: string;
  modelRowId?: string;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
};

export type ChatLlmConfig = LlmEndpointConfig & ServedIdentity & {
  fallbacks?: (LlmEndpointConfig & ServedIdentity)[];
};
export { getGlobalLLMConfig };

/** Per-call options: sampling temperature (unset = provider default) and stream limits (tests; default from config). */
export type ChatCallOptions = { temperature?: number; limits?: ChatStreamLimits };

interface StreamChunk {
  content: string;
  reasoning: string;
}

export interface CompleteResult {
  content: string;
  reasoning: string;
  reasoningDurationMs: number;
  /** Provider-reported usage (plan 040 P3); absent when the endpoint sent none. */
  usage?: UsageBreakdown;
  /** Wall time of the attempt that answered. */
  durationMs?: number;
  /** The config (connection + model) that answered, for the usage ledger. */
  servedBy?: LlmEndpointConfig & ServedIdentity;
  /** The model stopped at its output limit (finish_reason "length" / stop_reason "max_tokens"). */
  truncated?: boolean;
}

/** The served config without its key (never carried past the call). */
function servedIdentity(config: LlmEndpointConfig & ServedIdentity): LlmEndpointConfig & ServedIdentity {
  return { ...config, apiKey: "" };
}

/**
 * Reasoning text of one streamed delta. Some OpenAI-compatible gateways send
 * the same text in BOTH `reasoning_content` and `reasoning`; adding both
 * doubled every sentence of the "Thought" trace. Take one field only.
 */
export function reasoningDelta(delta: { reasoning_content?: unknown; reasoning?: unknown }): string {
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  return "";
}

/**
 * Backend-side cooldown per connection (best effort: per Convex isolate,
 * like the worker's in-memory circuit). A 429 / rate-limit answer backs
 * the connection off exponentially, an auth failure for 2 min, a 5xx or
 * network failure for 30 s; a request-scoped 4xx never cools down.
 */
const chatCooldown = new Map<string, { until: number; level: number }>();
const chatRotation = new StickyRotationCursor(1, "chat");

function coolingDown(connectionId: string | undefined, now: number): boolean {
  if (!connectionId) return false;
  const entry = chatCooldown.get(connectionId);
  return Boolean(entry && entry.until > now);
}

function recordChatFailure(connectionId: string | undefined, error: unknown): void {
  if (!connectionId) return;
  const previous = chatCooldown.get(connectionId);
  const cooldown = cooldownForFailure(error, previous?.level ?? 0);
  if (cooldown.cooldownMs <= 0) return;
  chatCooldown.set(connectionId, {
    until: Date.now() + cooldown.cooldownMs,
    level: cooldown.backoffLevel ?? previous?.level ?? 0,
  });
}

/** Test hook: forget every cooldown and the rotation cursor. */
export function resetChatRouting(): void {
  chatCooldown.clear();
  chatRotation.reset();
}

/** A request-scoped client error: the next model would get the same request rejected. */
function isRequestScopedError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 400 || status === 413 || status === 422;
}

/**
 * One completion over the config's chain: the config itself, then its
 * `fallbacks` in order. Moves on when a call fails (except a
 * request-scoped 4xx) or answers with nothing, as long as no text has
 * been streamed to the caller yet. Connections in cooldown are tried last.
 */
export async function completeWithAgent(
  system: string,
  history: { role: string; content: string }[],
  globalConfig: ChatLlmConfig,
  onChunk?: (partial: StreamChunk) => void,
  opts?: ChatCallOptions,
): Promise<CompleteResult> {
  const { fallbacks, ...first } = globalConfig;
  if (!fallbacks || fallbacks.length === 0) {
    const only = await completeOnce(system, history, first, onChunk, opts);
    return { ...only, servedBy: servedIdentity(first) };
  }
  const now = Date.now();
  const chain = [first, ...fallbacks];
  const ready = chain.filter((c) => !coolingDown(c.connectionId, now));
  const cooling = chain.filter((c) => coolingDown(c.connectionId, now));
  const ordered = [...ready, ...cooling];
  const errors: string[] = [];
  for (const [index, config] of ordered.entries()) {
    let streamed = false;
    const relay = onChunk
      ? (partial: StreamChunk) => {
          if (partial.content) streamed = true;
          onChunk(partial);
        }
      : undefined;
    try {
      const result = await completeOnce(system, history, config, relay, opts);
      if (isEmptyCompletion(result) && index < ordered.length - 1) {
        errors.push(`${describeEndpoint(config)} model "${config.model}" returned an empty response`);
        continue;
      }
      return { ...result, servedBy: servedIdentity(config) };
    } catch (error) {
      recordChatFailure(config.connectionId, error);
      if (streamed || isRequestScopedError(error) || index === ordered.length - 1) {
        if (errors.length === 0) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const combined = `${errors[0]} — fallback also failed: ${[...errors.slice(1), message].join(" | ")}`;
        // A cut stream keeps its partial text through the wrap.
        if (error instanceof ChatStreamError) throw new ChatStreamError(error.kind, combined, error.partial);
        throw new Error(combined);
      }
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors.join(" | ") || "LLM request failed");
}

async function completeOnce(
  system: string,
  history: { role: string; content: string }[],
  globalConfig: LlmEndpointConfig,
  onChunk?: (partial: StreamChunk) => void,
  /** Optional sampling temperature; unset = provider default. */
  opts?: ChatCallOptions,
): Promise<CompleteResult> {
  const temperature =
    typeof opts?.temperature === "number" && Number.isFinite(opts.temperature)
      ? Math.min(2, Math.max(0, opts.temperature))
      : undefined;
  const { provider, model, baseUrl, apiKey } = globalConfig;
  if (!apiKey) throw new Error("No LLM API key configured. Add a provider in Settings (LLM) or set LLM_API_KEY in Convex env");

  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // Idle + total limits (lib/chat/streamLimits.ts). The wait for the
  // response headers is bounded by the idle window too.
  const limits = opts?.limits ?? chatStreamLimits();
  const doFetch = async (url: string, init: RequestInit, timeoutMs = limits.idleMs): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok && res.status >= 500 && timeoutMs > 0) {
        // One lightweight retry for transient 5xx (no backoff explosion).
        const res2 = await fetch(url, { ...init, signal: ctrl.signal });
        if (res2.ok) return res2;
        return res2;
      }
      return res;
    } catch (error) {
      // The gateway sometimes takes longer than the old 30s to answer; a
      // raw AbortError reads as "This operation was aborted" in the UI.
      if (ctrl.signal.aborted) {
        throw new Error(`LLM request timed out after ${formatTimeoutLimit(timeoutMs)} (${describeEndpoint(globalConfig)})`);
      }
      // Network failure ("fetch failed"): name the provider kind and host.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`LLM request failed: ${reason} (${describeEndpoint(globalConfig)}, model "${model}")`);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * POST to the first candidate URL; on a 404 try the next one (base URL
   * with / without `/v1`, see llmEndpoint.ts). A non-2xx answer throws an
   * error naming the status, provider kind, host and model (never the key).
   */
  const post = async (suffix: "/chat/completions" | "/messages", init: RequestInit): Promise<Response> => {
    const candidates = endpointCandidates(baseUrl, suffix);
    const attempted: string[] = [];
    for (const [index, url] of candidates.entries()) {
      attempted.push(url);
      const res = await doFetch(url, init);
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      if (res.status === 404 && index < candidates.length - 1) continue;
      throw llmHttpError(res.status, globalConfig, body, attempted);
    }
    // Unreachable: the loop always returns or throws.
    throw new Error(`LLM request failed (${describeEndpoint(globalConfig)})`);
  };

  const startedAt = Date.now();
  const finish = (content: string, reasoning: string, usage?: UsageBreakdown, truncated = false): CompleteResult => {
    onChunk?.({ content, reasoning });
    const reported = usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? usage : undefined;
    return {
      content,
      reasoning,
      reasoningDurationMs: reasoning ? Date.now() - startedAt : 0,
      durationMs: Date.now() - startedAt,
      ...(reported ? { usage: reported } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  };
  // Stream the SSE body incrementally so the UI sees tokens as they arrive.
  // The previous implementation buffered the whole body with res.text()
  // first, which made the "streaming" patch the message only after the LLM
  // finished — the bubble sat empty (avatar + name only) until a refresh.
  const consumeSse = async (
    res: Response,
    onDataLine: (payload: string) => void,
    partialNow: () => PartialReply,
  ): Promise<string> => {
    let raw = "";
    const reader = res.body?.getReader();
    if (!reader) {
      // No streaming support: fall back to reading the whole body.
      raw = await res.text();
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        onDataLine(payload);
      }
      return raw;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    // Idle timeout (no chunk for limits.idleMs) plus a generous total cap
    // under the Convex action limit. The old fixed 120 s total cut slow
    // models that were still streaming (live test 2026-11-11). A cut keeps
    // the text so far on the error (ChatStreamError.partial).
    const deadline = startedAt + limits.totalMs;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await readWithLimits(() => reader.read(), limits, deadline);
      } catch (error) {
        reader.cancel().catch(() => undefined);
        // undici's bare "terminated" (socket closed mid-body) is named as a
        // dropped connection before it is wrapped (DeepSeek Harness D2).
        throw withPartial(asDroppedConnection(error, `${describeEndpoint(globalConfig)}, model "${model}"`) ?? error, partialNow());
      }
      const { done, value } = next;
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        onDataLine(payload);
      }
    }
    // Flush a final line that arrived without a trailing newline.
    if (buffer.startsWith("data:")) {
      const payload = buffer.slice(5).trim();
      if (payload && payload !== "[DONE]") onDataLine(payload);
    }
    return raw;
  };
  // Some gateways return a plain JSON body with a `text/event-stream` header.
  // SSE parsing then yields no content; fall back to JSON.
  const parseJsonFallback = (raw: string): { content: string; reasoning: string } => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return { content: "", reasoning: "" };
    try {
      const data: any = JSON.parse(trimmed);
      const message = data.choices?.[0]?.message ?? {};
      const content = typeof message.content === "string" ? message.content : "";
      const reasoning =
        typeof message.reasoning === "string"
          ? message.reasoning
          : Array.isArray(message.reasoning_details)
            ? message.reasoning_details.map((d: any) => (typeof d === "string" ? d : d?.text ?? "")).join("")
            : "";
      return { content, reasoning };
    } catch {
      return { content: "", reasoning: "" };
    }
  };

  if (wireProtocolFor(provider, baseUrl) === "openai") {
    const res = await post("/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        ...(temperature !== undefined ? { temperature } : {}),
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Non-streaming fallback (some proxies ignore stream:true).
      const text = await res.text();
      const normalized = text.replace(/(?:\r?\n)?data:\s*\[DONE\]\s*$/, "").trim();
      if (!normalized) return finish("", "");
      try {
        const data: any = JSON.parse(normalized);
        const c = data.choices?.[0]?.message?.content;
        const usage = normalizeOpenAiUsage(data.usage);
        const cut = data.choices?.[0]?.finish_reason === "length";
        // Never use reasoning trace as user-facing answer.
        if (typeof c === "string" && c.trim()) return finish(c, "", usage, cut);
        return finish(c ?? "", "", usage, cut);
      } catch {
        const parts: string[] = [];
        let reasoning = "";
        let sseUsage: unknown;
        for (const line of normalized.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const d: any = JSON.parse(payload);
            if (d.usage) sseUsage = d.usage;
            const delta = d.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string") parts.push(delta.content);
            reasoning += reasoningDelta(delta);
          } catch {}
        }
        if (parts.length) return finish(parts.join(""), reasoning, normalizeOpenAiUsage(sseUsage));
        throw new Error(`LLM returned non-JSON response`);
      }
    }
    let content = "";
    let reasoning = "";
    let streamUsage: unknown;
    let truncated = false;
    let finished = false;
    let badFrames = 0;
    const raw = await consumeSse(res, (payload) => {
      let d: any;
      try {
        d = JSON.parse(payload);
      } catch {
        badFrames++;
        return;
      }
      // Usage rides on the last chunk when the server sends it
      // (stream_options is not sent: strict servers reject it).
      if (d.usage) streamUsage = d.usage;
      if (d.choices?.[0]?.finish_reason === "length") truncated = true;
      if (d.choices?.[0]?.finish_reason) finished = true;
      const delta = d.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      reasoning += reasoningDelta(delta);
      onChunk?.({ content, reasoning });
    }, () => ({ content, reasoning }));
    if (!content && !reasoning && !badFrames) {
      const fallback = parseJsonFallback(raw);
      content = fallback.content;
      reasoning = fallback.reasoning;
      if (content || reasoning) finished = true; // one whole JSON body
      if (streamUsage === undefined) streamUsage = jsonUsage(raw);
    }
    assertWholeStream(content, reasoning, { finished: finished || /(?:^|\n)data:\s*\[DONE\]/.test(raw), badFrames });
    return finish(content, reasoning, normalizeOpenAiUsage(streamUsage), truncated);
  }

  // anthropic
  const res = await post("/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: system || undefined,
      messages,
      stream: true,
      ...(temperature !== undefined ? { temperature: Math.min(1, temperature) } : {}),
    }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data: any = await res.json();
    return finish(
      (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      "",
      normalizeAnthropicUsage(data.usage),
      data.stop_reason === "max_tokens",
    );
  }
  let content = "";
  let reasoning = "";
  let rawUsage: Record<string, unknown> | undefined;
  let truncated = false;
  let finished = false;
  let badFrames = 0;
  const raw = await consumeSse(res, (payload) => {
    let d: any;
    try {
      d = JSON.parse(payload);
    } catch {
      badFrames++;
      return;
    }
    if (d.type === "message_delta" && d.delta?.stop_reason === "max_tokens") truncated = true;
    if (d.type === "message_stop" || (d.type === "message_delta" && d.delta?.stop_reason)) finished = true;
    // Usage: input + cache counts on message_start, cumulative output on message_delta.
    if (d.type === "message_start") rawUsage = mergeRawUsage(rawUsage, d.message?.usage);
    if (d.type === "message_delta") rawUsage = mergeRawUsage(rawUsage, d.usage);
    if (d.type === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
      content += d.delta.text;
    }
    if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta" && typeof d.delta.thinking === "string") {
      reasoning += d.delta.thinking;
    }
    onChunk?.({ content, reasoning });
  }, () => ({ content, reasoning }));
  if (!content && !reasoning && !badFrames) {
    const fallback = parseJsonFallback(raw);
    content = fallback.content;
    reasoning = fallback.reasoning;
    if (content || reasoning) finished = true;
  }
  assertWholeStream(content, reasoning, { finished, badFrames });
  return finish(content, reasoning, normalizeAnthropicUsage(rawUsage), truncated);
}

/**
 * A stream is an answer only when it said it was done (finish_reason /
 * [DONE] / message_stop) and every frame parsed (DeepSeek Harness D2).
 * A malformed frame is an error, not a hole in the reply; a stream that
 * just stopped is incomplete. Both throw a ChatStreamError (kind
 * "malformed" / "incomplete") carrying the text so far, so the caller keeps
 * it as an interrupted reply, never a completed answer. A stream
 * with no text at all is left to the empty-completion rotation.
 */
function assertWholeStream(content: string, reasoning: string, state: { finished: boolean; badFrames: number }): void {
  if (state.badFrames > 0) {
    throw new ChatStreamError("malformed", "Reply stopped: the model sent a malformed part of the reply", { content, reasoning });
  }
  if (!state.finished && (content || reasoning)) {
    throw new ChatStreamError("incomplete", "Reply stopped: the model's stream ended before the reply finished", { content, reasoning });
  }
}

/** `usage` of a plain JSON body served under an event-stream header, if any. */
function jsonUsage(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed)?.usage;
  } catch {
    return undefined;
  }
}

type AgentLlmPrefs = {
  llmProviderId?: string;
  llmModelId?: string;
  llmFallbackProviderId?: string;
  llmFallbackModelId?: string;
  llmSelectionPolicy?: string;
};

type PoolPair = { connection: PoolConnectionPayload; model: PoolModelPayload };

/** The pair an agent assignment names (model row, else the connection's first available model). */
function assignedPair(
  providers: PoolConnectionPayload[],
  providerId: string | undefined,
  modelRowId: string | undefined
): PoolPair | null {
  if (!providerId) return null;
  const connection = providers.find((p) => String(p._id) === String(providerId));
  if (!connection) return null;
  const model =
    (modelRowId ? connection.models.find((m) => String(m._id) === String(modelRowId)) : undefined) ??
    connection.models.find((m) => m.isAvailable) ??
    connection.models[0];
  return model ? { connection, model } : null;
}

/**
 * The ordered candidate pairs for one call: the agent's assignment, its
 * fallback, then (unless the agent's policy is "fixed") the model list in
 * order, rotated in round robin. Same order as the worker resolver
 * (packages/worker/src/llm/resolver.ts) for a pool with an explicit order;
 * the parity test pins that. An empty value on the agent means "use the
 * global order".
 */
export function orderedChatPairs(
  providers: PoolConnectionPayload[] | undefined,
  agent?: AgentLlmPrefs,
  cursor: { next(size: number): number } = chatRotation
): PoolPair[] {
  if (!providers || providers.length === 0) return [];
  // Plan 038: OpenCode entries run only on the worker (tasks); the backend
  // cannot run the CLI, so chat walks the API models of the same list.
  const enabled = withoutOpencode(providers).filter((p) => p.isEnabled !== false);
  const out: PoolPair[] = [];
  const seen = new Set<string>();
  const push = (pair: PoolPair | null) => {
    if (!pair) return;
    const key = `${pair.connection._id}::${pair.model.modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(pair);
  };
  const ordered = orderPoolPairs(enabled);
  // An assignment is every listed model it names (one model, or all of the
  // connection's models when no model is set), in list order. A model the
  // list does not offer (unavailable / filtered) falls back to the
  // connection's first model, as chat always did.
  const assignment = (providerId?: string, modelRowId?: string) => {
    if (!providerId) return [];
    const listed = ordered.filter(
      (pair) =>
        String(pair.connection._id) === String(providerId) &&
        (!modelRowId || String(pair.model._id) === String(modelRowId))
    );
    if (listed.length > 0) return listed;
    const legacy = assignedPair(enabled, providerId, modelRowId);
    return legacy ? [legacy] : [];
  };
  for (const pair of assignment(agent?.llmProviderId, agent?.llmModelId)) push(pair);
  for (const pair of assignment(agent?.llmFallbackProviderId, agent?.llmFallbackModelId)) push(pair);
  if (agent?.llmSelectionPolicy === "fixed" && out.length > 0) return out;
  // An agent's own policy wins over the global mode, like in the worker.
  const mode = agent?.llmSelectionPolicy
    ? agent.llmSelectionPolicy === "round_robin"
      ? "round_robin"
      : "fallback"
    : enabled[0]?.selectionMode ?? "fallback";
  const pool = ordered.filter((pair) => !seen.has(`${pair.connection._id}::${pair.model.modelId}`));
  // Rotation applies to the pool part only: an explicit agent assignment
  // always goes first, exactly like the worker's tiers 0 and 1.
  for (const pair of out.length === 0 ? applySelectionMode(pool, mode, cursor) : pool) push(pair);
  return out;
}

async function pairConfig(pair: PoolPair, fallback: ChatLlmConfig): Promise<LlmEndpointConfig & ServedIdentity & { connectionId: string }> {
  const key = await resolveConnectionKey(pair.connection);
  return {
    provider: pair.connection.provider.toLowerCase(),
    model: pair.model.modelId,
    baseUrl: pair.connection.baseUrl,
    apiKey: key || fallback.apiKey,
    connectionId: String(pair.connection._id),
    // Plan 040 P3: registry identity + pricing for the chat usage ledger.
    ...(pair.model._id && !pair.model.legacy ? { modelRowId: String(pair.model._id) } : {}),
    ...(typeof pair.model.inputPricePer1k === "number" ? { inputPricePer1k: pair.model.inputPricePer1k } : {}),
    ...(typeof pair.model.outputPricePer1k === "number" ? { outputPricePer1k: pair.model.outputPricePer1k } : {}),
  };
}

/**
 * Resolve the chat LLM config from the shared provider pool: the first
 * candidate of orderedChatPairs, carrying the rest as `fallbacks` so
 * completeWithAgent fails over through the same ordered list the worker
 * uses. The key is decrypted here on the backend for the backend's own
 * call (a decryption failure is a hard error naming the provider), with
 * the connection's `apiKeyEnv` env var as fallback. An empty pool returns
 * the env config.
 */
export async function resolveConfigFromProviders(
  providers: PoolConnectionPayload[] | undefined,
  fallback: ChatLlmConfig,
  agent?: AgentLlmPrefs
): Promise<ChatLlmConfig> {
  const pairs = orderedChatPairs(providers, agent);
  if (pairs.length === 0) return fallback;
  const configs = await Promise.all(pairs.map((pair) => pairConfig(pair, fallback)));
  const [primary, ...rest] = configs;
  return rest.length > 0 ? { ...primary, fallbacks: rest } : primary;
}

/**
 * The agent's configured fallback (llmFallbackProviderId + optional
 * llmFallbackModelId) as a concrete config, or null when none is set or the
 * connection is not in the enabled pool.
 */
export async function resolveFallbackConfigFromProviders(
  providers: PoolConnectionPayload[] | undefined,
  fallback: ChatLlmConfig,
  agent?: AgentLlmPrefs
): Promise<ChatLlmConfig | null> {
  if (!providers) return null;
  const pair = assignedPair(
    withoutOpencode(providers).filter((p) => p.isEnabled !== false),
    agent?.llmFallbackProviderId,
    agent?.llmFallbackModelId
  );
  return pair ? await pairConfig(pair, fallback) : null;
}

/**
 * The whole ordered chain as separate configs (no nested `fallbacks`),
 * in the order they should be tried: the agent's primary, its fallback,
 * then the rest of the model list.
 */
export async function resolveConfigChain(
  providers: PoolConnectionPayload[] | undefined,
  fallback: ChatLlmConfig,
  agent?: AgentLlmPrefs
): Promise<ChatLlmConfig[]> {
  const { fallbacks, ...primary } = await resolveConfigFromProviders(providers, fallback, agent);
  return [primary, ...(fallbacks ?? [])];
}

/**
 * completeWithAgent over a config chain: the first config that answers
 * wins. When every config fails, the error names each attempt (kind @ host,
 * never the key).
 */
export async function completeWithFallback(
  system: string,
  history: { role: string; content: string }[],
  configs: ChatLlmConfig[],
  onChunk?: (partial: StreamChunk) => void,
  opts?: ChatCallOptions
): Promise<CompleteResult & { config: ChatLlmConfig; fellBack: boolean; primaryError?: string }> {
  if (configs.length === 0) throw new Error("No LLM config to call");
  const errors: string[] = [];
  for (const [index, entry] of configs.entries()) {
    // Each entry is one attempt; a nested chain would repeat the pool.
    const { fallbacks: _nested, ...config } = entry;
    try {
      const result = await completeWithAgent(system, history, config, onChunk, opts);
      return { ...result, config, fellBack: index > 0, ...(errors[0] ? { primaryError: errors[0] } : {}) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length === 1) throw new Error(errors[0]);
  throw new Error(`${errors[0]} — fallback also failed: ${errors.slice(1).join(" | ")}`);
}
