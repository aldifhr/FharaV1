import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { ExecutionPlan } from "@/orchestrator/types";
import type {
  WorkerAgent,
  WorkerTask,
} from "@/workerApi";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

/**
 * Phase 3: replan is unified. When execution fails, the runner must
 * re-invoke the planner with feedback that carries the orchestrator's
 * own evaluations (decisions/findings from the shared task context),
 * not only the deterministic failure summary — and the number of
 * replans is bounded by maxPlanningIterations (the spec alias of
 * maxReplans; when both are set, maxPlanningIterations wins).
 */

const plannerMock = vi.hoisted(() => ({
  repeatSame: false,
  createPlanCalls: [] as Array<{ feedback?: string }>,
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
    createPlan: async (input: { feedback?: string }) => {
      plannerMock.createPlanCalls.push({ feedback: input.feedback });
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
  executeSubtask: async () => ({
    status: "failed",
    error: "boom: implementation exploded",
  }),
}));

import { processTask } from "@/services/taskRunner";

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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-replan-"));
  plannerMock.createPlanCalls = [];
  plannerMock.repeatSame = false;
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps(policyOverrides: Partial<ExecutionPolicy>) {
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
  const { api, completions } = createFakeApi({ getContext });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxReplans: 1,
    maxPlanningIterations: 1,
    maxReviewIterations: 1,
    maxConcurrentLLMCalls: 1,
    orchestratorAuthoritative: false,
    ...policyOverrides,
  });
  return {
    deps: createRunnerDeps({ api, policy, workspaceRoot: workspace }),
    completions,
    task: task as unknown as WorkerTask,
  };
}

describe("processTask replan (Phase 3)", () => {
  it("replans once on failure, with feedback enriched by orchestrator evaluations", async () => {
    const { deps, completions, task } = createDeps({});
    await processTask(task, deps);

    // Initial plan + exactly one replan.
    expect(plannerMock.createPlanCalls).toHaveLength(2);
    expect(plannerMock.createPlanCalls[0].feedback).toBeUndefined();

    const feedback = plannerMock.createPlanCalls[1].feedback ?? "";
    // The deterministic failure summary is still there...
    expect(feedback).toContain("boom: implementation exploded");
    // ...and the orchestrator's own evaluation of the failed subtask
    // rides along (recorded in the shared task context).
    expect(feedback).toContain("Orchestrator evaluations:");
    expect(feedback).toContain("REVISE");

    // Both attempts failed, so the task ends failed — no third plan.
    expect(completions.at(-1)?.status).toBe("failed");
    expect(plannerMock.createPlanCalls).toHaveLength(2);
  });

  it("maxPlanningIterations=0 suppresses replans even when maxReplans allows them", async () => {
    const { deps, completions, task } = createDeps({
      maxReplans: 3,
      maxPlanningIterations: 0,
    });
    await processTask(task, deps);

    expect(plannerMock.createPlanCalls).toHaveLength(1);
    expect(completions.at(-1)?.status).toBe("failed");
  });
});

describe("processTask replan quality check (Replan Intelligence)", () => {
  it("rejects a replan that repeats the failed node, retries once with the reason, then fails clearly", async () => {
    plannerMock.repeatSame = true;
    const { deps, completions, task } = createDeps({});
    await processTask(task, deps);

    // Initial plan + replan + exactly one quality retry.
    expect(plannerMock.createPlanCalls).toHaveLength(3);
    const scoped = plannerMock.createPlanCalls[1].feedback ?? "";
    expect(scoped).toContain("REPLAN SCOPE");
    expect(scoped).toContain("Failed nodes");
    expect(scoped).toContain("implement [code_change/frontend-development]");
    const retry = plannerMock.createPlanCalls[2].feedback ?? "";
    expect(retry).toContain("REJECTED by the quality check");
    expect(retry).toContain("repeats failed node");

    const last = completions.at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.errorMessage).toContain("Replan rejected by the quality check");
    expect(last?.errorMessage).toContain("same objective, agent");
  });
});

describe("processTask replan carry-forward (Phase 5 Step 5.3 — scenario F)", () => {
  it("a completed code_change key is not re-executed after replan and its file change survives", async () => {
    const { carryForwardState } = await import("@/services/taskRunner");
    const previousState = {
      priorOutputs: new Map([["implement", "done"]]),
      qaVerdicts: { qa: "passed" as const },
      reviewVerdicts: {},
      fileChanges: new Map([
        [
          "feature.ts",
          {
            filePath: "feature.ts",
            changeType: "new" as const,
            newContent: "export const feature = 1;\n",
            diff: "",
          },
        ],
      ]),
      appliedFilesBySubtask: new Map([["implement", ["feature.ts"]]]),
      feedback: ["old failure"],
    };
    const previousPlan: ExecutionPlan = {
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
    // A replan that keeps the SAME work (same kind/capability/description)
    // under a fresh key — the planner's own output shape.
    const newPlan: ExecutionPlan = {
      ...previousPlan,
      subtasks: [
        {
          key: "implement_v2",
          title: "Implement",
          description: "Write the code",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
      ],
    };

    const carried = carryForwardState(previousPlan, previousState, newPlan);

    expect(carried.completedKeys.has("implement_v2")).toBe(true);
    expect(carried.state.priorOutputs.get("implement_v2")).toBe("done");
    expect(carried.state.fileChanges.get("feature.ts")?.newContent).toBe(
      "export const feature = 1;\n"
    );
    // feedback is cleared; qaVerdicts belong to the old key only.
    expect(carried.state.feedback).toEqual([]);
    expect(carried.state.qaVerdicts.qa).toBeUndefined();
  });

  it("drops everything when nothing matches the new plan", async () => {
    const { carryForwardState } = await import("@/services/taskRunner");
    const previousState = {
      priorOutputs: new Map([["implement", "done"]]),
      qaVerdicts: {},
      reviewVerdicts: {},
      fileChanges: new Map([
        ["feature.ts", { filePath: "feature.ts", changeType: "new" as const, newContent: "x", diff: "" }],
      ]),
      appliedFilesBySubtask: new Map(),
      feedback: ["boom"],
    };
    const previousPlan: ExecutionPlan = {
      version: 1,
      goal: "g",
      strategy: "single",
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
    const newPlan: ExecutionPlan = {
      ...previousPlan,
      subtasks: [
        {
          key: "other",
          title: "Other",
          description: "Completely different work",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const carried = carryForwardState(previousPlan, previousState, newPlan);
    expect(carried.completedKeys.size).toBe(0);
    expect(carried.state.priorOutputs.size).toBe(0);
    expect(carried.state.fileChanges.size).toBe(0);
    expect(carried.state.feedback).toEqual([]);
  });
});
