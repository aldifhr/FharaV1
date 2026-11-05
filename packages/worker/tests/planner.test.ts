import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/orchestrator/classifier";
import { createPlan, heuristicPlan } from "../src/orchestrator/planner";
import type { AgentDefinition } from "../src/orchestrator/types";
import { loadPolicy } from "../src/orchestrator/policy";

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

  it("adds a QA subtask only when a capable agent exists", () => {
    const command = "update the dashboard page";
    const withoutQa = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer],
      policy,
    });
    const withQa = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy,
    });
    expect(withoutQa.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
    expect(withQa.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);
    expect(withoutQa.requiresApproval).toBe(true);
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
