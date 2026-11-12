import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, type LLMProvider } from "@/llm";
import { isTransientLlmError, LlmConcurrencyGate, runLlmCall } from "@/effects/llmCall";
import { classifyProviderError } from "@/utils/stallDetector";
import { cooldownForFailure } from "@/api/convex/lib/llmRotation";
import { isContextOverflowError, isIncompleteResponseError, LlmConnectionError, LlmMalformedResponseError, partialTextOf } from "@/llm/errors";
import { startMockLlm, type MockRule } from "../../../scripts/mock-llm/server";

/**
 * How the worker handles each wire fault of the mock LLM TODAY, through the
 * real OpenAI-compatible provider and the Effect retry (runLlmCall).
 *
 * D1 pinned the mishandlings as "[open bug D2]"; D2 flipped them: a dropped
 * stream is a classified connection failure with a human message, a
 * malformed frame or cut body is an error (retried by runLlmCall), a stream
 * with no finish_reason and no [DONE] is incomplete (never an answer), and a
 * context overflow has its own class and is shrunk and retried, bounded
 * (docs/mock-fixtures.md, "Wire faults").
 */
const REPLY = "The quick brown fox jumps over the lazy dog, then naps in the sun all afternoon.";
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (servers.length) await servers.pop()!.close();
});

async function mock(rules: Array<Omit<MockRule, "id"> & { id?: string }>) {
  const server = await startMockLlm({
    speed: 0,
    quiet: true,
    script: { rules: rules.map((r, i) => ({ id: `r${i}`, reply: REPLY, ...r })), fallback: "fallback" },
  });
  servers.push(server);
  return { server, provider: new OpenAICompatibleProvider("k", "mock/default", server.url) };
}

const ask = [{ role: "user" as const, content: "hi" }];
const gate = () => new LlmConcurrencyGate(4);

describe("provider: each fault on the wire", () => {
  it("partial_disconnect: undici's bare 'terminated' becomes a classified, retryable connection failure with a human message", async () => {
    const { provider } = await mock([{ fault: "partial_disconnect", faultAfterChunks: 3 }]);
    const chunks: string[] = [];
    const error = await provider.stream(ask, (d) => chunks.push(d)).catch((e) => e);
    expect(error).toBeInstanceOf(LlmConnectionError);
    expect(error.message).not.toBe("terminated");
    expect(error.message).toMatch(/^LLM connection closed mid-reply \(other side closed\) at http/);
    expect(chunks.join("").length).toBeGreaterThan(0); // the half reply already reached onChunk
    expect(partialTextOf(error)).toBe(chunks.join(""));
    expect(isTransientLlmError(error)).toBe(true);
    expect(classifyProviderError(error)).toBe("connection");
  });

  it("connection_reset rejects 'fetch failed' and is classified as a connection failure", async () => {
    const { provider } = await mock([{ fault: "connection_reset" }]);
    const error = await provider.stream(ask, () => {}).catch((e) => e);
    expect(error.message).toBe("fetch failed");
    expect(classifyProviderError(error)).toBe("connection");
  });

  it("stall is cut by the per-call timeout (stream and complete), reported as a timeout, not a cancel", async () => {
    const { provider } = await mock([{ fault: "stall", faultAfterChunks: 2 }]);
    const started = Date.now();
    const streamed = await provider.stream(ask, () => {}, undefined, { timeoutMs: 250 }).catch((e) => e);
    expect(streamed.message).toMatch(/^LLM request timed out after 250ms at /); // never "after 0s"
    expect(Date.now() - started).toBeLessThan(5_000);
    const completed = await provider.complete(ask, undefined, { timeoutMs: 250 }).catch((e) => e);
    expect(completed.message).toMatch(/^LLM request timed out after/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await provider.stream(ask, () => {}, undefined, { timeoutMs: 5_000, signal: controller.signal }).catch((e) => e);
    expect(cancelled.message).toMatch(/aborted by caller/);
  });

  it("malformed_chunk: the broken frame fails the call (retryable), never a reply with a hole", async () => {
    const { provider } = await mock([{ fault: "malformed_chunk", faultAfterChunks: 2 }]);
    const error = await provider.stream(ask, () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(LlmMalformedResponseError);
    expect(error.message).toMatch(/malformed frame/);
    expect(REPLY.startsWith(partialTextOf(error))).toBe(true);
    expect(isTransientLlmError(error)).toBe(true);
  });

  it("malformed / cut non-stream body: an error, never an empty success", async () => {
    const { provider } = await mock([{ fault: "malformed_chunk" }]);
    const error = await provider.complete(ask).catch((e) => e);
    expect(error).toBeInstanceOf(LlmMalformedResponseError);
    expect(error.message).toMatch(/not valid JSON/);
    expect(isTransientLlmError(error)).toBe(true);
  });

  it("stream_eof: a stream with no finish_reason and no [DONE] is incomplete, with the partial text attached", async () => {
    const { provider } = await mock([{ fault: "stream_eof", faultAfterChunks: 3 }]);
    const error = await provider.stream(ask, () => {}).catch((e) => e);
    expect(isIncompleteResponseError(error)).toBe(true);
    expect(error.message).toMatch(/ended before the reply finished/);
    expect(error.partial.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(error.partial) && error.partial !== REPLY).toBe(true);
  });

  it.each(["openai", "deepseek", "anthropic"] as const)(
    "context_overflow (%s wording): its own class, not transient, never a provider failure or a cooldown",
    async (overflowWording) => {
      const { server, provider } = await mock([{ fault: "context_overflow", overflowWording }]);
      const error = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() }).catch((e) => e);
      expect(error.message).toMatch(/LLM request failed \(400\)/);
      expect(error.message).toMatch(/maximum context length|prompt is too long/);
      expect(isContextOverflowError(error)).toBe(true);
      expect(error.kind).toBe("context_overflow"); // the typed error survives the Effect retry
      expect(server.calls).toHaveLength(1);
      expect(isTransientLlmError(error)).toBe(false);
      expect(classifyProviderError(error)).toBeNull();
      expect(cooldownForFailure(error)).toEqual({ cooldownMs: 0, kind: "context_overflow" });
    }
  );
});

describe("runLlmCall (Effect retry) against the faults", () => {
  it("a 503 burst shorter than the retries recovers on the same handle", async () => {
    const { server, provider } = await mock([{ fault: "server_error", times: 2 }, {}]);
    const result = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() });
    expect(result.content).toBe(REPLY);
    expect(server.calls.map((c) => c.status)).toEqual([503, 503, 200]);
  });

  it("a 503 burst as long as the retries fails with the 5xx, classified server_error", async () => {
    const { server, provider } = await mock([{ fault: "server_error", times: 3 }, {}]);
    const error = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() }).catch((e) => e);
    expect(error.message).toMatch(/\(503\)/);
    expect(classifyProviderError(error)).toBe("server_error");
    expect(server.calls).toHaveLength(3);
  });

  it("a cut non-stream body (malformed) is retried and the second answer is whole", async () => {
    const { server, provider } = await mock([{ fault: "malformed_chunk", times: 1 }, {}]);
    const result = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() });
    expect(result.content).toBe(REPLY);
    expect(server.calls.map((c) => c.fault ?? "ok")).toEqual(["malformed_chunk", "ok"]);
  });

  it("a dropped body (partial_disconnect) is retried and the second answer is whole", async () => {
    const { server, provider } = await mock([{ fault: "partial_disconnect", times: 1 }, {}]);
    const result = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() });
    expect(result.content).toBe(REPLY);
    expect(server.calls.map((c) => c.fault ?? "ok")).toEqual(["partial_disconnect", "ok"]);
  });
});

