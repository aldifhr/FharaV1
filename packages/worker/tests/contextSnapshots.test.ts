import { afterEach, describe, expect, test, vi } from "vitest";
import { LlmConcurrencyGate, runLlmCallWithFallback, type FallbackHandle } from "@/effects/llmCall";
import { flushSnapshots, setSnapshotSink, withSnapshotScope, type SnapshotRecord } from "@/llm/snapshots";
import type { LLMProvider } from "@/llm";

function handle(provider: LLMProvider, model = "m1"): FallbackHandle {
  return {
    connectionId: "c1",
    connectionName: "c1",
    config: { provider: "openai-compatible", model, baseUrl: "http://x", apiKey: "k" },
    provider,
  };
}

const gate = new LlmConcurrencyGate(4);

describe("worker context snapshots", () => {
  afterEach(() => {
    setSnapshotSink(null);
    vi.unstubAllEnvs();
  });

  test("a scoped call records one redacted snapshot with task/subtask/agent/role", async () => {
    const records: SnapshotRecord[] = [];
    setSnapshotSink(async (r) => void records.push(r));
    const provider: LLMProvider = {
      complete: async () => ({ content: "done ghp_abcdefghijklmnopqrstuvwxyz0123", inputTokens: 50, outputTokens: 5 }),
    };
    await withSnapshotScope({ taskId: "t1", projectId: "p1" }, () =>
      withSnapshotScope({ subtaskKey: "fe-1", agentId: "a1", agentRole: "frontend", callRole: "reviewer", executionId: "e1" }, () =>
        runLlmCallWithFallback(
          [handle(provider)],
          [
            { role: "system", content: "You review.\n\n## Memory\nnotes" },
            { role: "user", content: "Review this. LLM_API_KEY=supersecret123" },
          ],
          { gate }
        )
      )
    );
    await flushSnapshots();
    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r).toMatchObject({ taskId: "t1", projectId: "p1", subtaskKey: "fe-1", agentId: "a1", agentRole: "frontend", executionId: "e1" });
    expect(r.meta).toMatchObject({ callRole: "reviewer", model: "m1", inputTokens: 50, outputTokens: 5, memoryIncluded: true });
    expect(r.body.sections.map((s) => s.key)).toEqual(["system", "memory", "user"]);
    expect(JSON.stringify(r)).not.toMatch(/supersecret123|ghp_abcdef/);
    expect(r.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a failed call records its error; an unscoped call records nothing", async () => {
    const records: SnapshotRecord[] = [];
    setSnapshotSink(async (r) => void records.push(r));
    const failing: LLMProvider = {
      complete: async () => {
        throw Object.assign(new Error("LLM request failed (400): bad"), { status: 400 });
      },
    };
    await expect(
      withSnapshotScope({ taskId: "t1" }, () => runLlmCallWithFallback([handle(failing)], [{ role: "user", content: "x" }], { gate }))
    ).rejects.toThrow(/400/);
    const ok: LLMProvider = { complete: async () => ({ content: "y" }) };
    await runLlmCallWithFallback([handle(ok)], [{ role: "user", content: "x" }], { gate });
    await flushSnapshots();
    expect(records).toHaveLength(1);
    expect(records[0].meta.error).toMatch(/400/);
  });

  test("CONTEXT_SNAPSHOTS=0 disables capture; a failing sink never breaks the call", async () => {
    vi.stubEnv("CONTEXT_SNAPSHOTS", "0");
    const sink = vi.fn(async () => undefined);
    setSnapshotSink(sink);
    const ok: LLMProvider = { complete: async () => ({ content: "y" }) };
    await withSnapshotScope({ taskId: "t1" }, () => runLlmCallWithFallback([handle(ok)], [{ role: "user", content: "x" }], { gate }));
    expect(sink).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    setSnapshotSink(async () => {
      throw new Error("convex down");
    });
    const { result } = await withSnapshotScope({ taskId: "t1" }, () =>
      runLlmCallWithFallback([handle(ok)], [{ role: "user", content: "x" }], { gate })
    );
    expect(result.content).toBe("y");
    await flushSnapshots();
  });
});
