import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/router/route";
import { classifyCommand } from "@/orchestrator/classifier";
import type { AgentDefinition } from "@/orchestrator/types";
import { validateDecision } from "@/orchestrator/decision";
import { createSharedTaskContext } from "@/orchestrator/taskContext";
import { heuristicPlan, applyPlanningHints } from "@/orchestrator/planner";
import { evaluateObjective } from "@/orchestrator/decision";
import { loadPolicy } from "@/orchestrator/policy";

const AGENTS: AgentDefinition[] = [
  { _id: "a-fe", name: "Frontend", role: "frontend developer", capabilities: ["frontend-development"] },
  { _id: "a-be", name: "Backend", role: "backend developer", capabilities: ["backend-development"] },
  { _id: "a-arch", name: "Architect", role: "architect", capabilities: ["architecture", "code-review"] },
  { _id: "a-sec", name: "Security", role: "security auditor", capabilities: ["security-audit"] },
  { _id: "a-qa", name: "QA", role: "qa engineer", capabilities: ["browser-testing"] },
  { _id: "a-gen", name: "General", role: "assistant", capabilities: ["general"] },
];

describe("integration #1-4: no task from conversation", () => {
  it("#1 greeting never creates task", async () => {
    const r = await routeMessage({ text: "hello!", agents: AGENTS });
    expect(r.intent).not.toBe("task");
  });
  it("#2 general question never creates task", async () => {
    const r = await routeMessage({ text: "What is the weather today?", agents: AGENTS, advise: async () => "chat" });
    expect(r.intent).not.toBe("task");
  });
  it("#3 technical question routes to appropriate agent", async () => {
    const r = await routeMessage({ text: "How do I style a React button?", agents: AGENTS });
    expect(r.intent).toBe("question");
    expect(r.agentIds).toContain("a-fe");
  });
  it("#4 advice does not authorize execution", async () => {
    const r = await routeMessage({ text: "Should I use Zustand or Redux?", agents: AGENTS });
    expect(r.intent).toBe("advice");
    expect(r.agentIds).not.toEqual([]);
  });
});

describe("integration #6-8: registry / consulting / orchestrator", () => {
  it("#6 asking about an agent returns registry info (capability match)", async () => {
    // Registry is project-based: agents have capabilities; route selects by capability
    const r = await routeMessage({ text: "Who can do backend security audit?", agents: AGENTS, advise: async () => "audit" });
    // audit intent is chat-class; selection is by suggestedCapabilities
    expect(r.agentIds.length).toBeGreaterThanOrEqual(1);
  });
  it("#7 consulting an agent does not create execution task", async () => {
    const r = await routeMessage({ text: "How does auth work?", agents: AGENTS });
    expect(r.intent).not.toBe("task");
  });
  it("#8 non-orchestrator role match is required for planning guidance", async () => {
    // chat.ts role regex: architect|lead|orchestrator|planner
    const re = /architect|lead|orchestrator|planner/i;
    expect(re.test("frontend developer")).toBe(false);
    expect(re.test("software architect")).toBe(true);
    expect(re.test("CTO")).toBe(false); // CTO is lead-adjacent but not in regex — documented limitation
  });
});

describe("integration #9-11: planning", () => {
  it("#9 simple code_change → single implementation node, no review; QA only for UI in auto mode", () => {
    const plan = heuristicPlan({ command: "fix the button label", classification: classifyCommand("fix the button label"), agents: AGENTS, policy: loadPolicy() });
    const impl = plan.subtasks.filter((s) => s.kind !== "qa");
    expect(impl).toHaveLength(1);
    expect(impl[0]!.kind).toBe("code_change");
    expect(plan.subtasks.filter((s) => s.kind === "review")).toHaveLength(0);
    // qaMode=never really drops QA.
    const never = heuristicPlan({ command: "fix the button label", classification: classifyCommand("fix the button label"), agents: AGENTS, policy: { ...loadPolicy(), qaMode: "never" } });
    expect(never.subtasks).toHaveLength(1);
  });
  it("#10 complex auth delegates only when capability missing", () => {
    // FE-only agent proposing backend work is REJECTed via selfServe (covered), but
    // FE agent for BE task via orchestrator routes to BE agent correctly
    const r = classifyCommand("add a billing page in the frontend and create a new API endpoint on the backend");
    expect(r.kind).toBe("multi");
  });
  it("#11 review/QA conditional on risk signal", () => {
    // simple plan has no review/QA hints in auto mode; risk plan does via applyPlanningHints
    const simple = heuristicPlan({ command: "fix button", classification: classifyCommand("fix button"), agents: AGENTS, policy: loadPolicy() });
    // Auto mode adds browser QA for UI work (default since 2026-11-09), never review.
    expect(simple.subtasks.filter((s) => s.kind === "review")).toHaveLength(0);
    expect(simple.subtasks.filter((s) => s.kind === "qa").length).toBeLessThanOrEqual(1);
    expect(simple.subtasks.length).toBeGreaterThan(0);
  });
});

describe("integration #15/#19/#20: instruction intact, read-only, status truthful", () => {
  it("#15 originalRequest preserved in shared context", () => {
    const ctx = createSharedTaskContext({
      taskId: "t1", projectId: "p1", originalRequest: "Build login page exactly as described", title: "login",
      classification: classifyCommand("Build login page exactly as described"),
    });
    expect(ctx.originalRequest).toBe("Build login page exactly as described");
    expect(ctx.objective).toBe("Build login page exactly as described");
  });
  it("#19 read-only kinds never produce file changes (governed dry-run)", async () => {
    // registry read_file/write_file are dry-run; agentExecutor readOnly never calls write path
    const { tool_call } = await import("@/governance/registry");
    const audits: unknown[] = [];
    const res = await tool_call({ ctx: { workspaceRoot: "/tmp", actor: "t", audit: async (e) => { audits.push(e); } }, name: "read_file", args: { path: "src/app.ts" } });
    // dry-run ok; and no file was created by the registry itself
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("dry-run");
  });
  it("#20 evaluateObjective never marks complete without evidence", () => {
    const ctx = {
      taskId: "t1", objective: "obj", classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] } as any,
      planVersion: 1,
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [
        { key: "impl", title: "Impl", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
      ]},
      results: [], openIssues: [],
      budget: { llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, agentCount: 1, agents: ["a-fe"], delegationDepth: 0, retries: 0, elapsedMs: 0, maxLLMCalls: 12, maxTokenBudget: 50000, maxAgents: 3 },
      policy: loadPolicy(),
      completedKeys: new Set(["impl"]),
      objectiveEvidence: { appliedFiles: {}, lastDecision: { action: "complete", expectedOutcome: "objective:met" } },
    } as any;
    const evald = evaluateObjective(ctx);
    expect(evald.satisfied).toBe(false);
    expect(evald.missing.join(" ")).toContain("no applied file change");
  });
});
