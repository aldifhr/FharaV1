import { describe, expect, it, vi } from "vitest";
import { classifyCommand, isGreeting } from "@/orchestrator/classifier";
import { routeMessage, type RouterInput } from "@/router/route";
import type { AgentDefinition } from "@/orchestrator/types";
import { applyDecision, validateDecision, type DecisionContext, type DecisionObservation } from "@/orchestrator/decision";
import { loadPolicy } from "@/orchestrator/policy";
import { buildAgentExecutionContext } from "@/orchestrator/agentContext";
import type { SharedTaskContext } from "@/orchestrator/taskContext";

const agents: AgentDefinition[] = [
  { _id: "a-fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
  { _id: "a-be", name: "Backend", role: "backend", capabilities: ["backend-development"] },
  { _id: "a-cto", name: "CTO", role: "cto", capabilities: ["architecture"] },
];

describe("validation-unit: classifier edges", () => {
  it("empty / whitespace is conversation direct", () => {
    expect(classifyCommand("").kind).toBe("conversation");
    expect(classifyCommand("   ").kind).toBe("conversation");
  });
  it("greeting variants", () => {
    for (const t of ["Hi!!", "halo", "good morning", "hai", "hey!"]) {
      expect(isGreeting(t)).toBe(true);
    }
  });
  it("Indonesian change verbs are code_change", () => {
    for (const t of ["tambah halaman login", "buat komponen baru", "perbaiki tombol", "hapus file lama"]) {
      expect(classifyCommand(t).kind).toBe("code_change");
    }
  });
  it("audit-only with change verb is not audit", () => {
    // AUDIT_ONLY requires changeVerb absence for audit kind
    const r = classifyCommand("add a security audit to the auth flow");
    expect(r.kind).not.toBe("audit");
  });
  it("question with change verb is code_change in classifier, question in router", async () => {
    const r = classifyCommand("How do I create a new API endpoint?");
    expect(r.kind).toBe("code_change"); // classifier is naive
    const { routeMessage } = await import("@/router/route");
    const routed = await routeMessage({ text: "How do I create a new API endpoint?", agents });
    expect(routed.intent).toBe("question");
  });
});

describe("validation-unit: router edges", () => {
  it("advisor is NOT called for clear intents", async () => {
    const advise = vi.fn(async () => "task");
    await routeMessage({ text: "Add a login form", agents, advise });
    expect(advise).not.toHaveBeenCalled();
    await routeMessage({ text: "hello!", agents, advise });
    expect(advise).not.toHaveBeenCalled();
  });
  it("chatMaxAgents clamps to >=1", async () => {
    const r = await routeMessage({ text: "hello!", agents, chatMaxAgents: 0 });
    expect(r.agentIds.length).toBeGreaterThanOrEqual(1);
    expect(r.agentIds.length).toBe(1);
  });
  it("advisor returning uppercase TASK is invalid → chat fallback", async () => {
    const r = await routeMessage({ text: "kadas aksjfd", agents, advise: async () => "TASK" });
    expect(r.intent).toBe("chat");
  });
  it("advisor returning empty string → chat fallback", async () => {
    const r = await routeMessage({ text: "kadas aksjfd", agents, advise: async () => "" });
    expect(r.intent).toBe("chat");
  });
  it("empty text → chat", async () => {
    const r = await routeMessage({ text: "", agents });
    expect(r.intent).toBe("chat");
  });
});

describe("validation-unit: decision applyDecision", () => {
  function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
    return {
      taskId: "t1",
      objective: "Build login",
      classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: ["frontend-development"] } as any,
      planVersion: 1,
      plan: {
        version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1,
        subtasks: [{ key: "impl", title: "Impl", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 }],
      },
      results: [], openIssues: [],
      budget: { llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, agentCount: 1, agents: ["a-fe"], delegationDepth: 0, retries: 0, elapsedMs: 0, maxLLMCalls: 12, maxTokenBudget: 50000, maxAgents: 3 },
      policy: loadPolicy(),
      ...over,
    } as DecisionContext;
  }
  const uniqueKey = (base: string) => `${base}_1`;
  function ctx2(over: Partial<DecisionContext> = {}): DecisionContext {
    return { ...ctx(over), completedKeys: new Set() } as DecisionContext;
  }
  it("applyDecision execute returns a node with the given key", () => {
    const c = ctx2();
    const target = { key: "new-sub", title: "New", description: "d", capability: "frontend-development", kind: "code_change" as const } as any;
    const result = applyDecision(c, { action: "execute", reasoning: "do it", task: target, id: "d1", decidedBy: "deterministic" } as any, uniqueKey);
    expect(result.kind).toBe("nodes");
    if (result.kind === "nodes") {
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.key).toBe("new-sub");
      expect(result.nodes[0]!.kind).toBe("code_change");
    }
  });
  it("applyDecision delegate without task/target returns []", () => {
    const c = ctx2();
    const result = applyDecision(c, { action: "delegate", reasoning: "delegate", id: "d1", decidedBy: "deterministic" } as any, uniqueKey);
    expect(result).toEqual({ kind: "nodes", nodes: [] });
  });
  it("kindForCapability maps browser-testing to qa via delegate target", () => {
    const c = ctx2();
    const r = applyDecision(c, { action: "delegate", reasoning: "x", target: { capability: "browser-testing" }, id: "d1", decidedBy: "deterministic" } as any, uniqueKey);
    expect(r.kind).toBe("nodes");
    if (r.kind === "nodes") {
      expect(r.nodes[0]?.kind).toBe("qa");
    }
  });
  it("applyDecision replan carries the reasoning as feedback", () => {
    const c = ctx2();
    const r = applyDecision(c, { action: "replan", reasoning: "objective not satisfied: qa-validate: QA verdict is missing", expectedOutcome: "recovery", id: "d1", decidedBy: "deterministic" } as any, uniqueKey);
    expect(r).toEqual({ kind: "replan", reason: "objective not satisfied: qa-validate: QA verdict is missing" });
  });
  it("applyDecision complete with a budget outcome halts; other completes finalize", () => {
    const c = ctx2();
    const blocked = applyDecision(c, { action: "complete", reasoning: "budget exhausted", expectedOutcome: "policy:budget", id: "d1", decidedBy: "deterministic" } as any, uniqueKey);
    expect(blocked.kind).toBe("halt");
    const met = applyDecision(c, { action: "complete", reasoning: "all done", expectedOutcome: "objective:met", id: "d2", decidedBy: "deterministic" } as any, uniqueKey);
    expect(met).toEqual({ kind: "complete", expectedOutcome: "objective:met" });
  });
  it("applyDecision ask_user is a recorded outcome until step 4", () => {
    const c = ctx2();
    const r = applyDecision(c, { action: "ask_user", reasoning: "need direction", question: "Which style?", id: "d1", decidedBy: "deterministic" } as any, uniqueKey);
    expect(r).toEqual({ kind: "ask_user", question: "Which style?" });
  });
});

