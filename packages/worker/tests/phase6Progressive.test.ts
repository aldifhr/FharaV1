import { describe, it, expect } from "vitest";
import { applyPlanningHints, heuristicPlan } from "@/orchestrator/planner";
import { classifyCommand } from "@/orchestrator/classifier";
import { loadPolicy } from "@/orchestrator/policy";
import type { AgentDefinition } from "@/orchestrator/types";

const frontend: AgentDefinition = { _id: "f", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] };
const backend: AgentDefinition = { _id: "b", name: "Backend", role: "backend", capabilities: ["backend-development"] };
const reviewer: AgentDefinition = { _id: "r", name: "Reviewer", role: "cto", capabilities: ["code-review", "architecture"] };
const qa: AgentDefinition = { _id: "q", name: "QA", role: "qa", capabilities: ["browser-testing"] };

const policy = loadPolicy();

describe("phase6 progressive planning: scenario A (simple task)", () => {
  it("single code_change node, strategy direct, zero review/QA nodes", () => {
    const command = "fix the dashboard button";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
    });
    expect(plan.strategy).toBe("direct");
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].kind).toBe("code_change");
    expect(plan.subtasks.some((s) => s.kind === "review")).toBe(false);
    expect(plan.subtasks.some((s) => s.kind === "qa")).toBe(false);
  });

  it("applyPlanningHints adds nothing to a non-risky LLM plan in auto mode", () => {
    const hinted = applyPlanningHints(
      {
        version: 1,
        goal: "create flow.txt",
        strategy: "single",
        requiresApproval: true,
        maxConcurrency: 2,
        subtasks: [
          {
            key: "implement",
            title: "Implement",
            description: "create flow.txt",
            kind: "code_change",
            capability: "frontend-development",
            dependencies: [],
            order: 0,
          },
        ],
      },
      [frontend, reviewer, qa],
      {
        command: "create flow.txt",
        classification: classifyCommand("create flow.txt"),
        policy,
      }
    );
    expect(hinted.subtasks).toHaveLength(1);
  });
});

describe("phase6 progressive planning: scenario B (complex auth)", () => {
  it("risk signal fires: review + QA present with dependencies respected", () => {
    const command = "add oauth login with token refresh";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
    });
    const kinds = plan.subtasks.map((s) => s.kind);
    expect(kinds).toContain("code_change");
    expect(kinds).toContain("review");
    expect(kinds).toContain("qa");
    // ≥2 capabilities
    const capabilities = new Set(plan.subtasks.map((s) => s.capability));
    expect(capabilities.size).toBeGreaterThanOrEqual(2);
    // QA depends on review, review depends on the implementation
    const review = plan.subtasks.find((s) => s.kind === "review")!;
    const qaNode = plan.subtasks.find((s) => s.kind === "qa")!;
    expect(review.dependencies).toContain(plan.subtasks[0].key);
    expect(qaNode.dependencies).toContain(review.key);
    // no cycle: every dependency appears earlier in `order`
    for (const subtask of plan.subtasks) {
      for (const dep of subtask.dependencies) {
        const depNode = plan.subtasks.find((s) => s.key === dep);
        expect(depNode).toBeDefined();
        expect(depNode!.order).toBeLessThan(subtask.order);
      }
    }
  });

  it("multi-domain plan gets review on the risk signal and keeps parallel lanes", () => {
    const command = "add a settings page in the frontend and a settings api in the backend";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, backend, reviewer, qa],
      policy,
    });
    const implementFront = plan.subtasks.find((s) => s.key === "implement_frontend");
    const implementBack = plan.subtasks.find((s) => s.key === "implement_backend");
    expect(implementFront?.dependencies).toEqual([]);
    expect(implementBack?.dependencies).toEqual([]);
    const review = plan.subtasks.find((s) => s.kind === "review");
    expect(review?.dependencies).toEqual(["implement_frontend", "implement_backend"]);
  });
});

describe("phase6 progressive planning: unroutable hint drop", () => {
  it("applyPlanningHints never adds a node no agent can serve", () => {
    // No reviewer and no QA agent: even an auth change gets no review/QA
    // hint nodes (they would be unroutable).
    const hinted = applyPlanningHints(
      {
        version: 1,
        goal: "add oauth login",
        strategy: "single",
        requiresApproval: true,
        maxConcurrency: 2,
        subtasks: [
          {
            key: "implement",
            title: "Implement",
            description: "add oauth login",
            kind: "code_change",
            capability: "frontend-development",
            dependencies: [],
            order: 0,
          },
        ],
      },
      [frontend],
      {
        command: "add oauth login",
        classification: classifyCommand("add oauth login"),
        policy,
      }
    );
    expect(hinted.subtasks).toHaveLength(1);
    expect(hinted.subtasks[0].kind).toBe("code_change");
  });
});
