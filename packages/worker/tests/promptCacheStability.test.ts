import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, type LLMMessage } from "@/llm";
import { createPlan } from "@/orchestrator/planner";
import { classifyCommand } from "@/orchestrator/classifier";
import { loadPolicy } from "@/orchestrator/policy";
import { planningPromptParts } from "@/prompts/planner";
import { runLlmCallWithFallback, type FallbackHandle } from "@/effects/llmCall";
import { flushSnapshots, setSnapshotSink, withSnapshotScope, type SnapshotRecord } from "@/llm/snapshots";
import { firstTokenClock, normalizeOpenAiUsage } from "@/llm/usage";
import { assemblePrompt, stablePrefixHash, stablePrefixText } from "@/api/convex/lib/assemblePrompt";
import { cacheHitPercent, tokensPerSecond } from "@/api/convex/lib/callStats";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { AgentDefinition } from "@/types";

/**
 * D5: cache-stable prompts and call stats. The planner's stable prefix is
 * byte-identical across the calls of one task (first plan, then a replan with
 * feedback, fixed requirements and a new time line), and snapshots carry the
 * provider's cached-token count and the time to first token.
 */
const recorded = JSON.parse(readFileSync(new URL("./fixtures/openai-usage-cached.json", import.meta.url), "utf8")) as {
  usage: unknown;
};

const policy = { ...loadPolicy(), reviewMode: "never" as const, qaMode: "never" as const };
const cto: AgentDefinition = { _id: "cto", name: "CTO", role: "cto", capabilities: ["architecture"], isEnabled: true, priority: 9 };
const frontend: AgentDefinition = { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], supportedTools: ["read_file", "write_file"], isEnabled: true, priority: 5 };
const team = [cto, frontend];
const PLAN = JSON.stringify({
  goal: "g",
  strategy: "single",
  requiresApproval: true,
  maxConcurrency: 1,
  requirements: [{ id: "r1", text: "Add a save button", quote: "add a save button" }],
  subtasks: [{ key: "implement", title: "t", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, requirementIds: ["r1"], allowedPaths: ["apps/web"] }],
});

function capturingResolver(log: LLMMessage[][]): TaskLlmResolver {
  return {
    handlesFor: () => [
      {
        connectionId: "",
        connectionName: "fake",
        config: { provider: "openai-compatible", model: "fake", apiKey: "x", baseUrl: "http://x" } as never,
        provider: {
          complete: async (messages: LLMMessage[]) => {
            log.push(messages);
            return { content: PLAN };
          },
        },
      },
    ],
  } as unknown as TaskLlmResolver;
}

afterEach(() => {
  setSnapshotSink(null);
  vi.unstubAllGlobals();
});

describe("D5 assemblePrompt", () => {
  it("puts the stable prefix first, history next and the volatile tail last", () => {
    const messages = assemblePrompt({
      stable: ["Persona", "Rules"],
      history: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
      volatile: "Current time: Thu 2026-11-12 02:30 (Asia/Jakarta, UTC+07:00).",
    });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[0].content).toBe("Persona\nRules");
    expect(messages.at(-1)?.content).toBe("q2\n\nCurrent time: Thu 2026-11-12 02:30 (Asia/Jakarta, UTC+07:00).");
  });

  it("never splits an assistant prefill and can prefix a single user turn", () => {
    const prefill = assemblePrompt({ history: [{ role: "user", content: "q" }, { role: "assistant", content: "partial" }], volatile: "tail" });
    expect(prefill.at(-1)).toEqual({ role: "assistant", content: "partial" });
    const single = assemblePrompt({ stable: "S", history: [{ role: "user", content: "task" }], volatile: "tail", stableAs: "user" });
    expect(single).toEqual([{ role: "user", content: "S\ntask\n\ntail" }]);
  });
});