describe("validation-unit: policy env parsing", () => {
  it("intFromEnv clamps NaN/floor/min/max", () => {
    // loadPolicy reads env at call time
    process.env.ORCHESTRATOR_MAX_SUBTASKS = "abc";
    expect(loadPolicy().maxSubtasks).toBeGreaterThanOrEqual(1);
    process.env.ORCHESTRATOR_MAX_SUBTASKS = "3.9";
    expect(loadPolicy().maxSubtasks).toBe(3);
    delete process.env.ORCHESTRATOR_MAX_SUBTASKS;
  });
  it("defaults to sequential: one subtask and one LLM call at a time", () => {
    delete process.env.ORCHESTRATOR_MAX_CONCURRENCY;
    delete process.env.ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS;
    const p = loadPolicy();
    expect(p.maxConcurrency).toBe(1);
    expect(p.maxConcurrentLLMCalls).toBe(1);
  });
  it("boolFromEnv false vocab", () => {
    process.env.ORCHESTRATOR_VERIFICATION_ENABLED = "off";
    expect(loadPolicy().verificationEnabled).toBe(false);
    process.env.ORCHESTRATOR_VERIFICATION_ENABLED = "garbage";
    expect(loadPolicy().verificationEnabled).toBe(true);
    delete process.env.ORCHESTRATOR_VERIFICATION_ENABLED;
  });
  it("planningMode invalid falls back to auto", () => {
    process.env.ORCHESTRATOR_REVIEW_MODE = "bogus";
    expect(loadPolicy().reviewMode).toBe("auto");
    delete process.env.ORCHESTRATOR_REVIEW_MODE;
  });
  it("routerLlmMode / decisionLlmMode case/whitespace insensitive", () => {
    process.env.ORCHESTRATOR_ROUTER_LLM = " ALWAYS ";
    expect(loadPolicy().routerLlmMode).toBe("always");
    delete process.env.ORCHESTRATOR_ROUTER_LLM;
    process.env.ORCHESTRATOR_DECISION_LLM = "off";
    expect(loadPolicy().decisionLlmMode).toBe("off");
    delete process.env.ORCHESTRATOR_DECISION_LLM;
  });
});

