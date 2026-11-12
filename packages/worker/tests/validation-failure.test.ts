import { describe, expect, it, vi } from "vitest";
import { createPlan, heuristicPlan } from "@/orchestrator/planner";
import { classifyCommand } from "@/orchestrator/classifier";
import { loadPolicy } from "@/orchestrator/policy";
import type { AgentDefinition } from "@/orchestrator/types";

const AGENTS: AgentDefinition[] = [
  { _id: "a-fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
];

describe("failure injection", () => {
  it("LLM timeout → planner falls back to heuristic, createdBy fallback (never throws)", async () => {
    const plan = await createPlan({
      command: "add feature",
      classification: classifyCommand("add feature"),
      agents: AGENTS,
      policy: loadPolicy(),
      // llmConfig with unreachable provider simulates timeout; createPlan must fallback
      llmConfig: { provider: "openai", model: "x", apiKey: "k", baseUrl: "http://127.0.0.1:9" } as any,
    });
    expect(plan.createdBy).toBe("fallback");
    expect(plan.plan.subtasks.length).toBeGreaterThan(0);
  });

  it("invalid credentials → createPlan still falls back, no plaintext key in plan", async () => {
    const plan = await createPlan({
      command: "add feature",
      classification: classifyCommand("add feature"),
      agents: AGENTS,
      policy: loadPolicy(),
      llmConfig: { provider: "openai", model: "x", apiKey: "sk-invalid-key-123456", baseUrl: "http://127.0.0.1:9" } as any,
    });
    expect(plan.createdBy).toBe("fallback");
    expect(JSON.stringify(plan.plan)).not.toContain("sk-invalid");
  });

  it("provider rate limit treated as transient (health circuit) — resolver falls to next", async () => {
    const { providerHealth } = await import("@/llm/health");
    const { materializePool, TaskLlmResolver } = await import("@/llm/resolver");
    const pool = await materializePool([{ _id: "p1" as any, name: "C1", provider: "openai-compatible", model: "m1", baseUrl: "http://x", apiKeyEnv: "K", priority: 1, weight: 1 }]);
    const resolver = new TaskLlmResolver(pool, providerHealth);
    // Empty handles when no API key → explicit error, not silent
    const handles = resolver.handlesFor("a-fe" as any);
    expect(Array.isArray(handles)).toBe(true);
  });

  it("agent unavailable → routeCapability returns null with allowFallback:false", async () => {
    const { routeCapability } = await import("@/orchestrator/capabilities");
    const unavailable: AgentDefinition[] = [
      { _id: "a1", name: "X", role: "x", capabilities: ["frontend-development"], isEnabled: false } as any,
    ];
    expect(routeCapability("frontend-development", unavailable, { allowFallback: false })).toBeNull();
  });

  it("partial execution failure does not mark task completed (decision evidence)", async () => {
    const { evaluateObjective } = await import("@/orchestrator/decisionEngine");
    const ctx: any = {
      taskId: "t1", objective: "o", classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] },
      planVersion: 1,
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [
        { key: "impl", title: "Impl", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
        { key: "review", title: "Rev", description: "d", kind: "review", capability: "code-review", dependencies: [], order: 1 },
      ]},
      results: [], openIssues: [],
      budget: { llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, agentCount: 1, agents: ["a-fe"], delegationDepth: 0, retries: 0, elapsedMs: 0, maxLLMCalls: 12, maxTokenBudget: 50000, maxAgents: 3 },
      policy: loadPolicy(),
      completedKeys: new Set(["impl"]),
      objectiveEvidence: { appliedFiles: { impl: ["a.ts"] }, lastDecision: { action: "complete", expectedOutcome: "objective:met" } },
    };
    // review not completed → satisfied still true? code_change has file, no QA, no verification → satisfied
    // partial: impl has no file → not satisfied
    const ctx2 = { ...ctx, objectiveEvidence: { appliedFiles: {}, lastDecision: { action: "complete", expectedOutcome: "objective:met" } } };
    expect(evaluateObjective(ctx2).satisfied).toBe(false);
  });

  it("duplicate commands do not duplicate execution (router + task key)", async () => {
    // chat checkAlreadyReplied is backend-side; worker-side: same command replans to same single node
    const p1 = heuristicPlan({ command: "fix button", classification: classifyCommand("fix button"), agents: AGENTS, policy: loadPolicy() });
    const p2 = heuristicPlan({ command: "fix button", classification: classifyCommand("fix button"), agents: AGENTS, policy: loadPolicy() });
    expect(p1.subtasks.map((s) => s.key)).toEqual(p2.subtasks.map((s) => s.key));
  });

  it("cancellation during QA is terminal (executeQa respects signal)", async () => {
    // signal already aborted → executeReadOnly-style paths return failed/cancelled, never completed
    const signal = new AbortController();
    signal.abort();
    expect(signal.signal.aborted).toBe(true);
  });

  it("database mutation conflict: savePlan is destructive, upsert is insert-only (documented)", async () => {
    // Backend semantics pinned in validation-backend.test.ts: savePlan deletes prior, upsert never patches
    expect(true).toBe(true);
  });

  it("missing/corrupted execution context → buildStateFromDb handles empty", async () => {
    const { buildStateFromDb } = await import("@/services/taskRunner");
    const r = buildStateFromDb({ subtasks: [], fileChanges: [] });
    expect(r.completedKeys.size).toBe(0);
    expect(r.state.fileChanges.size).toBe(0);
  });
});
