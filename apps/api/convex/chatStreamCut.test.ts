// @vitest-environment node
/**
 * Chat stream limits against the mock LLM (scripts/mock-llm), streaming
 * real SSE over loopback through completeWithAgent (live test 2026-11-11:
 * a slow model cut at a fixed 120 s while it was still streaming).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "../../../scripts/mock-llm/server";
import { completeWithAgent, resetChatRouting } from "./lib/chat/llm";
import { ChatStreamError } from "./lib/chat/streamLimits";

const REPLY = "1. Personas. Priority colors: Low = gray, Medium = amber, High = orange, Urgent = red. Each is always paired with an icon and a label, never color alone. ".repeat(2);

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  vi.unstubAllGlobals();
  resetChatRouting();
});

async function mock(speed: number, rules: any[] = []) {
  const server = await startMockLlm({ speed, quiet: true, token: "test-token", script: { rules: rules.map((r, i) => ({ id: `r${i}`, ...r })), fallback: REPLY } });
  servers.push(server);
  return { provider: "openai-compatible", model: "mock/default", baseUrl: server.url, apiKey: "test-token" };
}

const ask = [{ role: "user", content: "Design a task management app" }];

describe("chat stream limits over the mock LLM", () => {
  it("finishes a reply that keeps streaming longer than the idle window", async () => {
    const config = await mock(1); // ~33 ms between deltas, ~1.5 s in all
    const startedAt = Date.now();
    const result = await completeWithAgent("system", ask, config, undefined, { limits: { idleMs: 500, totalMs: 60_000 } });
    expect(result.content).toBe(REPLY);
    expect(result.truncated).toBeUndefined();
    expect(Date.now() - startedAt).toBeGreaterThan(500);
  });

  it("stops a model that goes silent and keeps the text it sent", async () => {
    const config = await mock(0.1); // ~333 ms between deltas
    const error = await completeWithAgent("system", ask, config, undefined, { limits: { idleMs: 100, totalMs: 60_000 } }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error.kind).toBe("idle");
    expect(error.message).toBe("Reply stopped: the model went silent for 100ms"); // never "0s" (D2)
    expect(error.partial.content.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(error.partial.content)).toBe(true);
  });

  it("mock fault stall: a stream that goes quiet mid-reply is cut by the idle window with its text", async () => {
    const config = await mock(0, [{ fault: "stall", faultAfterChunks: 3, reply: REPLY }]);
    const error = await completeWithAgent("system", ask, config, undefined, { limits: { idleMs: 300, totalMs: 60_000 } }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error.kind).toBe("idle");
    expect(error.partial.content.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(error.partial.content)).toBe(true);
  });

  it("mock fault partial_disconnect: a dropped stream keeps the text it sent", async () => {
    const config = await mock(0, [{ fault: "partial_disconnect", faultAfterChunks: 3, reply: REPLY }]);
    const error = await completeWithAgent("system", ask, config, undefined, { limits: { idleMs: 5_000, totalMs: 60_000 } }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error.message).toMatch(/^Reply stopped: the connection to the model failed/);
    expect(REPLY.startsWith(error.partial.content)).toBe(true);
    expect(error.partial.content.length).toBeGreaterThan(0);
  });

  it("stops at the total cap with the text so far", async () => {
    const config = await mock(1);
    const error = await completeWithAgent("system", ask, config, undefined, { limits: { idleMs: 1_000, totalMs: 300 } }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error.kind).toBe("total");
    expect(error.partial.content.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(error.partial.content)).toBe(true);
  });
});

describe("output-limit replies are marked truncated", () => {
  const sse = (lines: unknown[]) => lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";

  it("openai-compatible finish_reason length", async () => {
    const body = sse([
      { choices: [{ delta: { content: "| Kanban |" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const result = await completeWithAgent("s", ask, { provider: "openai-compatible", model: "m", baseUrl: "https://llm.test/v1", apiKey: "k" });
    expect(result).toMatchObject({ content: "| Kanban |", truncated: true });
  });

  it("anthropic stop_reason max_tokens", async () => {
    const body = sse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "Kanban" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const result = await completeWithAgent("s", ask, { provider: "anthropic", model: "m", baseUrl: "https://llm.test/v1", apiKey: "k" });
    expect(result).toMatchObject({ content: "Kanban", truncated: true });
  });

  it("a normal stop is not truncated", async () => {
    const body = sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const result = await completeWithAgent("s", ask, { provider: "openai-compatible", model: "m", baseUrl: "https://llm.test/v1", apiKey: "k" });
    expect(result.truncated).toBeUndefined();
  });
});
