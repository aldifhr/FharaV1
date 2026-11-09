import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { WorkerAgent, WorkerApi, WorkerSubtask, WorkerTask } from "@/workerApi";

/**
 * Plan 005 Phase 4 (adaptive delegation), scenarios C and E at the runner
 * level (executor mocked, following tests/phase4Runner.test.ts):
 *  - C — a validated delegation proposal adds a node,
 *    `saveDynamicSubtasks` is called with origin "delegation", and the
 *    delegated node executes;
 *  - E — a proposal to delegate work the proposer can serve itself is
 *    REJECTed: no node is added and nothing is persisted.
 *
 * Both run through the decision engine (ORCHESTRATOR_DECISION_ENGINE=on),
 * where the observation is the live `evaluateAfterExecution` verdict, so
 * scenario E proves the selfServe gate is wired end-to-end.
 */
const mockState = vi.hoisted(() => ({
  executed: [] as string[],
  recommend: null as null | { targetCapability: string; reason: string },
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    mockState.executed.push(input.subtask.key);
    if (input.subtask.kind === "code_change") {
      const filePath = `file-${input.subtask.key}.txt`;
      await input.saveFileChange({
        filePath,
        changeType: "new",
        newContent: "content\n",
        diff: "",
      });
      const meta: Record<string, unknown> = { filePaths: [filePath] };
      if (mockState.recommend && input.subtask.key === "impl") {
        meta.delegationRecommendation = mockState.recommend;
      }
      return { status: "completed", output: "changed", meta };
    }
    if (input.subtask.kind === "qa") {
      return { status: "completed", output: "QA verdict: passed", meta: { verdict: "passed", checks: [] } };
    }
    return { status: "completed", output: "ok" };
  },
}));

import { processTask } from "@/services/taskRunner";
import { withApiDefaults } from "./helpers/fakeApi";

const BASE_POLICY: ExecutionPolicy = {
  maxSubtasks: 8,
  maxConcurrency: 2,
  maxReplans: 0,
  maxPlanningIterations: 0,
  maxReviewIterations: 2,
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
  maxConcurrentLLMCalls: 2,
  maxTokenBudgetPerTask: 50_000,
  allowFallback: true,
  orchestratorAuthoritative: true,
  decisionLlmMode: "off",
  maxDecisionSteps: 20,
  reviewMode: "auto",
  qaMode: "auto",
};

const implementer: WorkerAgent = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development", "backend-development"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;

const securityAuditor: WorkerAgent = {
  _id: "agent-security",
  name: "Security",
  role: "security",
  capabilities: ["security-audit"],
  isEnabled: true,
  priority: 1,
} as WorkerAgent;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-p6-delegation-"));
  mockState.executed = [];
  mockState.recommend = null;
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const plan: ExecutionPlan = {
  version: 1,
  goal: "Phase 6 delegation test",
  strategy: "direct",
  requiresApproval: true,
  maxConcurrency: 2,
  subtasks: [
    {
      key: "impl",
      title: "Implement",
      description: "Implement the change",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 0,
    },
  ],
};

interface Captured {
  completions: Array<Record<string, unknown>>;
  dynamic: Array<Record<string, unknown>>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function createDeps() {
  const captured: Captured = { completions: [], dynamic: [], events: [] };
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Phase 6 delegation test",
    command: "Phase 6 delegation test",
    status: "running",
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
  };
  const subtasks: WorkerSubtask[] = plan.subtasks.map((subtask, index) => ({
    _id: `sub-${index}`,
    key: subtask.key,
    title: subtask.title,
    description: subtask.description,
    kind: subtask.kind,
    capability: subtask.capability,
    dependencies: subtask.dependencies,
    order: subtask.order,
    status: "pending",
    attempts: 0,
  })) as WorkerSubtask[];
  const changes = new Map<string, unknown>();

  const api = {
    getContext: async () => ({
      task,
      project,
      agents: [implementer, securityAuditor],
      plan: {
        _id: "plan-1",
        taskId: task._id,
        version: 1,
        strategy: plan.strategy,
        createdBy: "orchestrator" as const,
        goal: plan.goal,
        payload: plan,
        createdAt: 0,
      },
      subtasks,
      approvalMode: "auto" as const,
    }),
    logEvent: async (input: { type: string; payload?: Record<string, unknown> }) => {
      captured.events.push({ type: input.type, payload: input.payload ?? {} });
    },
    startExecution: async () => "exec-1",
    updateExecution: async (input: { subtaskKey?: string; status: string; output?: string; error?: string }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find((candidate) => candidate.key === input.subtaskKey);
      if (!subtask) return;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
    },
    updateSubtask: async (input: { key: string; status: string; output?: string; error?: string }) => {
      const subtask = subtasks.find((candidate) => candidate.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
      return true;
    },
    saveFileChange: async (change: { filePath: string; changeType: string; newContent?: string; diff: string }) => {
      changes.set(change.filePath, change);
      return `change-${changes.size}`;
    },
    markFilesApplied: async () => undefined,
    getFileChanges: async () => Array.from(changes.values()),
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    recordDelegation: async () => undefined,
    saveDynamicSubtasks: async (input: Record<string, unknown>) => {
      captured.dynamic.push(input);
      return null;
    },
    completeTask: async (input: Record<string, unknown>) => {
      captured.completions.push(input);
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
  };

  return {
    deps: {
      api: withApiDefaults(api) as unknown as WorkerApi,
      workerId: "test-worker",
      policy: BASE_POLICY,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

describe("phase6 delegation: scenario C (dynamic delegation)", () => {
  it("a validated proposal adds a node persisted with origin delegation, and it executes", async () => {
    mockState.recommend = { targetCapability: "security-audit", reason: "needs a security audit" };
    const { deps, captured, task } = createDeps();
    await processTask(task, deps);

    // The delegation node was added and persisted with the delegation origin.
    expect(captured.dynamic).toHaveLength(1);
    const saved = captured.dynamic[0] as {
      subtasks: Array<{ key: string; capability: string; origin: string }>;
    };
    expect(saved.subtasks).toHaveLength(1);
    expect(saved.subtasks[0].capability).toBe("security-audit");
    expect(saved.subtasks[0].origin).toBe("delegation");
    // The delegated node executed.
    expect(mockState.executed).toContain("impl");
    expect(mockState.executed).toContain(saved.subtasks[0].key);
    // The decision trail recorded the engine action.
    const decisionEvent = captured.events.find((event) => event.type === "orchestrator.decision");
    expect(decisionEvent?.payload.action).toBe("delegate");
    expect(decisionEvent?.payload.decidedBy).toBe("deterministic");
  });
});

describe("phase6 delegation: scenario E (unnecessary delegation)", () => {
  it("proposing a capability the proposer already has adds no node and persists nothing", async () => {
    // The implementer has backend-development; delegating it is unnecessary.
    mockState.recommend = { targetCapability: "backend-development", reason: "backend work" };
    const { deps, captured, task } = createDeps();
    await processTask(task, deps);

    expect(captured.dynamic).toHaveLength(0);
    expect(mockState.executed).toEqual(["impl"]);
    const decisionEvent = captured.events.find((event) => event.type === "orchestrator.decision");
    expect(decisionEvent?.payload.action).toBe("complete");
    expect(decisionEvent?.payload.expectedOutcome).toBe("delegation:declined");
    expect(String(decisionEvent?.payload.reasoning)).toContain(
      "proposing agent can serve this capability"
    );
  });
});
