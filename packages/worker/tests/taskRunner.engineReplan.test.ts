import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerTask,
} from "@/workerApi";

/**
 * Plan 013 step 3: the decision engine's `replan` outcome is real. A
 * completed code_change with no applied file change makes the objective
 * unmet, so the engine requests a re-plan with the objective missing
 * list as feedback; processTask re-plans through the single planning
 * authority (`createAuthoritativePlan`), bounded by
 * `maxPlanningIterations`. Exhaustion fails the task with the missing
 * list — never a silent done.
 */

const plannerMock = vi.hoisted(() => ({
  createPlanCalls: [] as Array<{ feedback?: string; hasQaUrl?: boolean }>,
}));

vi.mock("../src/orchestrator/planner", () => {
  const plan = {
    version: 1,
    goal: "Implement the feature",
    strategy: "dag",
    requiresApproval: false,
    maxConcurrency: 1,
    subtasks: [
      {
        key: "implement",
        title: "Implement",
        description: "Write the code",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: [],
        order: 0,
      },
    ],
  };
  return {
    createPlan: async (input: { feedback?: string; hasQaUrl?: boolean }) => {
      plannerMock.createPlanCalls.push({ feedback: input.feedback, hasQaUrl: input.hasQaUrl });
      return { plan, createdBy: "llm", notes: [] };
    },
    heuristicPlan: () => plan,
  };
});

vi.mock("../src/execution/agentExecutor", () => ({
  // Runs "successfully" but applies nothing — the objective stays unmet.
  executeSubtask: async () => ({ status: "completed", output: "wrote nothing" }),
}));

import { processTask } from "@/services/taskRunner";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

const IMPLEMENTER = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-engine-replan-"));
  plannerMock.createPlanCalls = [];
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps(policyOverrides: Partial<ExecutionPolicy>) {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const task = testTask({ title: "Implement the feature", command: "Implement the feature" });
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
  };
  const getContext = async () => ({
    task,
    project,
    agents: [IMPLEMENTER],
    plan: null,
    subtasks: [],
    approvalMode: "auto" as const,
  });
  const { api, completions } = createFakeApi({
    getContext,
    logEvent: async (input: { type: string; payload?: Record<string, unknown> }) => {
      events.push({ type: input.type, payload: input.payload });
    },
    recordLifecycle: async () => undefined,
    upsertTaskContext: async () => undefined,
    getTaskContext: async () => null,
    pauseForInput: async () => ({ applied: false, reason: "lease_lost" as const }),
  });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxReplans: 1,
    maxPlanningIterations: 1,
    maxReviewIterations: 1,
    maxConcurrentLLMCalls: 1,
    orchestratorAuthoritative: false,
    decisionLlmMode: "off",
    ...policyOverrides,
  });
  return {
    deps: createRunnerDeps({ api, policy, workspaceRoot: workspace }),
    completions,
    events,
    task: task as unknown as WorkerTask,
  };
}

describe("processTask engine replan (plan 013 step 3)", () => {
  it("re-plans once with the objective missing list through the single authority, then fails with it when exhausted", async () => {
    const { deps, completions, events, task } = createDeps({});
    await processTask(task, deps);

    // Initial plan + exactly one bounded engine re-plan.
    expect(plannerMock.createPlanCalls).toHaveLength(2);
    expect(plannerMock.createPlanCalls[0].feedback).toBeUndefined();

    const feedback = plannerMock.createPlanCalls[1]?.feedback ?? "";
    expect(feedback).toContain("Objective not satisfied:");
    expect(feedback).toContain("code_change completed with no applied file change");

    // The downgrade was recorded and the replan was enacted.
    expect(events.some((event) => event.type === "orchestrator.objective_unmet")).toBe(true);
    expect(events.filter((event) => event.type === "plan.replanned")).toHaveLength(1);

    // Budget exhausted: failed with the missing list, never done.
    const last = completions.at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.errorMessage).toContain("Objective not satisfied after 1 replan(s):");
  });

  it("maxPlanningIterations=0 fails immediately with the missing list, no re-plan", async () => {
    const { deps, completions, task } = createDeps({
      maxReplans: 3,
      maxPlanningIterations: 0,
    });
    await processTask(task, deps);

    expect(plannerMock.createPlanCalls).toHaveLength(1);
    const last = completions.at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.errorMessage).toContain("Objective not satisfied after 0 replan(s):");
  });
});
