/**
 * Plan 040 (P2): routing correctness.
 * - An unknown role is not Frontend; unmatched work never lands on the CTO
 *   (or any highest-priority fallback): it is BLOCKED with a reason.
 * - The planner does not silently drop nodes: work nodes stay (BLOCKED at
 *   run time), helper nodes are dropped with a visible adjustment, and a
 *   code_change on a read-only role becomes an analysis.
 * - One owner rule for fixes: the agent that wrote the code.
 * - Support has no `general` catch-all; security audits go to the Reviewer.
 */
import { describe, expect, it } from "vitest";
import { routeCapability, unroutedReason } from "@/orchestrator/capabilities";
import { ownerForFix } from "@/orchestrator/ownership";
import { evaluateDelegation } from "@/orchestrator/delegation";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";
import { classifyCommand } from "@/orchestrator/classifier";
import { createPlan, heuristicPlan } from "@/orchestrator/planner";
import { ROLES } from "@/api/convex/lib/roles";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { AgentDefinition, PlanSubtask } from "@/types";

const policy = loadPolicy();

function fixed(role: keyof typeof ROLES, id = role): AgentDefinition {
  return {
    _id: id,
    name: ROLES[role].label,
    role,
    capabilities: [...ROLES[role].capabilities],
    supportedTools: [...ROLES[role].defaultTools],
    priority: ROLES[role].priority,
    isEnabled: true,
  };
}

const team = (["cto", "designer", "frontend", "backend", "qa", "support", "devops", "reviewer", "researcher"] as const).map((role) => fixed(role));
const byRole = (role: string) => team.find((agent) => agent.role === role)!;

function resolverAnswering(content: string): TaskLlmResolver {
  return {
    handlesFor: () => [
      {
        connectionId: "",
        connectionName: "fake",
        config: { provider: "openai-compatible", model: "m", apiKey: "x", baseUrl: "http://x" } as never,
        provider: { complete: async () => ({ content }) },
      },
    ],
  } as unknown as TaskLlmResolver;
}

describe("capability routing: no fallback owner", () => {
  it("default policy has the fallback off", () => {
    expect(policy.allowFallback).toBe(false);
  });

  it("an unmatched capability routes to nobody (not the CTO)", () => {
    expect(routeCapability("quantum-gardening", team)).toBeNull();
    expect(unroutedReason("quantum-gardening", team)).toMatch(/No agent available for capability "quantum-gardening": no enabled agent declares it/);
  });

  it("even the opt-in fallback never picks the CTO", () => {
    const pick = routeCapability("quantum-gardening", [byRole("cto"), byRole("support")], { allowFallback: true });
    expect(pick?.role).toBe("support");
    expect(routeCapability("quantum-gardening", [byRole("cto")], { allowFallback: true })).toBeNull();
  });

  it("a code-writing capability goes only to a role that may write", () => {
    const designerClaimingFrontend = { ...byRole("designer"), _id: "d2", capabilities: ["frontend-development"] };
    expect(routeCapability("frontend-development", [designerClaimingFrontend, byRole("cto")])).toBeNull();
    expect(unroutedReason("frontend-development", [designerClaimingFrontend])).toMatch(/may not write files/);
    expect(routeCapability("frontend-development", team)?.role).toBe("frontend");
  });

  it("D2/D3: no Support catch-all; security-audit is the Reviewer's; conversation is Support's (O1)", () => {
    expect(ROLES.support.capabilities).not.toContain("general");
    expect(routeCapability("general", team)).toBeNull();
    expect(routeCapability("security-audit", team)?.role).toBe("reviewer");
    expect(ROLES.cto.capabilities).not.toContain("project-coordination");
    expect(classifyCommand("hi").suggestedCapabilities).toEqual(["documentation-support"]);
  });

  it("a custom role with a frontend capability routes by capability", () => {
    const custom: AgentDefinition = { _id: "cx", name: "Custom", role: "custom-x", capabilities: ["frontend-development"], supportedTools: ["read_file", "write_file"], isEnabled: true };
    expect(routeCapability("frontend-development", [custom, byRole("cto")])?._id).toBe("cx");
    const noTools: AgentDefinition = { ...custom, _id: "cy", supportedTools: ["read_file"] };
    expect(routeCapability("frontend-development", [noTools, byRole("cto")])).toBeNull();
  });
});

