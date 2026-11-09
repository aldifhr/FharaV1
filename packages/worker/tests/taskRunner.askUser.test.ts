import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerTask,
} from "@/workerApi";

/**
 * Plan 013 step 4: the engine's `ask_user` outcome pauses the task in
 * `waiting_input` with the question visible, and the user's answer
 * (persisted as a `user_answer` task-context decision by the backend
 * answer mutation) is threaded into the resumed run's shared context.
 */

const knobs = vi.hoisted(() => ({
  decideAsksUser: false,
  contextDecisions: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/orchestrator/decision", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/orchestrator/decision")>();
  return {
    ...orig,
    decide: async () =>
      knobs.decideAsksUser
        ? {
            decision: {
              id: "d-ask",
              action: "ask_user",
              reasoning: "no other path",
              question: "Which style do you prefer for the landing page?",
              options: ["Bold wireframe", "Minimal card grid", "Editorial long-form"],
              decidedBy: "llm",
              planVersion: 1,
              createdAt: Date.now(),
            },
          }
        : {
            decision: {
              id: "d-done",
              action: "complete",
              reasoning: "done",
              expectedOutcome: "objective:met",
              decidedBy: "deterministic",
              planVersion: 1,
              createdAt: Date.now(),
            },
          },
  };
});

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
    createPlan: async () => ({ plan, createdBy: "llm", notes: [] }),
    heuristicPlan: () => plan,
  };
});

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async () => ({ status: "completed", output: "done" }),
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-ask-user-"));
  knobs.decideAsksUser = false;
  knobs.contextDecisions = [];
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps() {
  const completions: Array<Record<string, unknown>> = [];
  const pauses: Array<{ taskId: string; question: string; options?: string[]; workerId?: string }> = [];
  const contextUpserts: Array<Array<Record<string, unknown>>> = [];
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Implement the feature",
    command: "Implement the feature",
    status: "running",
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
  };
  const api = {
    getContext: async () => ({
      task,
      project,
      agents: [IMPLEMENTER],
      plan: null,
      subtasks: [],
      approvalMode: "auto" as const,
    }),
    logEvent: async () => undefined,
    startExecution: async () => "exec-1",
    updateExecution: async () => undefined,
    updateSubtask: async () => true,
    saveFileChange: async () => "change-1",
    markFilesApplied: async () => undefined,
    getFileChanges: async () => [],
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    completeTask: async (input: Record<string, unknown>) => {
      completions.push(input);
      return { applied: true, status: input.status };
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
    recordLifecycle: async () => undefined,
    upsertTaskContext: async (input: {
      decisions: Array<Record<string, unknown>>;
    }) => {
      contextUpserts.push(input.decisions);
    },
    getTaskContext: async () => ({ decisions: knobs.contextDecisions }),
    pauseForInput: async (input: { taskId: string; question: string; options?: string[]; workerId?: string }) => {
      pauses.push(input);
      return { applied: true, status: "waiting_input" as const };
    },
  };
  const policy: ExecutionPolicy = {
    maxSubtasks: 8,
    maxConcurrency: 1,
    maxReplans: 1,
    maxPlanningIterations: 1,
    maxReviewIterations: 1,
    subtaskTimeoutMs: 5_000,
    subtaskRetries: 0,
    approvalTimeoutMs: 60_000,
    taskTimeoutMs: 60_000,
    verificationEnabled: false,
    verificationIncludeBuild: false,
    verificationTimeoutMs: 10_000,
    maxAgentsPerTask: 3,
    maxLLMCallsPerTask: 12,
    maxDelegationDepth: 2,
    maxConcurrentLLMCalls: 1,
    maxTokenBudgetPerTask: 50_000,
    orchestratorAuthoritative: false,
    decisionLlmMode: "off",
  };
  return {
    deps: {
      api: api as unknown as WorkerApi,
      workerId: "test-worker",
      policy,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    completions,
    pauses,
    contextUpserts,
    task: task as unknown as WorkerTask,
  };
}

describe("processTask ask_user (plan 013 step 4)", () => {
  it("pauses the task in waiting_input with the question, without completing it", async () => {
    knobs.decideAsksUser = true;
    const { deps, completions, pauses, task } = createDeps();
    await processTask(task, deps);

    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.question).toContain("Which style do you prefer");
    expect(pauses[0]?.options).toEqual(["Bold wireframe", "Minimal card grid", "Editorial long-form"]);
    // The pause is NOT a completion — the task stays for the user.
    expect(completions).toHaveLength(0);
  });

  it("threads the user's answer into the resumed run's shared context", async () => {
    knobs.contextDecisions = [
      {
        decision: "user_answer",
        reason: "the bold wireframe",
        fromAgent: "user",
        createdAt: 1700000000000,
      },
    ];
    const { deps, contextUpserts, task } = createDeps();
    await processTask(task, deps);

    // The decision trail persisted back upstream carries the answer.
    const threaded = contextUpserts.some((decisions) =>
      decisions.some((entry) => entry.decision === "user_answer" && entry.reason === "the bold wireframe")
    );
    expect(threaded).toBe(true);
  });
});