describe("D5 planner prefix stability", () => {
  it("two consecutive planner calls on the same task share an identical stable prefix", async () => {
    const command = "add a save button";
    const classification = classifyCommand(command);
    const log: LLMMessage[][] = [];
    const projectInstructions = "Project instructions (AGENTS.md; root):\n--- AGENTS.md ---\nROOT-RULE";
    const base = { command, classification, agents: team, policy, llmResolver: capturingResolver(log), projectInstructions };
    await createPlan({ ...base, timeLine: "Current time: Thu 2026-11-12 02:30 (Asia/Jakarta, UTC+07:00)." });
    await createPlan({
      ...base,
      feedback: "Subtask implement failed: typecheck",
      requirements: [{ id: "r1", text: "Add a save button" }] as never,
      workspaceLayout: ["apps/", "apps/web/"],
      timeLine: "Current time: Thu 2026-11-12 02:41 (Asia/Jakarta, UTC+07:00).",
    });
    expect(log).toHaveLength(2);
    const parts = (extra: Record<string, unknown>) =>
      planningPromptParts({ command, classification, policy, capabilityList: "", projectInstructions, ...extra } as never);
    const first = parts({ timeLine: "t1" });
    const second = parts({ feedback: "f", requirements: [{ id: "r1", text: "x" }], workspaceLayout: ["apps/"], repoMap: "m", timeLine: "t2" });
    expect(stablePrefixHash(first)).toBe(stablePrefixHash(second));
    expect(stablePrefixText(first)).toBe(first.stable.join("\n"));
    // What was actually sent: both prompts open with the same bytes; only the
    // per-call part and the time line differ.
    const [a, b] = log.map((messages) => messages[0].content);
    const sentStable = (text: string) => text.slice(0, text.indexOf("\n", text.indexOf("Schema: ")));
    expect(sentStable(a).length).toBeGreaterThan(1000);
    expect(sentStable(a)).toBe(sentStable(b));
    expect(sentStable(a)).toContain("ROOT-RULE");
    expect(sentStable(a)).toContain("Schema:");
    expect(sentStable(a)).not.toContain("Current time:");
    expect(a).not.toBe(b);
    expect(a.split("\n").at(-1)).toMatch(/^Current time: .*02:30/);
    expect(b.split("\n").at(-1)).toMatch(/^Current time: .*02:41/);
  });
});

describe("D5 call stats on snapshots", () => {
  it("snapshots carry cached tokens from a recorded OpenAI-style usage frame", async () => {
    const records: SnapshotRecord[] = [];
    setSnapshotSink(async (record) => {
      records.push(record);
    });
    const usage = normalizeOpenAiUsage(recorded.usage);
    const handle: FallbackHandle = {
      connectionId: "c1",
      connectionName: "fake",
      config: { provider: "openai-compatible", model: "m", apiKey: "x", baseUrl: "http://x" } as never,
      provider: { complete: async () => ({ content: "ok", ...usage, ttftMs: 420 }) },
    };
    await withSnapshotScope({ taskId: "t1", projectId: "p1", callRole: "planner" }, () =>
      runLlmCallWithFallback([handle], [{ role: "user", content: "hi" }])
    );
    await flushSnapshots();
    expect(records).toHaveLength(1);
    const meta = records[0].meta;
    expect(meta.inputTokens).toBe(12000);
    expect(meta.cachedInputTokens).toBe(9840);
    expect(meta.ttftMs).toBe(420);
    expect(meta.usageEstimated).toBeUndefined();
    expect(cacheHitPercent(meta)).toBe(82);
  });

  it("the streamed OpenAI-compatible path reports cached tokens and TTFT", async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify(recorded)}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", async () => new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const provider = new OpenAICompatibleProvider("k", "m", "http://x/v1");
    const chunks: string[] = [];
    const result = await provider.stream([{ role: "user", content: "hi" }], (d) => chunks.push(d));
    expect(chunks.join("")).toBe("Hello");
    expect(result.cachedInputTokens).toBe(9840);
    expect(typeof result.ttftMs).toBe("number");
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
  });

  it("the first-token clock marks once; stats skip estimates", () => {
    let now = 1_000;
    const clock = firstTokenClock(() => now);
    expect(clock.fields()).toEqual({});
    now = 1_250;
    clock.mark();
    now = 1_900;
    clock.mark();
    expect(clock.fields()).toEqual({ ttftMs: 250 });
    expect(cacheHitPercent({ inputTokens: 100, cachedInputTokens: 82, usageEstimated: true })).toBeUndefined();
    expect(tokensPerSecond({ outputTokens: 500, durationMs: 5_250, ttftMs: 250 })).toBe(100);
  });
});
