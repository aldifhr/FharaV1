import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeRawUsage, normalizeAnthropicUsage, normalizeOpenAiUsage } from "@/llm/usage";
import { OpenAICompatibleProvider } from "@/llm";
import { nativeUsageMeta, runLlmCallWithFallback, usageMetaFor, type FallbackHandle } from "@/effects/llmCall";
import { withSnapshotScope } from "@/llm/snapshots";
import { parseNativeUsage, parseOpencodeEvent, runNativeProvider } from "@/execution/nativeProvider";
import { usageLedgerArgs } from "@/services/runner/session";
import type { LLMProvider, LLMResult } from "@/llm";
import { spawnReturning } from "./helpers/spawn";

// Plan 040 P3: per-call usage ledger.

describe("provider usage normalization", () => {
  it("reads the OpenAI cached / cache-write / reasoning breakdown", () => {
    expect(
      normalizeOpenAiUsage({
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 128 },
      })
    ).toEqual({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1024, cacheWriteTokens: 10, reasoningTokens: 128 });
  });

  it("leaves breakdown fields absent when the server did not send them", () => {
    expect(normalizeOpenAiUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(normalizeOpenAiUsage(null)).toEqual({});
    expect(normalizeOpenAiUsage(undefined)).toEqual({});
  });

  it("falls back to DeepSeek prompt_cache_hit_tokens", () => {
    expect(normalizeOpenAiUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 40 }).cachedInputTokens).toBe(40);
  });

  it("totals Anthropic input as uncached + cache read + cache write", () => {
    expect(
      normalizeAnthropicUsage({
        input_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 300,
        output_tokens: 90,
        output_tokens_details: { thinking_tokens: 40 },
      })
    ).toEqual({ inputTokens: 1320, outputTokens: 90, cachedInputTokens: 1000, cacheWriteTokens: 300, reasoningTokens: 40 });
  });

  it("merges an Anthropic stream: message_start input + cache, message_delta cumulative output with null cache", () => {
    let raw = mergeRawUsage(undefined, { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 });
    raw = mergeRawUsage(raw, { output_tokens: 75, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null });
    expect(normalizeAnthropicUsage(raw)).toEqual({ inputTokens: 1020, outputTokens: 75, cachedInputTokens: 1000, cacheWriteTokens: 0 });
  });
});

describe("OpenAI-compatible provider surfaces the breakdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("complete() returns cached and reasoning tokens from usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 64 },
              completion_tokens_details: { reasoning_tokens: 8 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const result = await new OpenAICompatibleProvider("k", "m", "https://example.test/v1").complete([{ role: "user", content: "hi" }]);
    expect(result).toMatchObject({ content: "ok", inputTokens: 100, outputTokens: 20, cachedInputTokens: 64, reasoningTokens: 8 });
  });

  it("stream() reads usage from the final SSE chunk", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "y" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 16 } } })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const chunks: string[] = [];
    const result = await new OpenAICompatibleProvider("k", "m", "https://example.test/v1").stream(
      [{ role: "user", content: "hi" }],
      (d) => chunks.push(d)
    );
    expect(chunks.join("")).toBe("hey");
    expect(result).toMatchObject({ inputTokens: 30, outputTokens: 2, cachedInputTokens: 16 });
    expect(result.reasoningTokens).toBeUndefined();
  });
});

function handle(provider: LLMProvider, overrides: Partial<FallbackHandle> = {}): FallbackHandle {
  return {
    connectionId: "conn1",
    connectionName: "Conn 1",
    config: { provider: "openai", model: "m1", baseUrl: "https://x", apiKey: "k" },
    provider,
    modelRowId: "row1",
    inputPricePer1k: 0.001,
    outputPricePer1k: 0.002,
    ...overrides,
  };
}

describe("usage meta for the ledger", () => {
  it("carries breakdown, duration, provider kind and the scope's call role", async () => {
    const provider: LLMProvider = {
      complete: async (): Promise<LLMResult> => ({ content: "x", inputTokens: 1000, outputTokens: 500, cachedInputTokens: 800, reasoningTokens: 100 }),
    } as unknown as LLMProvider;
    const h = handle(provider);
    const meta = await withSnapshotScope({ callRole: "planner" }, async () => {
      const { result, servedBy } = await runLlmCallWithFallback([h], [{ role: "user", content: "hi" }], { retries: 0 });
      expect(typeof result.durationMs).toBe("number");
      return usageMetaFor(servedBy, result);
    });
    expect(meta).toMatchObject({
      providerId: "conn1",
      modelRowId: "row1",
      cachedInputTokens: 800,
      reasoningTokens: 100,
      providerKind: "openai-compatible",
      callRole: "planner",
    });
    expect(meta.estimatedCost).toBeCloseTo(0.001 + 0.001, 10);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(meta.cacheWriteTokens).toBeUndefined();
  });

  it("keeps the legacy (input, output, estimated) signature", () => {
    const meta = usageMetaFor(handle({} as LLMProvider, { config: { provider: "anthropic", model: "c", baseUrl: "", apiKey: "" } }), 10, 5, true);
    expect(meta).toMatchObject({ estimated: true, providerKind: "anthropic" });
    expect(meta.callRole).toBeUndefined();
  });

  it("usageLedgerArgs sends only reported fields, tagged source worker", () => {
    expect(usageLedgerArgs(undefined)).toEqual({ source: "worker" });
    expect(usageLedgerArgs({ cachedInputTokens: 3, durationMs: 12.6, providerKind: "anthropic", callRole: "executor" })).toEqual({
      cachedInputTokens: 3,
      durationMs: 13,
      providerKind: "anthropic",
      callRole: "executor",
      source: "worker",
    });
  });
});

describe("OpenCode usage", () => {
  const step = (tokens: object, cost?: number) =>
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens, ...(cost !== undefined ? { cost } : {}) } });

  it("parses a step_finish with cache, reasoning and cost into ledger totals", () => {
    const event = parseOpencodeEvent(step({ input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 50 } }, 0.0123));
    expect(event).toEqual({
      kind: "step_finish",
      reason: "stop",
      inputTokens: 1050,
      outputTokens: 50,
      cachedInputTokens: 900,
      cacheWriteTokens: 50,
      reasoningTokens: 10,
      cost: 0.0123,
    });
  });

  it("sums steps and leaves unreported fields absent", () => {
    const stdout = [step({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, 0.01), step({ input: 1, output: 1 })].join("\n");
    const usage = parseNativeUsage(stdout);
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 6, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01 });
    expect(parseNativeUsage(step({ input: 1, output: 1 }))).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it("a run reports the breakdown, cost and duration; meta tags it opencode", async () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "done" } }),
      step({ input: 20, output: 10, reasoning: 5, cache: { read: 200, write: 0 } }, 0.5),
    ].join("\n");
    const result = await runNativeProvider({ workspacePath: "/tmp/w", prompt: "do it", spawnImpl: spawnReturning({ stdout }) });
    expect(result).toMatchObject({ status: "completed", inputTokens: 220, outputTokens: 15, cachedInputTokens: 200, reasoningTokens: 5, costUsd: 0.5 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const meta = withSnapshotScope({ callRole: "executor" }, () => nativeUsageMeta(result));
    expect(meta).toMatchObject({ providerKind: "opencode", estimatedCost: 0.5, cachedInputTokens: 200, callRole: "executor" });
  });

  it("an OpenCode cost of zero is not recorded as a cost", () => {
    expect(nativeUsageMeta({ costUsd: 0 }).estimatedCost).toBeUndefined();
  });
});
