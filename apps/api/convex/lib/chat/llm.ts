/**
 * Backend chat LLM client: one streaming completion against an
 * OpenAI-compatible or Anthropic endpoint, plus config resolution from the
 * shared provider pool (llmResolver) with the env-var global fallback.
 */
import {
  pickPrimaryConnection,
  resolveConnectionKey,
  type PoolConnectionPayload,
} from "../llmResolver";

import { getGlobalLLMConfig, type LlmEndpointConfig } from "../llmConfig";

/** Endpoint + credentials for one chat completion. */
export type ChatLlmConfig = LlmEndpointConfig;
export { getGlobalLLMConfig };

interface StreamChunk {
  content: string;
  reasoning: string;
}

export interface CompleteResult {
  content: string;
  reasoning: string;
  reasoningDurationMs: number;
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

export async function completeWithAgent(
  system: string,
  history: { role: string; content: string }[],
  globalConfig: ChatLlmConfig,
  onChunk?: (partial: StreamChunk) => void,
): Promise<CompleteResult> {
  const { provider, model, baseUrl, apiKey } = globalConfig;
  if (!apiKey) throw new Error("No LLM API key configured. Add a provider in Settings (LLM) or set LLM_API_KEY in Convex env");

  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const doFetch = async (url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> => {
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
        throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const startedAt = Date.now();
  const finish = (content: string, reasoning: string): CompleteResult => {
    onChunk?.({ content, reasoning });
    return { content, reasoning, reasoningDurationMs: reasoning ? Date.now() - startedAt : 0 };
  };
  // Stream the SSE body incrementally so the UI sees tokens as they arrive.
  // The previous implementation buffered the whole body with res.text()
  // first, which made the "streaming" patch the message only after the LLM
  // finished — the bubble sat empty (avatar + name only) until a refresh.
  const consumeSse = async (
    res: Response,
    onDataLine: (payload: string) => void,
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
    // Bound the whole stream so a hung provider cannot stall the action
    // past the Convex timeout (which leaves the bubble on "Thinking").
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("LLM stream timed out (120s)");
      const { done, value } = await reader.read();
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

  if (provider === "openai" || provider === "openai-compatible") {
    const base = baseUrl.replace(/\/$/, "");
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Non-streaming fallback (some proxies ignore stream:true).
      const text = await res.text();
      const normalized = text.replace(/(?:\r?\n)?data:\s*\[DONE\]\s*$/, "").trim();
      if (!normalized) return finish("", "");
      try {
        const data: any = JSON.parse(normalized);
        const c = data.choices?.[0]?.message?.content;
        // Never use reasoning trace as user-facing answer.
        if (typeof c === "string" && c.trim()) return finish(c, "");
        return finish(c ?? "", "");
      } catch {
        const parts: string[] = [];
        let reasoning = "";
        for (const line of normalized.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const d: any = JSON.parse(payload);
            const delta = d.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string") parts.push(delta.content);
            reasoning += reasoningDelta(delta);
          } catch {}
        }
        if (parts.length) return finish(parts.join(""), reasoning);
        throw new Error(`LLM returned non-JSON response`);
      }
    }
    let content = "";
    let reasoning = "";
    const raw = await consumeSse(res, (payload) => {
      try {
        const d: any = JSON.parse(payload);
        const delta = d.choices?.[0]?.delta ?? {};
        if (typeof delta.content === "string") content += delta.content;
        reasoning += reasoningDelta(delta);
        onChunk?.({ content, reasoning });
      } catch {}
    });
    if (!content && !reasoning) {
      const fallback = parseJsonFallback(raw);
      content = fallback.content;
      reasoning = fallback.reasoning;
    }
    return finish(content, reasoning);
  }

  // anthropic
  const base = baseUrl.replace(/\/$/, "");
  const res = await doFetch(`${base}/messages`, {
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
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data: any = await res.json();
    return finish(
      (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      "",
    );
  }
  let content = "";
  let reasoning = "";
  const raw = await consumeSse(res, (payload) => {
    try {
      const d: any = JSON.parse(payload);
      if (d.type === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
        content += d.delta.text;
      }
      if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta" && typeof d.delta.thinking === "string") {
        reasoning += d.delta.thinking;
      }
      onChunk?.({ content, reasoning });
    } catch {}
  });
  if (!content && !reasoning) {
    const fallback = parseJsonFallback(raw);
    content = fallback.content;
    reasoning = fallback.reasoning;
  }
  return finish(content, reasoning);
}

/**
 * Resolve the chat LLM config from the shared provider pool (llmResolver).
 * Respects per-agent assignment when the agent carries one (llmProviderId +
 * llmModelId): that connection+model wins; otherwise fall back to the primary
 * connection (lowest priority with an available model). The key is decrypted
 * here on the backend for the backend's own call — a decryption failure is a
 * hard error naming the provider — with the connection's `apiKeyEnv` env var
 * as fallback.
 */
export async function resolveConfigFromProviders(
  providers: PoolConnectionPayload[] | undefined,
  fallback: ChatLlmConfig,
  agent?: { llmProviderId?: string; llmModelId?: string; llmFallbackProviderId?: string; llmFallbackModelId?: string; llmSelectionPolicy?: string }
): Promise<ChatLlmConfig> {
  if (providers && agent?.llmProviderId) {
    const conn = providers.find((p) => String(p._id) === String(agent.llmProviderId));
    if (conn) {
      const model =
        conn.models.find((m) => String(m._id) === String(agent.llmModelId)) ??
        conn.models.find((m) => m.isAvailable) ??
        conn.models[0];
      if (model) {
        const key = await resolveConnectionKey(conn);
        return {
          provider: conn.provider.toLowerCase(),
          model: model.modelId,
          baseUrl: conn.baseUrl,
          apiKey: key || fallback.apiKey,
        };
      }
    }
  }
  const pick = providers ? pickPrimaryConnection(providers) : null;
  if (pick) {
    const key = await resolveConnectionKey(pick.connection);
    return {
      provider: pick.connection.provider.toLowerCase(),
      model: pick.model.modelId,
      baseUrl: pick.connection.baseUrl,
      apiKey: key || fallback.apiKey,
    };
  }
  return fallback;
}
