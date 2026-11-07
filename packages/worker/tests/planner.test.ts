import { describe, expect, it } from "vitest";
import { classifyCommand } from "@/orchestrator/classifier";
import { createPlan, ensureRequiredSubtasks, heuristicPlan } from "@/orchestrator/planner";
import type { AgentDefinition, ExecutionPlan } from "@/orchestrator/types";
import { loadPolicy } from "@/orchestrator/policy";

const policy = loadPolicy();

const frontend: AgentDefinition = {
  _id: "f",
  name: "Frontend",
  role: "frontend",
  capabilities: ["frontend-development"],
};
const backend: AgentDefinition = {
  _id: "b",
  name: "Backend",
  role: "backend",
  capabilities: ["backend-development"],
};
const reviewer: AgentDefinition = {
  _id: "r",
  name: "Reviewer",
  role: "cto",
  capabilities: ["code-review", "architecture"],
};
const qa: AgentDefinition = {
  _id: "q",
  name: "QA",
  role: "qa",
  capabilities: ["browser-testing"],
};

describe("planner", () => {
  it("falls back to a deterministic plan when no LLM planner is available", async () => {
    const command = "fix the login button";
    const result = await createPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer],
      policy,
    });
    expect(result.createdBy).toBe("fallback");
    expect(result.plan.subtasks.map((subtask) => subtask.kind)).toContain("code_change");
    expect(result.plan.requiresApproval).toBe(true);
  });

  it("adds a QA subtask only when a QA signal fires and a capable agent exists", () => {
    const command = "update the dashboard page";
    const withoutQa = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
    });
    // "update the dashboard page" has no risk signal, no verification
    // request, and no QA URL: auto mode adds no QA node.
    expect(withoutQa.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);

    const withQa = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
      hasQaUrl: true,
    });
    expect(withQa.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);

    const noAgent = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer],
      policy,
      hasQaUrl: true,
    });
    expect(noAgent.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
    expect(withoutQa.requiresApproval).toBe(true);
  });

  it("reviewMode/qaMode 'always' restore the legacy mandate", () => {
    const command = "update the dashboard page";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, reviewMode: "always", qaMode: "always" },
    });
    expect(plan.subtasks.some((subtask) => subtask.kind === "review")).toBe(true);
    expect(plan.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);
  });

  it("reviewMode/qaMode 'never' add neither hint even on a risk signal", () => {
    const command = "add oauth login";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, reviewMode: "never", qaMode: "never" },
      hasQaUrl: true,
    });
    expect(plan.subtasks.some((subtask) => subtask.kind === "review")).toBe(false);
    expect(plan.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
  });

  it("risk signal (auth) adds review and qa to an auto plan", () => {
    const command = "add oauth login";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
    });
    expect(plan.subtasks.some((subtask) => subtask.kind === "review")).toBe(true);
    expect(plan.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);
  });

  it("adds review and qa to an LLM plan that omits them for code changes (legacy mandate)", () => {
    const plan: ExecutionPlan = {
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
    };
    const enforced = ensureRequiredSubtasks(plan, [frontend, reviewer, qa]);
    const review = enforced.subtasks.find((subtask) => subtask.kind === "review");
    const qaTask = enforced.subtasks.find((subtask) => subtask.kind === "qa");
    expect(review?.dependencies).toEqual(["implement"]);
    expect(qaTask?.dependencies).toEqual([review?.key]);
    expect(enforced.strategy).toBe("dag");
  });

  it("does not duplicate review or qa when the plan already has them", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "create flow.txt",
      strategy: "dag",
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
        {
          key: "review",
          title: "Review",
          description: "review",
          kind: "review",
          capability: "code-review",
          dependencies: ["implement"],
          order: 1,
        },
        {
          key: "qa",
          title: "QA",
          description: "qa",
          kind: "qa",
          capability: "browser-testing",
          dependencies: ["review"],
          order: 2,
        },
      ],
    };
    const enforced = ensureRequiredSubtasks(plan, [frontend, reviewer, qa]);
    expect(enforced.subtasks).toHaveLength(3);
  });

  it("does not add qa when no browser-testing agent exists", () => {
    const plan: ExecutionPlan = {
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
    };
    const enforced = ensureRequiredSubtasks(plan, [frontend]);
    expect(enforced.subtasks.some((subtask) => subtask.kind === "review")).toBe(true);
    expect(enforced.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
  });

  it("single-domain change with no risk signal stays direct with one node", () => {
    const command = "fix the dashboard button";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
    });
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].kind).toBe("code_change");
    expect(plan.strategy).toBe("direct");
  });

  it("plans parallel frontend and backend work for multi-domain requests", () => {
    const command =
      "add a new settings page in the frontend and a settings API endpoint in the backend";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, backend, reviewer],
      policy,
    });
    const implementFront = plan.subtasks.find((subtask) => subtask.key === "implement_frontend");
    const implementBack = plan.subtasks.find((subtask) => subtask.key === "implement_backend");
    expect(implementFront?.dependencies).toEqual([]);
    expect(implementBack?.dependencies).toEqual([]);
    const review = plan.subtasks.find((subtask) => subtask.key === "review");
    expect(review?.dependencies).toEqual(["implement_frontend", "implement_backend"]);
  });

  it("does not require approval for read-only work", () => {
    const command = "audit the authentication module";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [reviewer],
      policy,
    });
    expect(plan.requiresApproval).toBe(false);
  });
});
