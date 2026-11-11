import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, type LLMProvider } from "@/llm";
import { isTransientLlmError, LlmConcurrencyGate, runLlmCall } from "@/effects/llmCall";
import { classifyProviderError } from "@/utils/stallDetector";
import { isEmptyCompletion } from "@/api/convex/lib/llmRotation";
import { ApiLoopEngine } from "@/direct/apiLoopSession";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import { startMockLlm, type MockRule } from "../../../scripts/mock-llm/server";

/**
 * How the worker handles each wire fault of the mock LLM TODAY, through the
 * real OpenAI-compatible provider, the Effect retry (runLlmCall) and a
 * direct thread (ApiLoopEngine + ThreadRunner, which persists events).
 *
 * Tests marked [open bug D2] pin a mishandling as it is now, so the D2 fix
 * has to flip them on purpose (docs/mock-fixtures.md, "Wire faults").
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
  it("partial_disconnect rejects (undici 'terminated'); transient, but not classified as a connection failure [open bug D2]", async () => {
    const { provider } = await mock([{ fault: "partial_disconnect", faultAfterChunks: 3 }]);
    const chunks: string[] = [];
    const error = await provider.stream(ask, (d) => chunks.push(d)).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("terminated");
    expect(chunks.join("").length).toBeGreaterThan(0); // the half reply already reached onChunk
    expect(isTransientLlmError(error)).toBe(true);
    // The cause (UND_ERR_SOCKET "other side closed") is not looked at, so the
    // stall/health layer sees an unclassified failure instead of "connection".
    expect(classifyProviderError(error)).toBeNull();
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
    expect(streamed.message).toMatch(/^LLM request timed out after/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const completed = await provider.complete(ask, undefined, { timeoutMs: 250 }).catch((e) => e);
    expect(completed.message).toMatch(/^LLM request timed out after/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await provider.stream(ask, () => {}, undefined, { timeoutMs: 5_000, signal: controller.signal }).catch((e) => e);
    expect(cancelled.message).toMatch(/aborted by caller/);
  });

  it("malformed_chunk: the broken frame is skipped silently and the reply loses its text, yet finishes 'stop' [open bug D2]", async () => {
    const { provider } = await mock([{ fault: "malformed_chunk", faultAfterChunks: 2 }]);
    const result = await provider.stream(ask, () => {});
    expect(result.finishReason).toBe("stop");
    expect(result.content).not.toBe(REPLY);
    expect(result.content.length).toBeLessThan(REPLY.length);
  });

  it("malformed / cut non-stream body: parsed as an empty success (only isEmptyCompletion catches it, and only with a next model)", async () => {
    const { provider } = await mock([{ fault: "malformed_chunk" }]);
    const result = await provider.complete(ask);
    expect(result.content).toBe("");
    expect(isEmptyCompletion(result)).toBe(true);
  });

  it("stream_eof: a stream with no finish_reason and no [DONE] is returned as a success with the partial text [open bug D2]", async () => {
    const { provider } = await mock([{ fault: "stream_eof", faultAfterChunks: 3 }]);
    const result = await provider.stream(ask, () => {});
    expect(result.finishReason).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(result.content) && result.content !== REPLY).toBe(true);
  });

  it.each(["openai", "deepseek", "anthropic"] as const)(
    "context_overflow (%s wording): a generic permanent 400, never retried, no overflow class [open bug D2]",
    async (overflowWording) => {
      const { server, provider } = await mock([{ fault: "context_overflow", overflowWording }]);
      const error = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() }).catch((e) => e);
      expect(error.message).toMatch(/LLM request failed \(400\)/);
      expect(error.message).toMatch(/maximum context length|prompt is too long/);
      expect(server.calls).toHaveLength(1);
      expect(isTransientLlmError(error)).toBe(false);
      expect(classifyProviderError(error)).toBeNull();
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

  it("a dropped body (partial_disconnect) is retried and the second answer is whole", async () => {
    const { server, provider } = await mock([{ fault: "partial_disconnect", times: 1 }, {}]);
    const result = await runLlmCall(provider, ask, undefined, { retries: 2, timeoutMs: 5_000, gate: gate() });
    expect(result.content).toBe(REPLY);
    expect(server.calls.map((c) => c.fault ?? "ok")).toEqual(["partial_disconnect", "ok"]);
  });
});

// ── a direct thread: what gets persisted ─────────────────────────────────

type Row = { type: string; payload: Record<string, unknown> };

/** In-memory DirectStore: the persisted events plus the hot stream rows. */
class Store implements DirectStore {
  events: Row[] = [];
  streams = new Map<string, string>();
  userMessage(text: string) {
    this.events.push({ type: "user.message", payload: { text } });
    return { seq: this.events.length, text };
  }
  async appendEvents(events: StoredEvent[], _state?: DirectStatePatch) {
    for (const e of events) this.events.push({ type: e.type, payload: e.payload });
    return events.map((_, i) => this.events.length - events.length + i + 1);
  }
  async flushStream(_seq: number, items: { itemId: string; text: string }[]) {
    for (const i of items) {
      this.streams.set(i.itemId, i.text);
    }
  }
  async clearStreams() {
    this.streams.clear();
  }
  async requestApproval(): Promise<never> {
    throw new Error("no approvals in the api loop");
  }
  async approvalState() {
    return null;
  }
  async cancelApproval() {}
  async loadEvents() {
    return this.events.map((e, i) => ({ type: e.type, sequence: i + 1, payload: e.payload }));
  }
  async recordUsage() {}
  texts() {
    return this.events.filter((e) => e.type === "assistant.text").map((e) => String(e.payload.text));
  }
  outcomes() {
    return this.events.filter((e) => e.type === "turn.completed").map((e) => String(e.payload.outcome));
  }
}

