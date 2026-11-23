import { afterEach, describe, expect, test, vi } from "vitest";
import { completeWithAgent } from "./lib/chat/llm";
import { cooldownForFailure } from "./lib/llmRotation";
import { formatTimeoutLimit, isContextOverflowError, isIncompleteResponseError, partialTextOf } from "./lib/llmWireErrors";
import { ChatStreamError } from "./lib/chat/streamLimits";

/**
 * Wire faults on the backend chat client (DeepSeek Harness D2). A cut or
 * malformed stream is a ChatStreamError carrying the text so far, which the
 * chat keeps as an interrupted reply (lib/chat/continueReply.ts).
 */
const config = { provider: "openai", model: "gpt-x", baseUrl: "https://example.test/v1", apiKey: "secret" };
const sse = (lines: string[]) => new Response(lines.join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const frame = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}`;

describe("chat client: wire faults", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("a whole stream (finish_reason, [DONE]) is an answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([frame("Hel"), frame("lo", "stop"), "data: [DONE]"])));
    expect((await completeWithAgent("sys", [{ role: "user", content: "hi" }], config)).content).toBe("Hello");
  });

  test("a stream that just stops is incomplete, with the partial text, never an answer", async () => {
    const chunks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sse([frame("Hel"), frame("lo")])));
    const error = await completeWithAgent("sys", [{ role: "user", content: "hi" }], config, (p) => chunks.push(p.content)).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error.kind).toBe("incomplete");
    expect(isIncompleteResponseError(error)).toBe(true);
    expect(error.partial).toEqual({ content: "Hello", reasoning: "" });
    expect(partialTextOf(error)).toBe("Hello");
    expect(error.message).toBe("Reply stopped: the model's stream ended before the reply finished");
    expect(chunks.at(-1)).toBe("Hello");
  });

  test("a malformed frame is an error, not a hole in the reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([frame("Hel"), 'data: {"choices":[{"delta":{"content":"x"}', frame("lo", "stop"), "data: [DONE]"])));
    const error = await completeWithAgent("sys", [{ role: "user", content: "hi" }], config).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error.kind).toBe("malformed");
    expect(error.message).toMatch(/^Reply stopped: the model sent a malformed part/);
    expect(error.partial.content).toBe("Hello");
  });

  test("an Anthropic stream with no message_stop / stop_reason is incomplete", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sse(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`))));
    const error = await completeWithAgent("sys", [{ role: "user", content: "hi" }], { ...config, provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }).catch((e) => e);
    expect(isIncompleteResponseError(error)).toBe(true);
    expect(error.partial.content).toBe("Hi");
  });

  test("a context overflow 400 is classified and never cools the connection down", async () => {
    const body = JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens. However, you requested 70214 tokens." } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 400, headers: { "content-type": "application/json" } })));
    const error = await completeWithAgent("sys", [{ role: "user", content: "hi" }], config).catch((e) => e);
    expect(isContextOverflowError(error)).toBe(true);
    expect(cooldownForFailure(error)).toEqual({ cooldownMs: 0, kind: "context_overflow" });
  });

  test("timeouts name their limit, never 0s", () => {
    expect(formatTimeoutLimit(500)).toBe("500ms");
    expect(formatTimeoutLimit(120_000)).toBe("120s");
  });
});