describe("validation-unit: agentContext edges", () => {
  const base: SharedTaskContext = {
    taskId: "t1", projectId: "p1", originalRequest: "req", objective: "obj", title: "t",
    classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] } as any,
    status: "RUNNING", decisions: [], agentExecutions: [], artifacts: [], outstandingIssues: [], updatedAt: 1,
  };
  const agent: AgentDefinition = { _id: "a1", name: "Coder", role: "dev", capabilities: ["frontend-development"] };
  it("most-recent execution always included even when capability differs", () => {
    const ctx = buildAgentExecutionContext({
      taskContext: {
        ...base,
        agentExecutions: [
          { agentName: "Other", capability: "security-audit", subtaskKey: "k1", title: "t", status: "COMPLETED", summary: "old-unrelated" },
          { agentName: "Other2", capability: "security-audit", subtaskKey: "k2", title: "t", status: "COMPLETED", summary: "most-recent" },
        ],
      },
      agent, assignment: "work", maxPreviousResults: 5,
    });
    expect(ctx.previousResults.map((r) => r.summary)).toContain("most-recent");
  });
  it("maxPreviousResults is respected (cap 3)", () => {
    const ex = Array.from({ length: 10 }, (_, i) => ({
      agentName: "Coder", capability: "frontend-development", subtaskKey: `k${i}`, title: "t", status: "COMPLETED" as const, summary: `s${i}`,
    }));
    const ctx = buildAgentExecutionContext({ taskContext: { ...base, agentExecutions: ex }, agent, assignment: "work", maxPreviousResults: 5 });
    expect(ctx.previousResults.length).toBeLessThanOrEqual(3);
  });
  it("closed/resolved issues are excluded", () => {
    const ctx = buildAgentExecutionContext({
      taskContext: { ...base, outstandingIssues: [
        { id: "1", description: "open one", severity: "high", status: "open" },
        { id: "2", description: "closed one", severity: "high", status: "resolved" },
      ]},
      agent, assignment: "work",
    });
    expect(ctx.outstandingIssues.map((i) => i.description)).toEqual(["open one"]);
  });
});

describe("validation-unit: compaction boundaries", () => {
  it("exactly 40 messages does NOT compact; 41 does", async () => {
    const { shouldCompact } = await import("@/context/compaction");
    const mk = (n: number) => Array.from({ length: n }, () => ({ authorType: "user" as const, content: "x" }));
    expect(shouldCompact(mk(40))).toBe(false);
    expect(shouldCompact(mk(41))).toBe(true);
  });
  it("exactly 24k chars does NOT compact; 24k+1 does", async () => {
    const { shouldCompact } = await import("@/context/compaction");
    expect(shouldCompact([{ authorType: "user", content: "x".repeat(24000) }])).toBe(false);
    expect(shouldCompact([{ authorType: "user", content: "x".repeat(24001) }])).toBe(true);
  });
  it("compactIfNeeded propagates budget throw and summarize throw", async () => {
    const { compactIfNeeded } = await import("@/context/compaction");
    const big = Array.from({ length: 41 }, () => ({ authorType: "user" as const, content: "x" }));
    await expect(compactIfNeeded({
      history: big,
      assertBudgetForCall: () => { throw new Error("Budget exhausted"); },
      summarize: async () => "s",
    })).rejects.toThrowError("Budget exhausted");
    await expect(compactIfNeeded({
      history: big,
      summarize: async () => { throw new Error("llm down"); },
    })).rejects.toThrowError("llm down");
  });
});
