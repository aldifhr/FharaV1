import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, createGlobalLLMProvider, AnthropicProvider } from "../src/llm";
import { runWithObservationScope } from "../src/effects/observationContext";
import type { StallObservation } from "../src/utils/stallDetector";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonReply(finishReason: string | null) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"files":[{"path":"a.ts","content":"cut' }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 8192 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function sseReply(lines: object[]) {
  const body = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("finish_reason truncation", () => {
  it("complete(): finish_reason length is surfaced on the result and as a warn observation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonReply("length")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: StallObservation[] = [];
    const provider = new OpenAICompatibleProvider("k", "m", "http://10.0.0.5:8080/v1");
    const result = await runWithObservationScope({ nodeKey: "impl", emit: (o) => seen.push(o) }, () =>
      provider.complete([{ role: "user", content: "hi" }], undefined, { maxTokens: 8192 })
    );
    expect(result.finishReason).toBe("length");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "output_truncated", action: "report", nodeKey: "impl" });
    expect(seen[0].reason).toContain("8192");
    expect(seen[0].detail).toMatchObject({ model: "m", host: "10.0.0.5:8080", maxTokens: 8192 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("complete(): a normal stop emits nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonReply("stop")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: StallObservation[] = [];
    const provider = new OpenAICompatibleProvider("k", "m", "http://h/v1");
    const result = await runWithObservationScope({ emit: (o) => seen.push(o) }, () => provider.complete([{ role: "user", content: "hi" }]));
    expect(result.finishReason).toBe("stop");
    expect(seen).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stream(): finish_reason length on the last chunk is surfaced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseReply([
          { choices: [{ delta: { content: "par" }, finish_reason: null }] },
          { choices: [{ delta: { content: "tial" }, finish_reason: "length" }] },
        ])
      )
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: StallObservation[] = [];
    const chunks: string[] = [];
    const provider = new OpenAICompatibleProvider("k", "m", "http://h/v1");
    const result = await runWithObservationScope({ emit: (o) => seen.push(o) }, () =>
      provider.stream([{ role: "user", content: "hi" }], (d) => chunks.push(d))
    );
    expect(result.content).toBe("partial");
    expect(result.finishReason).toBe("length");
    expect(seen.map((o) => o.kind)).toEqual(["output_truncated"]);
  });

  it("outside a runner scope truncation only warns (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonReply("length")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new OpenAICompatibleProvider("k", "m", "http://h/v1");
    const result = await provider.complete([{ role: "user", content: "hi" }]);
    expect(result.finishReason).toBe("length");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("provider routing", () => {
  it("only anthropic kinds use the Anthropic client; other kinds use OpenAI chat completions", () => {
    const base = { model: "m", baseUrl: "http://h/v1", apiKey: "k" };
    expect(createGlobalLLMProvider({ ...base, provider: "anthropic" })).toBeInstanceOf(AnthropicProvider);
    expect(createGlobalLLMProvider({ ...base, provider: "openai" })).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createGlobalLLMProvider({ ...base, provider: "openai-compatible" })).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createGlobalLLMProvider({ ...base, provider: "openrouter" })).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
