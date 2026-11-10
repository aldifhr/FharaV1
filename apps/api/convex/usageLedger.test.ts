/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { estimateCostFromPricing, mergeRawUsage, normalizeAnthropicUsage, normalizeOpenAiUsage } from "./lib/usageLedger";
import { completeWithAgent } from "./lib/chat/llm";
import { chatUsageArgs } from "./lib/chat/usage";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

// Plan 040 P3: per-call usage ledger (backend chat side + schema).

describe("usage normalization (backend chat)", () => {
  test("OpenAI-compatible breakdown", () => {
    expect(
      normalizeOpenAiUsage({
        prompt_tokens: 500,
        completion_tokens: 60,
        prompt_tokens_details: { cached_tokens: 256 },
        completion_tokens_details: { reasoning_tokens: 12 },
      })
    ).toEqual({ inputTokens: 500, outputTokens: 60, cachedInputTokens: 256, reasoningTokens: 12 });
  });

  test("Anthropic totals include the cache; stream merge keeps message_start cache counts", () => {
    let raw = mergeRawUsage(undefined, { input_tokens: 5, cache_read_input_tokens: 95, cache_creation_input_tokens: 0, output_tokens: 1 });
    raw = mergeRawUsage(raw, { output_tokens: 33, cache_read_input_tokens: null });
    expect(normalizeAnthropicUsage(raw)).toEqual({ inputTokens: 100, outputTokens: 33, cachedInputTokens: 95, cacheWriteTokens: 0 });
  });

  test("cost needs both prices", () => {
    expect(estimateCostFromPricing({ inputPricePer1k: 1, outputPricePer1k: 2 }, 1000, 500)).toBe(2);
    expect(estimateCostFromPricing({ inputPricePer1k: 1 }, 1000, 500)).toBeUndefined();
    expect(estimateCostFromPricing(undefined, 1, 1)).toBeUndefined();
  });
});

describe("chat client returns usage and the serving config", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("OpenAI stream with a usage chunk", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 32 } } })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const result = await completeWithAgent("sys", [{ role: "user", content: "hi" }], {
      provider: "openai",
      model: "gpt-x",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      connectionId: "c1",
      modelRowId: "m1",
      inputPricePer1k: 0.01,
      outputPricePer1k: 0.02,
    });
    expect(result.content).toBe("Hello");
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 3, cachedInputTokens: 32 });
    expect(result.servedBy).toMatchObject({ model: "gpt-x", connectionId: "c1", modelRowId: "m1", apiKey: "" });
    expect(typeof result.durationMs).toBe("number");
  });

  test("Anthropic stream usage from message_start + message_delta", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n") + "\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const result = await completeWithAgent("sys", [{ role: "user", content: "hi" }], {
      provider: "anthropic",
      model: "claude-x",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "secret",
    });
    expect(result.content).toBe("Hi");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 7, cachedInputTokens: 90, cacheWriteTokens: 0 });
  });

  test("no usage from the endpoint leaves usage absent", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\ndata: [DONE]\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const result = await completeWithAgent("s", [{ role: "user", content: "q" }], {
      provider: "openai",
      model: "m",
      baseUrl: "https://example.test/v1",
      apiKey: "k",
    });
    expect(result.usage).toBeUndefined();
  });
});

describe("chat usage rows", () => {
  const projectId = "p" as Id<"projects">;
  const agentId = "a" as Id<"agents">;

  test("real usage: breakdown, cost from registry pricing, not estimated", () => {
    const args = chatUsageArgs(
      { projectId, agentId, callRole: "chat" },
      {
        system: "s",
        msgs: [{ role: "user", content: "q" }],
        fallbackModel: "fallback",
        result: {
          content: "answer",
          reasoning: "",
          reasoningDurationMs: 0,
          durationMs: 812.4,
          usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 600, reasoningTokens: 20 },
          servedBy: { provider: "openai", model: "gpt-x", baseUrl: "", apiKey: "", connectionId: "c1", modelRowId: "m1", inputPricePer1k: 0.001, outputPricePer1k: 0.002 },
        },
      }
    );
    expect(args).toMatchObject({
      model: "gpt-x",
      inputTokens: 1000,
      outputTokens: 100,
      providerId: "c1",
      modelId: "m1",
      cachedInputTokens: 600,
      reasoningTokens: 20,
      durationMs: 812,
      providerKind: "openai-compatible",
      callRole: "chat",
    });
    expect(args.estimatedCost).toBeCloseTo(0.0012, 10);
    expect("estimated" in args).toBe(false);
  });

  test("no usage: chars/4 estimate, flagged", () => {
    const args = chatUsageArgs(
      { projectId, agentId, callRole: "chat_tool_step" },
      { system: "abcd", msgs: [{ role: "user", content: "efgh" }], fallbackModel: "m0", result: { content: "12345678", reasoning: "", reasoningDurationMs: 0 } }
    );
    expect(args).toMatchObject({ model: "m0", inputTokens: 3, outputTokens: 2, estimated: true, callRole: "chat_tool_step" });
    expect("cachedInputTokens" in args).toBe(false);
  });

  test("recordChatTokenUsage writes a chat row with the agent's name and ledger fields", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const agent = await ctx.db.insert("agents", { name: "CTO", role: "orchestrator", status: "idle" });
      const project = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [agent] });
      return { agent, project };
    });
    await t.mutation(internal.orchestration.recordChatTokenUsage, {
      projectId: ids.project,
      agentId: ids.agent,
      model: "gpt-x",
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 8,
      durationMs: 50,
      providerKind: "openai-compatible",
      callRole: "chat",
    });
    await t.mutation(internal.orchestration.recordTokenUsage, {
      projectId: ids.project,
      agentName: "Frontend",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      callRole: "executor",
      source: "worker",
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("tokenUsage").collect());
    const chat = rows.find((r) => r.source === "chat")!;
    expect(chat).toMatchObject({ agentName: "CTO", cachedInputTokens: 8, durationMs: 50, providerKind: "openai-compatible", callRole: "chat" });
    expect(chat.taskId).toBeUndefined();
    const worker = rows.find((r) => r.source === "worker")!;
    expect(worker).toMatchObject({ reasoningTokens: 0, callRole: "executor" });
    expect("cacheWriteTokens" in worker).toBe(false);
  });
});
