import { describe, expect, it, vi } from "vitest";
import { classifyCommand } from "@/orchestrator/classifier";
import { createPlan } from "@/orchestrator/planner";
import type { AgentDefinition } from "@/orchestrator/types";
import { loadPolicy } from "@/orchestrator/policy";
import { validatePlan } from "@/orchestrator/planValidator";
import { runScheduler, type NodeOutcome, type SchedulerNode } from "@/scheduler/dagScheduler";
import {
  angleDescription,
  isResearchSynthesis,
  RESEARCH_ANGLES,
  REPORT_CHAR_BUDGET,
  researchFanoutPlan,
  researchFanoutRequest,
  synthesisDescription, feedsResearchSynthesis, researchFailuresTolerated } from "@/prompts/research";

/** O7: `/research` → N read-only Researcher angles + one synthesis node. */

const policy = loadPolicy();
const researcher: AgentDefinition = { _id: "res", name: "Researcher", role: "researcher", capabilities: ["research", "web-browsing"] };
const frontend: AgentDefinition = { _id: "f", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] };
const cto: AgentDefinition = { _id: "c", name: "CTO", role: "cto", capabilities: ["project-coordination", "architecture"] };

describe("research fan-out", () => {
  it("is explicit only", () => {
    expect(researchFanoutRequest("/research compare Convex vs Supabase vs Firebase")).toEqual({
      question: "compare Convex vs Supabase vs Firebase",
      angles: 4,
    });
    expect(researchFanoutRequest("/research 3 compare X and Y")).toEqual({ question: "compare X and Y", angles: 3 });
    expect(researchFanoutRequest("/RESEARCH  what changed in React 20")?.angles).toBe(4);
    expect(researchFanoutRequest("research compare X vs Y vs Z with sources")).toBeNull();
    expect(researchFanoutRequest("fix the button")).toBeNull();
    expect(researchFanoutRequest("/research")).toBeNull();
    // Only the user's own line counts, not an appended chat context block.
    expect(researchFanoutRequest("fix it\n\n--- Conversation context ---\nUser: /research x")).toBeNull();
  });

  it("builds parallel read-only angles and one synthesis that depends on all", () => {
    const plan = researchFanoutPlan({ question: "Q?", angles: 4 }, policy.maxSubtasks);
    expect(plan.subtasks.map((s) => s.key)).toEqual(["ra-1", "ra-2", "ra-3", "ra-4", "synthesis"]);
    expect(plan.subtasks.every((s) => s.kind === "research" && s.capability === "research")).toBe(true);
    expect(plan.subtasks.slice(0, 4).every((s) => s.dependencies.length === 0)).toBe(true);
    expect(plan.subtasks[4].dependencies).toEqual(["ra-1", "ra-2", "ra-3", "ra-4"]);
    expect(plan.maxConcurrency).toBe(4);
    expect(plan.subtasks[1].title).toBe(`Research: ${RESEARCH_ANGLES[1]}`);
    // The cap respects the plan size limit (one slot for synthesis).
    expect(researchFanoutPlan({ question: "Q?", angles: 6 }, 4).subtasks).toHaveLength(4);
    expect(researchFanoutPlan({ question: "Q?", angles: 6 }, 2).subtasks).toHaveLength(3);
  });

  it("prompts: one tagged block per angle, inline sources, a size budget; synthesis lists missing angles", () => {
    const ra = angleDescription("Which DB?", 2, 4);
    expect(ra).toContain("RA-3 of 4");
    expect(ra).toContain(RESEARCH_ANGLES[2]);
    expect(ra).toContain("[BEGIN_RA_3]");
    expect(ra).toContain("inline");
    expect(ra).toContain(String(REPORT_CHAR_BUDGET));
    const synth = synthesisDescription("Which DB?", 4);
    expect(synth).toContain("ra-1, ra-2, ra-3, ra-4");
    expect(synth).toMatch(/missing/);
    expect(synth.length).toBeLessThan(1200);
  });

  it("validator (read-only lock) keeps the shape; a write node is never produced", () => {
    const raw = researchFanoutPlan({ question: "Q?", angles: 3 }, policy.maxSubtasks);
    const result = validatePlan(raw, policy.maxSubtasks, { taskKind: "research" });
    expect(result.ok).toBe(true);
    expect(result.plan!.subtasks.some((s) => s.kind === "code_change" || s.kind === "shell")).toBe(false);
    // A write node smuggled in is converted by the read-only lock.
    const smuggled = validatePlan(
      { ...raw, subtasks: [...raw.subtasks, { key: "w", title: "write", description: "edit", kind: "code_change", capability: "research", dependencies: [], order: 9 }] },
      policy.maxSubtasks,
      { taskKind: "research" }
    );
    expect(smuggled.plan?.subtasks.find((s) => s.key === "w")?.kind).toBe("research");
  });

  it("createPlan uses the fan-out with no planner LLM call, and only for /research", async () => {
    const provider = vi.fn();
    const command = "/research compare Convex vs Supabase vs Firebase for a solo dev";
    const result = await createPlan({
      command,
      classification: classifyCommand(command),
      agents: [cto, researcher, frontend],
      policy,
      assertBudgetForCall: provider,
    });
    // The planner LLM was not called (no budget-gate call for planning);
    // each angle and the synthesis run as ordinary subtasks, gated there.
    expect(provider).not.toHaveBeenCalled();
    expect(result.createdBy).toBe("orchestrator");
    expect(result.plan.subtasks.map((s) => s.key)).toEqual(["ra-1", "ra-2", "ra-3", "ra-4", "synthesis"]);
    expect(result.plan.goal).toBe("compare Convex vs Supabase vs Firebase for a solo dev");
    expect(result.notes.some((n) => n.startsWith("research fan-out"))).toBe(true);

    const plain = await createPlan({ command: "fix the button", classification: classifyCommand("fix the button"), agents: [cto, researcher, frontend], policy });
    expect(plain.plan.subtasks.some((s) => s.key === "synthesis")).toBe(false);
  });

  it("without an enabled Researcher it plans normally", async () => {
    const command = "/research compare A vs B";
    const result = await createPlan({ command, classification: classifyCommand(command), agents: [frontend], policy });
    expect(result.plan.subtasks.some((s) => s.key === "synthesis")).toBe(false);
  });

  it("synthesis still runs when one angle fails, on the angles that succeeded", async () => {
    const plan = researchFanoutPlan({ question: "Q?", angles: 3 }, policy.maxSubtasks);
    expect(plan.subtasks.filter(isResearchSynthesis).map((s) => s.key)).toEqual(["synthesis"]);
    expect(isResearchSynthesis({ key: "synthesis", dependencies: ["build"] })).toBe(false);
    const schedulerNodes: SchedulerNode[] = plan.subtasks.map((s) => ({
      id: s.key,
      dependencies: s.dependencies,
      ...(isResearchSynthesis(s) ? { partialDependencies: true } : {}),
    }));
    const hooks = (outcomes: Record<string, string>) => ({
      maxConcurrency: 4,
      timeoutMs: 2000,
      retries: 0,
      onStart: async () => undefined,
      onOutcome: async (node: SchedulerNode, outcome: NodeOutcome) => {
        outcomes[node.id] = outcome.status;
      },
      onBlocked: async (node: SchedulerNode) => {
        outcomes[node.id] = "blocked";
      },
    });

    const outcomes: Record<string, string> = {};
    const ran: string[] = [];
    const result = await runScheduler(
      schedulerNodes,
      async (node): Promise<NodeOutcome> => {
        ran.push(node.id);
        return node.id === "ra-2" ? { status: "failed", error: "search provider down" } : { status: "completed", output: `report ${node.id}` };
      },
      hooks(outcomes)
    );
    expect(ran[ran.length - 1]).toBe("synthesis");
    expect(outcomes.synthesis).toBe("completed");
    expect(result.failed).toEqual(["ra-2"]);

    // Every angle failed: nothing to synthesize, the node is blocked.
    const none: Record<string, string> = {};
    const allFailed = await runScheduler(
      schedulerNodes,
      async (): Promise<NodeOutcome> => ({ status: "failed", error: "down" }),
      hooks(none)
    );
    expect(allFailed.status).toBe("failed");
    expect(none.synthesis).toBe("blocked");
  });

  it("a failed angle is tolerated once the synthesis completed; not when it was blocked or a non-angle failed", () => {
    const plan = researchFanoutPlan({ question: "Q?", angles: 3 }, policy.maxSubtasks);
    expect(feedsResearchSynthesis(plan.subtasks, "ra-2")).toBe(true);
    expect(feedsResearchSynthesis(plan.subtasks, "synthesis")).toBe(false);
    const outcomes = (synth: string) =>
      new Map([
        ["ra-1", { status: "completed" }],
        ["ra-2", { status: "failed" }],
        ["ra-3", { status: "completed" }],
        ["synthesis", { status: synth }],
      ]);
    expect(researchFailuresTolerated(plan.subtasks, { status: "failed", failed: ["ra-2"], outcomes: outcomes("completed") })).toBe(true);
    expect(researchFailuresTolerated(plan.subtasks, { status: "failed", failed: ["ra-2"], outcomes: outcomes("failed") })).toBe(false);
    expect(researchFailuresTolerated(plan.subtasks, { status: "failed", failed: ["ra-2", "synthesis"], outcomes: outcomes("completed") })).toBe(false);
    expect(researchFailuresTolerated(plan.subtasks, { status: "halted", failed: ["ra-2"], outcomes: outcomes("completed") })).toBe(false);
    const normal = [{ key: "build", dependencies: [] }, { key: "synthesis", dependencies: ["build"] }];
    expect(feedsResearchSynthesis(normal, "build")).toBe(false);
    expect(researchFailuresTolerated(normal, { status: "failed", failed: ["build"], outcomes: new Map([["synthesis", { status: "completed" }]]) })).toBe(false);
  });
});