async function thread(provider: LLMProvider) {
  const store = new Store();
  const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine: new ApiLoopEngine({ provider, model: "mock/default" }), store, streamFlushMs: 5 });
  const turn = async (text: string) => {
    await runner.deliver(store.userMessage(text));
    await runner.idle();
    await runner.drain();
  };
  return { store, runner, turn };
}

describe("direct thread (api loop) against the faults", () => {
  it("partial_disconnect then success: the failed turn persists no half message, the next turn one complete reply", async () => {
    // A request whose history still carries the failed turn ("first") would match the second rule.
    const { server, provider } = await mock([{ fault: "partial_disconnect", faultAfterChunks: 4, times: 1 }, { match: ["first"], reply: "HISTORY KEPT THE FAILED TURN" }, {}]);
    const { store, runner, turn } = await thread(provider);
    await turn("first");
    expect(store.outcomes()).toEqual(["failed"]);
    expect(store.texts()).toEqual([]); // no half message persisted
    expect(store.streams.size).toBe(0); // the hot row is cleared with the turn
    await turn("second");
    expect(store.outcomes()).toEqual(["failed", "completed"]);
    expect(store.texts()).toEqual([REPLY]);
    // The failed turn is not in the history the next request carries.
    expect(server.calls.map((c) => c.rule)).toEqual(["r0", "r2"]);
    await runner.close();
  });

  it("the api loop does not retry a dropped stream itself: the user has to send again", async () => {
    const { server, provider } = await mock([{ fault: "partial_disconnect", times: 1 }, {}]);
    const { store, runner, turn } = await thread(provider);
    await turn("first");
    expect(server.calls).toHaveLength(1);
    const done = store.events.find((e) => e.type === "turn.completed")!;
    expect(String(done.payload.error)).toBe("terminated"); // a bare undici word reaches the thread [open bug D2]
    await runner.close();
  });

  it("stall: the turn is failed by the LLM timeout ceiling, with no reply persisted", async () => {
    vi.stubEnv("ORCHESTRATOR_LLM_TIMEOUT_MS", "300");
    const { provider } = await mock([{ fault: "stall", faultAfterChunks: 2 }]);
    const { store, runner, turn } = await thread(provider);
    await turn("first");
    expect(store.outcomes()).toEqual(["failed"]);
    expect(String(store.events.find((e) => e.type === "turn.completed")!.payload.error)).toMatch(/timed out/);
    expect(store.texts()).toEqual([]);
    await runner.close();
  });

  it("stream_eof: the half reply is persisted as a completed answer [open bug D2]", async () => {
    const { provider } = await mock([{ fault: "stream_eof", faultAfterChunks: 3 }]);
    const { store, runner, turn } = await thread(provider);
    await turn("first");
    expect(store.outcomes()).toEqual(["completed"]);
    expect(store.texts()).toHaveLength(1);
    expect(store.texts()[0]).not.toBe(REPLY);
    expect(REPLY.startsWith(store.texts()[0])).toBe(true);
    await runner.close();
  });

  it("malformed_chunk: a reply with a hole is persisted as a completed answer [open bug D2]", async () => {
    const { provider } = await mock([{ fault: "malformed_chunk", faultAfterChunks: 2 }]);
    const { store, runner, turn } = await thread(provider);
    await turn("first");
    expect(store.outcomes()).toEqual(["completed"]);
    expect(store.texts()[0]).not.toBe(REPLY);
    await runner.close();
  });

  it("context_overflow: the turn fails with the provider's 400 text and the thread is left as is (no prune, no retry) [open bug D2]", async () => {
    const { server, provider } = await mock([{ fault: "context_overflow", overflowWording: "deepseek" }]);
    const { store, runner, turn } = await thread(provider);
    await turn("first");
    expect(store.outcomes()).toEqual(["failed"]);
    expect(String(store.events.find((e) => e.type === "turn.completed")!.payload.error)).toMatch(/\(400\)[\s\S]*maximum context length/);
    expect(server.calls).toHaveLength(1);
    await runner.close();
  });
});
