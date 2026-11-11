import { describe, expect, it } from "vitest";
import type { LLMMessage } from "@/llm";
import { callWithOverflowRecovery, pruneHeadTail } from "@/context/overflowRecovery";
import { LlmContextOverflowError, isContextOverflowError } from "@/llm/errors";
import { runToolLoop } from "@/tools/toolLoop";
import { runLlmCallWithFallback, LlmConcurrencyGate, type FallbackHandle } from "@/effects/llmCall";
import { cooldownForFailure } from "@/api/convex/lib/llmRotation";
import { formatTimeoutLimit } from "@/api/convex/lib/llmWireErrors";
import { PRUNE_MARKER, resolveConfig } from "@/vendor/deepseek-harness/prunerConfig";

const overflow = (limit = 10_000) =>
  new LlmContextOverflowError(`LLM request failed (400) for model "m": This model's maximum context length is ${limit} tokens.`, {
    status: 400,
    contextLimit: limit,
  });
const chars = (messages: LLMMessage[]) => messages.reduce((n, m) => n + m.content.length, 0);

describe("head/middle/tail pruning (vendored config)", () => {
  it("keeps 4096 head + marker + 1024 tail, at most 8192 characters", () => {
    const text = `${"h".repeat(5000)}${"m".repeat(10_000)}${"t".repeat(2000)}`;
    const pruned = pruneHeadTail(text);
    expect(pruned.startsWith("h".repeat(4096))).toBe(true);
    expect(pruned.endsWith("t".repeat(1024))).toBe(true);
    expect(pruned).toContain(PRUNE_MARKER);
    expect(pruned.length).toBeLessThanOrEqual(8192);
    expect(pruneHeadTail("short")).toBe("short");
  });

  it("rejects a budget whose head + marker + tail exceed the threshold", () => {
    expect(() => resolveConfig({ thresholdChars: 100, headChars: 90, tailChars: 20 })).toThrow(/must be at most/);
    expect(() => resolveConfig({ bogus: 1 } as never)).toThrow(/unknown key/);
  });
});

describe("callWithOverflowRecovery", () => {
  const conversation = (): LLMMessage[] => [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "user", content: "x".repeat(40_000) },
    { role: "assistant", content: "y".repeat(40_000) },
    { role: "user", content: "newest" },
  ];

  it("pruning alone relieves it: one retry, no summary call, start/end paired", async () => {
    const messages = conversation();
    const events: string[] = [];
    let summaries = 0;
    let calls = 0;
    const out = await callWithOverflowRecovery({
      messages,
      call: async (m) => {
        calls++;
        if (chars(m) > 30_000) throw overflow(10_000); // 10k tokens ≈ 40k chars
        return "ok";
      },
      summarize: async () => (summaries++, "s"),
      onEvent: (type) => events.push(type),
    });
    expect(out).toEqual({ result: "ok", retries: 1, restructured: false });
    expect(calls).toBe(2);
    expect(summaries).toBe(0);
    expect(events).toEqual(["compaction.start", "compaction.end"]);
    expect(messages[1].content).toBe("task"); // the task statement is protected
    expect(messages[4].content).toBe("newest");
    expect(messages[2].content).toContain(PRUNE_MARKER);
  });

  it("still over after pruning: summarizes and retries exactly once", async () => {
    const messages = conversation();
    let summaries = 0;
    let calls = 0;
    const out = await callWithOverflowRecovery({
      messages,
      call: async (m) => {
        calls++;
        if (chars(m) > 4_000) throw overflow(2_000); // pruning leaves ~16k chars: still over
        return "ok";
      },
      summarize: async () => (summaries++, "short summary"),
    });
    expect(out.result).toBe("ok");
    expect(out.retries).toBe(1);
    expect(out.restructured).toBe(true);
    expect(calls).toBe(2);
    expect(summaries).toBe(1);
    expect(messages.map((m) => m.content)).toEqual(["sys", "task", expect.stringContaining("short summary"), "newest"]);
  });

  it("a second overflow after compaction fails with a clear reason", async () => {
    let calls = 0;
    const error = await callWithOverflowRecovery({
      messages: conversation(),
      call: async () => {
        calls++;
        throw overflow(10);
      },
      summarize: async () => "s",
    }).catch((e) => e);
    expect(calls).toBe(2);
    expect(isContextOverflowError(error)).toBe(true);
    expect(error.message).toMatch(/still longer than the model's context window after 1 recovery retry \(2 messages pruned, history compacted\)/);
    expect(error.message).toMatch(/maximum context length is 10 tokens/);
  });

  it("no named limit: prune → retry → compact → retry → fail (never more than 2 retries)", async () => {
    let calls = 0;
    const events: string[] = [];
    const error = await callWithOverflowRecovery({
      messages: conversation(),
      call: async () => {
        calls++;
        throw new Error('LLM request failed (400) for model "m": prompt is too long');
      },
      onEvent: (type) => events.push(type),
    }).catch((e) => e);
    expect(calls).toBe(3);
    expect(error.message).toMatch(/after 2 recovery retries/);
    expect(events).toEqual(["compaction.start", "compaction.end", "compaction.start", "compaction.end"]);
  });

  it("any other error is rethrown untouched, with no retry", async () => {
    let calls = 0;
    const boom = new Error("LLM request failed (500)");
    await expect(callWithOverflowRecovery({ messages: conversation(), call: async () => (calls++, Promise.reject(boom)) })).rejects.toBe(boom);
    expect(calls).toBe(1);
  });
});

