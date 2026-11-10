import { describe, expect, it, vi } from "vitest";
import { parseSuggestions, reconcileTaskMemory, TAG } from "@/services/runner/memoryReconcile";
import type { RunnerDeps } from "@/services/runner/types";
import type { ReconcileTaskSummary } from "@/prompts/memoryReconcile";

function fakeApi(over: { reconciled?: boolean } = {}) {
  const recorded: Array<Record<string, unknown>> = [];
  let reconciled = over.reconciled ?? false;
  const api = {
    getMemoryReconcileContext: vi.fn(async () => ({
      reconciled,
      memories: [{ id: "m1", scope: "project", title: "Test command", content: "Run npm test", pinned: true }],
    })),
    recordMemorySuggestions: vi.fn(async (input: Record<string, unknown>) => {
      if (reconciled) return { applied: false, reason: "already_reconciled", inserted: 0 };
      reconciled = true;
      recorded.push(input);
      return { applied: true, inserted: (input.suggestions as unknown[]).length };
    }),
    logEvent: vi.fn(async () => undefined),
  };
  return { api, recorded, deps: { api } as unknown as RunnerDeps };
}

const changed: ReconcileTaskSummary = {
  title: "Lower compaction threshold",
  request: "Lower the compaction threshold to 75%",
  status: "done",
  filesChanged: ["packages/worker/src/context/compaction.ts"],
  blockers: [],
  summary: "s1: changed the threshold constant",
};

const reply = JSON.stringify({
  should_update: true,
  reason: "durable",
  suggestions: [
    { op: "add", scope: "project", title: "Compaction threshold", content: "75% of the window since the tuning task." },
    { op: "update", memory_id: "m1", scope: "project", title: "Test command", content: "Run pnpm test" },
    { op: "forget", memory_id: "unknown", scope: "project", title: "x", content: "" },
  ],
});

const base = (deps: RunnerDeps, extra: Record<string, unknown> = {}) => ({
  deps,
  taskId: "t1",
  projectId: "p1",
  task: changed,
  agent: null,
  ...extra,
});

describe("post-task memory suggestions (plan L5)", () => {
  it("read-only and noisy-failed tasks make zero LLM calls", async () => {
    const ask = vi.fn(async () => reply);
    const a = fakeApi();
    const ro = await reconcileTaskMemory({ ...base(a.deps), task: { ...changed, filesChanged: [] }, ask });
    expect(ro.tag).toBe(TAG.readOnly);
    const b = fakeApi();
    const noisy = await reconcileTaskMemory({
      ...base(b.deps),
      task: { ...changed, status: "failed", filesChanged: [], blockers: ["boom"], summary: "" },
      ask,
    });
    expect(noisy.tag).toBe(TAG.failedNoisy);
    expect(ask).not.toHaveBeenCalled();
  });

  it("budget gate runs before the call; over budget skips with a recorded reason", async () => {
    const ask = vi.fn(async () => reply);
    const order: string[] = [];
    const a = fakeApi();
    const out = await reconcileTaskMemory({
      ...base(a.deps),
      ask,
      assertBudgetForCall: () => {
        order.push("gate");
        throw new Error("LLM call budget exhausted");
      },
    });
    expect(out.tag).toBe(TAG.budget);
    expect(ask).not.toHaveBeenCalled();
    expect(a.recorded[0]).toMatchObject({ tag: TAG.budget, suggestions: [] });
    expect(String(a.recorded[0].reason)).toContain("budget");
  });

  it("suggests valid ops only and a second finalize does not duplicate or call again", async () => {
    const ask = vi.fn(async () => reply);
    const gate = vi.fn();
    const a = fakeApi();
    const out = await reconcileTaskMemory({ ...base(a.deps), ask, assertBudgetForCall: gate });
    expect(out).toMatchObject({ tag: TAG.suggested, suggestions: 2 });
    expect(gate).toHaveBeenCalledTimes(1);
    const again = await reconcileTaskMemory({ ...base(a.deps), ask, assertBudgetForCall: gate });
    expect(again.tag).toBe(TAG.alreadyReconciled);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(a.recorded).toHaveLength(1);
  });

  it("an LLM failure or bad JSON never throws", async () => {
    const a = fakeApi();
    const out = await reconcileTaskMemory({ ...base(a.deps), ask: async () => { throw new Error("provider down"); } });
    expect(out.tag).toBe(TAG.error);
    const b = fakeApi();
    expect((await reconcileTaskMemory({ ...base(b.deps), ask: async () => "not json" })).tag).toBe(TAG.error);
  });

  it("secrets are masked in the prompt and in the suggestions", async () => {
    const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let seen = "";
    const a = fakeApi();
    await reconcileTaskMemory({
      ...base(a.deps),
      task: { ...changed, summary: `used OPENAI_API_KEY=${secret} to test`, blockers: [`token ghp_${"a".repeat(36)}`] },
      ask: async (_system, user) => {
        seen = user;
        return JSON.stringify({
          should_update: true,
          reason: "r",
          suggestions: [{ op: "add", scope: "project", title: "Key", content: `api_key: ${secret}` }],
        });
      },
    });
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain("ghp_aaaa");
    const saved = JSON.stringify(a.recorded[0].suggestions);
    expect(saved).not.toContain(secret);
  });

  it("parseSuggestions caps at 5 and requires a known id for update/forget", () => {
    const many = JSON.stringify({
      should_update: true,
      suggestions: Array.from({ length: 9 }, (_, i) => ({ op: "add", title: `t${i}`, content: "c" })),
    });
    expect(parseSuggestions(many, new Set())!.suggestions).toHaveLength(5);
    const bad = JSON.stringify({ should_update: true, suggestions: [{ op: "update", memory_id: "zz", title: "t", content: "c" }] });
    expect(parseSuggestions(bad, new Set(["m1"]))!.shouldUpdate).toBe(false);
    expect(parseSuggestions("```json\n{\"should_update\":false,\"suggestions\":[]}\n```", new Set())!.shouldUpdate).toBe(false);
  });
});