describe("planner: nodes are never dropped silently", () => {
  it("conversation reply goes to the topic owner (Support by default), not the CTO (O1)", () => {
    const plan = heuristicPlan({ command: "hello", classification: classifyCommand("hello"), agents: team, policy });
    expect(plan.subtasks[0].capability).toBe("documentation-support");
    expect(routeCapability(plan.subtasks[0].capability, team)?.role).toBe("support");
  });

  it("unroutable work stays (blocked), unroutable helpers drop visibly, a Designer code_change becomes analysis", async () => {
    const llmPlan = JSON.stringify({
      goal: "Build pricing page",
      strategy: "dag",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        { key: "design", title: "Design pricing", description: "pricing layout spec", kind: "code_change", capability: "ui-ux-design", dependencies: [], order: 0 },
        { key: "impl", title: "Implement pricing", description: "edit app/pricing/page.tsx", kind: "code_change", capability: "frontend-development", dependencies: ["design"], order: 1 },
        { key: "ml", title: "Train model", description: "edit ml/train.py", kind: "code_change", capability: "ml-engineering", dependencies: [], order: 2 },
        { key: "astro", title: "Horoscope", description: "read the stars", kind: "analysis", capability: "astrology", dependencies: [], order: 3 },
      ],
    });
    const command = "Build the pricing page";
    const result = await createPlan({
      command,
      classification: classifyCommand(command),
      agents: team,
      policy: { ...policy, reviewMode: "never", qaMode: "never" },
      llmResolver: resolverAnswering(llmPlan),
    });
    const keys = result.plan.subtasks.map((s) => s.key);
    expect(keys).toContain("ml");
    expect(keys).not.toContain("astro");
    expect(result.plan.subtasks.find((s) => s.key === "design")?.kind).toBe("analysis");
    const actions = Object.fromEntries((result.routingAdjustments ?? []).map((a) => [a.key, a.action]));
    expect(actions).toMatchObject({ design: "made_read_only", ml: "blocked", astro: "dropped" });
    expect((result.routingAdjustments ?? []).every((a) => a.reason.length > 0)).toBe(true);
    expect(result.droppedHintKeys).toEqual(["astro"]);
  });
});

describe("one fix-owner rule: the agent that wrote the code", () => {
  const subtasks: PlanSubtask[] = [
    { key: "fe", title: "fe", description: "", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, allowedPaths: ["apps/web"] },
    { key: "be", title: "be", description: "", kind: "code_change", capability: "backend-development", dependencies: [], order: 1, allowedPaths: ["apps/api/convex"] },
    { key: "docs", title: "docs", description: "", kind: "analysis", capability: "documentation-support", dependencies: [], order: 2 },
  ];
  const writer = { ...byRole("backend"), _id: "be-2", name: "Backend 2" };
  const writerByKey = new Map([["be", writer]]);

  it("a finding in a backend file goes to the agent that ran the backend node", () => {
    const owner = ownerForFix({ subtasks, findings: [{ filePath: "apps/api/convex/tasks.ts" }], agents: [...team, writer], writerByKey });
    expect(owner?.subtask.key).toBe("be");
    expect(owner?.agent._id).toBe("be-2");
  });

  it("without a recorded writer, the owner subtask's capability decides", () => {
    const owner = ownerForFix({ subtasks, findings: [{ filePath: "apps/web/app/page.tsx" }], agents: team });
    expect(owner?.agent.role).toBe("frontend");
  });

  it("no implementation subtask → nobody (never Support / general)", () => {
    expect(ownerForFix({ subtasks: [subtasks[2]], findings: [{ filePath: "README.md" }], agents: team })).toBeNull();
  });

  it("orchestrator critical findings → the actual implementer, not the first Frontend", () => {
    const evaluation = evaluateDelegation({
      result: {
        agentId: "reviewer",
        agentName: "Reviewer",
        capability: "security-audit",
        success: true,
        summary: "found an authz hole",
        findings: [{ severity: "critical", filePath: "apps/api/convex/tasks.ts", description: "missing authz", suggestion: "" }],
      } as never,
      classification: classifyCommand("audit security"),
      agents: [...team, writer],
      budget: new BudgetTracker(policy),
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
      planSubtasks: subtasks,
      writerByKey,
    });
    expect(evaluation.decision).toBe("REVISE");
    expect(evaluation.targetAgent?._id).toBe("be-2");
    expect(evaluation.targetCapability).toBe("backend-development");
  });
});
