import { describe, expect, it } from "vitest";
import {
  PRUNED_TOOL_OUTPUT,
  estimateTokens,
  pruneToolOutputs,
  runToolLoop,
  summarizeToolResults,
} from "@/tools/toolLoop";
import { StuckDetector, type StuckEvent } from "@/utils/stuckDetector";
import { buildSummaryPrompt, compactIfNeeded, isOverflow, shouldCompact } from "@/context/compaction";
import type { LLMMessage } from "@/llm";

const TOOLS = [{ name: "read", description: "read a file" }];

describe("R10 tool-output pruning (opencode prune)", () => {
  it("a 60-call loop keeps the newest ~40k tokens of tool output and prunes the rest", async () => {
    const chunk = "x".repeat(8_000); // 2k tokens per result
    let call = 0;
    let lastMessages: LLMMessage[] = [];
    const events: string[] = [];
    const result = await runToolLoop({
      tools: TOOLS,
      maxIterations: 61,
      messages: [{ role: "user", content: "task statement" }],
      stuckDetection: false,
      callTool: async () => ({ ok: true, text: `${call}:${chunk}`, isError: false }),
      runLlm: async (messages) => {
        lastMessages = messages;
        call += 1;
        return call <= 60 ? JSON.stringify({ tool: "read", arguments: { path: `f${call}.ts` } }) : JSON.stringify({ answer: "done" });
      },
      onEvent: (type) => events.push(type),
    });
    expect(result.answer).toBe("done");
    expect(result.toolCalls).toBe(60);
    const toolMessages = lastMessages.filter((m) => typeof m.content === "string" && (m.content as string).startsWith('Tool "read" result:'));
    expect(toolMessages).toHaveLength(60);
    const kept = toolMessages.filter((m) => !(m.content as string).endsWith(PRUNED_TOOL_OUTPUT));
    const keptTokens = kept.reduce((sum, m) => sum + estimateTokens(m.content as string), 0);
    // opencode semantics: 40k protected (+ the 2 newest, which are never
    // counted); older output is pruned in batches once that frees > 20k.
    expect(keptTokens).toBeGreaterThanOrEqual(40_000);
    expect(keptTokens).toBeLessThanOrEqual(40_000 + 20_000 + 3 * 2_010);
    expect(toolMessages.length - kept.length).toBeGreaterThanOrEqual(25);
    expect(toolMessages[0].content).toBe(`Tool "read" result:\n${PRUNED_TOOL_OUTPUT}`);
    expect(toolMessages.at(-1)!.content).toContain("60:");
    // The task statement is never touched.
    expect(lastMessages[0]).toEqual({ role: "user", content: "task statement" });
    expect(events).toContain("tool.loop_pruned");
  });

  it("does not prune when it would free less than the minimum", () => {
    const outputs = Array.from({ length: 30 }, () => ({ text: "y".repeat(4_000) })); // 1k tokens each
    expect(pruneToolOutputs(outputs).prune).toEqual([]);
    const big = Array.from({ length: 80 }, () => ({ text: "y".repeat(4_000) }));
    const { prune } = pruneToolOutputs(big);
    expect(prune.length).toBeGreaterThan(20);
    expect(Math.max(...prune)).toBeLessThan(80 - 2 - 40);
  });

  it("the findings summary spends its budget on the newest results", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ tool: "read", text: `${i}`.repeat(3_000) }));
    const summary = summarizeToolResults(results);
    expect(summary).toContain("9".repeat(2_000));
    expect(summary).toContain(`### read\n${PRUNED_TOOL_OUTPUT}`);
    expect(summary.length).toBeLessThan(14_000);
  });
});