describe("tool loop: overflow on a step shrinks old tool turns and retries the same step", () => {
  it("prunes the old tool result head/middle/tail and keeps the protocol message", async () => {
    let step = 0;
    const seen: LLMMessage[][] = [];
    const events: string[] = [];
    const result = await runToolLoop({
      tools: [{ name: "read" }],
      callTool: async () => ({ ok: true, text: "R".repeat(60_000), isError: false }),
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "task" }],
      runLlm: async (messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        if (chars(messages) > 40_000) throw overflow(20_000);
        step++;
        return step === 1 ? JSON.stringify({ tool: "read", arguments: {} }) : JSON.stringify({ answer: "done" });
      },
      onEvent: (type) => events.push(type),
      stuckDetection: false,
    });
    // step 1 → tool call; step 2 overflows (60k), is pruned and retried.
    expect(result.answer).toBe("done");
    expect(events.filter((e) => e.startsWith("compaction."))).toEqual(["compaction.start", "compaction.end"]);
    const last = seen[seen.length - 1];
    expect(last[1].content).toBe("task");
    expect(last.some((m) => m.content.includes(PRUNE_MARKER))).toBe(true);
  });
});

describe("rotation: an overflow is never a provider failure", () => {
  it("runLlmCallWithFallback does not move to the next model on an overflow", async () => {
    const used: string[] = [];
    const handle = (id: string): FallbackHandle => ({
      connectionId: id,
      connectionName: id,
      config: { provider: "openai", model: id, baseUrl: "http://x", apiKey: "k" },
      provider: {
        complete: async () => {
          used.push(id);
          throw overflow();
        },
      },
    });
    const error = await runLlmCallWithFallback([handle("a"), handle("b")], [{ role: "user", content: "hi" }], {
      retries: 2,
      gate: new LlmConcurrencyGate(2),
    }).catch((e) => e);
    expect(used).toEqual(["a"]);
    expect(isContextOverflowError(error)).toBe(true);
    expect(cooldownForFailure(error)).toEqual({ cooldownMs: 0, kind: "context_overflow" });
  });
});

describe("timeout limits", () => {
  it.each([
    [1, "1ms"],
    [250, "250ms"],
    [500, "500ms"],
    [1_000, "1s"],
    [1_500, "1.5s"],
    [300_000, "300s"],
  ])("%i ms reads %s", (ms, text) => {
    expect(formatTimeoutLimit(ms)).toBe(text);
  });
});
