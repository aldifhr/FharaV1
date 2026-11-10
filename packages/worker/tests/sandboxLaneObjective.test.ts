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
 * Live test 3 (sandbox lane fix 6): a planned code_change that completed
 * with 0 file changes was judged "objective:met" because a planned review
 * node was still pending (objective evaluation deferred). It must count as
 * unmet right away, with the missing work as the replan feedback.
 */

const plannerMock = vi.hoisted(() => ({
  repeatSame: false,
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
      {
        key: "review",
        title: "Review",
        description: "Review the change",
        kind: "review",
        capability: "code-review",
        dependencies: ["implement"],
        order: 1,
      },
    ],
  };
  return {
    createPlan: async (input: { feedback?: string; hasQaUrl?: boolean }) => {
      plannerMock.createPlanCalls.push({ feedback: input.feedback, hasQaUrl: input.hasQaUrl });
      // A replan changes the approach (Replan Quality Check rejects an
      // identical repeat of the failed node); repeatSame opts out.
      const call = plannerMock.createPlanCalls.length;
      if (call === 1 || plannerMock.repeatSame) return { plan, createdBy: "llm", notes: [] };
      return {
        plan: {
          ...plan,
          subtasks: plan.subtasks.map((subtask) => ({
            ...subtask,
            description: `${subtask.description} (approach ${call})`,
            replanReasoning: "Changed the approach after the failure",
          })),
        },
        createdBy: "llm",
        notes: [],
      };
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

const REVIEWER = {
  _id: "agent-reviewer",
  name: "Reviewer",
  role: "reviewer",
  capabilities: ["code-review"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-empty-change-"));
  plannerMock.createPlanCalls = [];
  plannerMock.repeatSame = false;
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
    agents: [IMPLEMENTER, REVIEWER],
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

describe("an empty code_change is never objective:met", () => {
  it("is unmet while review is still pending; never completed as objective:met", async () => {
    const { deps, completions, events, task } = createDeps({});
    await processTask(task, deps);
    const unmet = events.filter((event) => event.type === "orchestrator.objective_unmet");
    expect(unmet.length).toBeGreaterThan(0);
    expect(JSON.stringify(unmet[0].payload)).toContain("code_change completed with no applied file change");
    expect(
      events.some((event) => event.type === "orchestrator.completed" && event.payload?.expectedOutcome === "objective:met")
    ).toBe(false);
    expect(completions.at(-1)?.status).toBe("failed");
  });
});