describe("R10 stuck detector (OpenHands patterns)", () => {
  const user: StuckEvent = { kind: "user_message", text: "go" };
  const act = (args = "{}"): StuckEvent => ({ kind: "action", tool: "read", args });
  const obs = (text = "same"): StuckEvent => ({ kind: "observation", tool: "read", text });
  const err = (error = "boom"): StuckEvent => ({ kind: "error", tool: "read", error });

  it("action-observation loop", () => {
    const events = [user, ...Array.from({ length: 4 }, () => [act(), obs()]).flat()];
    expect(new StuckDetector().isStuck(events)).toMatchObject({ isStuck: true, pattern: "action_observation_loop" });
    expect(new StuckDetector().isStuck([user, act(), obs(), act(), obs()]).isStuck).toBe(false);
  });

  it("action-error loop", () => {
    const events = [user, ...Array.from({ length: 4 }, () => [act(), err()]).flat()];
    expect(new StuckDetector().isStuck(events)).toMatchObject({ isStuck: true, pattern: "action_error_loop" });
  });

  it("monologue", () => {
    const say: StuckEvent = { kind: "agent_message", text: "thinking" };
    expect(new StuckDetector().isStuck([user, say, say, say, say])).toMatchObject({ isStuck: true, pattern: "monologue" });
    expect(new StuckDetector().isStuck([user, say, say, say]).isStuck).toBe(false);
  });

  it("alternating pattern", () => {
    const a = act('{"p":"a"}');
    const b = act('{"p":"b"}');
    const events = [user, ...Array.from({ length: 3 }, () => [a, obs("A"), b, obs("B")]).flat()];
    expect(new StuckDetector().isStuck(events)).toMatchObject({ isStuck: true, pattern: "alternating_pattern" });
  });

  it("each pattern ends runToolLoop with a recorded reason", async () => {
    const cases: Array<{ name: string; reply: (n: number) => string; tool: (n: number) => { text: string; isError: boolean }; pattern: string }> = [
      { name: "same call, same result", reply: () => '{"tool":"read","arguments":{"path":"a"}}', tool: () => ({ text: "same", isError: false }), pattern: "action_observation_loop" },
      { name: "same call, errors", reply: () => '{"tool":"read","arguments":{"path":"a"}}', tool: () => ({ text: "ENOENT", isError: true }), pattern: "action_error_loop" },
      { name: "prose replies", reply: () => "let me think about it", tool: () => ({ text: "", isError: false }), pattern: "monologue" },
      {
        name: "A-B-A-B",
        reply: (n) => `{"tool":"read","arguments":{"path":"${n % 2 === 0 ? "a" : "b"}"}}`,
        tool: (n) => ({ text: n % 2 === 0 ? "A" : "B", isError: false }),
        pattern: "alternating_pattern",
      },
    ];
    for (const c of cases) {
      let n = -1;
      let t = -1;
      const recorded: Array<Record<string, unknown>> = [];
      const result = await runToolLoop({
        tools: TOOLS,
        maxIterations: 20,
        messages: [{ role: "user", content: "task" }],
        callTool: async () => {
          t += 1;
          const out = c.tool(t);
          return { ok: !out.isError, text: out.text, isError: out.isError };
        },
        runLlm: async () => {
          n += 1;
          return c.reply(n);
        },
        onEvent: (type, payload) => {
          if (type === "tool.loop_stuck") recorded.push(payload);
        },
      });
      expect(result.stuck?.pattern, c.name).toBe(c.pattern);
      expect(recorded[0]?.pattern, c.name).toBe(c.pattern);
      expect(n, c.name).toBeLessThan(19);
    }
  });
});

describe("R10 compaction: overflow trigger and keep_first", () => {
  it("isOverflow uses context minus the output reserve", () => {
    expect(isOverflow({ tokens: { input: 90_000, output: 1_000 }, model: { context: 128_000, output: 32_000 } })).toBe(false);
    expect(isOverflow({ tokens: { input: 96_000, output: 1_000 }, model: { context: 128_000, output: 32_000 } })).toBe(true);
    expect(isOverflow({ tokens: { input: 10_000_000, output: 0 }, model: { context: 0 } })).toBe(false);
    const short = [{ authorType: "user", content: "hi" }];
    expect(shouldCompact(short)).toBe(false);
    expect(shouldCompact(short, { tokens: { input: 200_000, output: 0 }, model: { context: 128_000 } })).toBe(true);
  });

  it("the first 2 messages are never summarised", async () => {
    const history = Array.from({ length: 50 }, (_, i) => ({ authorType: i % 2 ? "agent" : "user", content: `m${i}` }));
    const prompt = buildSummaryPrompt(history);
    const earlier = prompt.slice(prompt.indexOf("Earlier conversation:"), prompt.indexOf("Recent tail"));
    expect(earlier).not.toContain("user: m0\n");
    expect(earlier).not.toContain("agent: m1\n");
    expect(prompt).toContain("Opening messages (kept verbatim elsewhere; do not summarize, context only):\nuser: m0\nagent: m1");
    const out = await compactIfNeeded({ history, summarize: async () => "S" });
    expect(out.kept).toEqual(history.slice(0, 2));
  });
});
