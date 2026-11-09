import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";
import { withApiDefaults } from "./helpers/fakeApi";

/**
 * Phase 5 at the runner level (executor mocked, following the
 * phase4Runner pattern): the mocked executor mirrors the real
 * executor's Phase 5 contract — it checks the pre-call budget gate
 * (input.assertBudgetForCall) before each subtask's "LLM call", reports
 * usage through onTokenUsage (which feeds the runner's BudgetTracker),
 * and converts a BudgetExhaustedError thrown by the gate into a failed
 * outcome whose error carries the "Budget exhausted: " prefix.
 *
 * Scenarios (PLAN §C):
 *  - enforce: the call budget dies on the third subtask — subtask 3
 *    never starts its call, the task ends via the budget.exhausted
 *    event + completeTask(failed, "Budget exhausted: ..."), and the
 *    two completed subtasks' outputs stay persisted.
 *  - warn: the same over-budget run completes; a budget.warning event
 *    is emitted and the task ends done.
 *  - seed failure: getTaskTokenUsage throws — a budget.seed_failed
 *    warning event is emitted (never a silent catch) and the run
 *    continues.
 */

const mockState = vi.hoisted(() => ({
  /** subtask key -> number of LLM calls the executor actually started */
  callsStarted: new Map<string, number>(),
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    assertBudgetForCall?: () => void;
    onTokenUsage?: (
      inputTokens: number,
      outputTokens: number,
      model: string,
      meta?: unknown
    ) => Promise<void>;
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    try {
      input.assertBudgetForCall?.();
    } catch (error) {
      // Mirror of the real executor's conversion: BudgetExhaustedError
      // becomes a failed outcome with the typed message.
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    mockState.callsStarted.set(key, (mockState.callsStarted.get(key) ?? 0) + 1);
    await input.onTokenUsage?.(10, 5, "test-model", undefined);
    if (input.subtask.kind === "code_change") {
      await input.saveFileChange({
        filePath: `file-${key}.txt`,
        changeType: "new",
        newContent: "content\n",
        diff: "",
      });
      return {
        status: "completed",
        output: `output-${key}`,
        meta: { filePaths: [`file-${key}.txt`] },
      };
    }
    if (input.subtask.kind === "qa") {
      return {
        status: "completed",
        output: "QA verdict: passed",
        meta: { verdict: "passed", checks: [] },
      };
    }
    return { status: "completed", output: `output-${key}` };
  },
}));

import { processTask } from "@/services/taskRunner";

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
};

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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-p5-runner-"));
  mockState.callsStarted = new Map();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const chainPlan = (): ExecutionPlan => ({
  version: 1,
  goal: "Phase 5 runner test",
  strategy: "dag",
  requiresApproval: true,
  maxConcurrency: 2,
  subtasks: [
    {
      key: "s1",
      title: "Step 1",
      description: "First",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 0,
    },
    {
      key: "s2",
      title: "Step 2",
      description: "Second",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: ["s1"],
      order: 1,
    },
    {
      key: "s3",
      title: "Step 3",
      description: "Third",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: ["s2"],
      order: 2,
    },
  ],
});

interface Captured {
  completions: Array<Record<string, unknown>>;
  events: Array<{ type: string; payload?: Record<string, unknown>; level?: string }>;
  subtasks: WorkerSubtask[];
}

function createDeps(
  policy: ExecutionPolicy,
  options: { seedFails?: boolean } = {}
) {
  const plan = chainPlan();
  const captured: Captured = { completions: [], events: [], subtasks: [] };
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Phase 5 runner test",
    command: "Phase 5 runner test",
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
  captured.subtasks = subtasks;
  const changes = new Map<string, Record<string, unknown>>();

  const api = {
    getContext: async () => ({
      task,
      project,
      agents: [IMPLEMENTER],
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
    logEvent: async (input: {
      type: string;
      payload?: Record<string, unknown>;
      level?: string;
    }) => {
      captured.events.push(input);
    },
    startExecution: async () => "exec-1",
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find((c) => c.key === input.subtaskKey);
      if (!subtask) return;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
    },
    updateSubtask: async (input: {
      key: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      const subtask = subtasks.find((c) => c.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
      return true;
    },
    saveFileChange: async (change: {
      filePath: string;
      changeType: "new" | "modified" | "deleted";
      newContent?: string;
      diff: string;
    }) => {
      changes.set(change.filePath, { _id: `change-${changes.size + 1}`, ...change });
      return `change-${changes.size}`;
    },
    markFilesApplied: async (input: { taskId: string; filePaths: string[] }) => {
      const now = Date.now();
      for (const filePath of input.filePaths) {
        const change = changes.get(filePath);
        if (change) change.appliedAt = now;
      }
    },
    getFileChanges: async () => Array.from(changes.values()),
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    recordDelegation: async () => undefined,
    recordLifecycle: async () => undefined,
    completeTask: async (input: Record<string, unknown>) => {
      captured.completions.push(input);
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    getTaskTokenUsage: async () => {
      if (options.seedFails) throw new Error("usage backend unavailable");
      return { calls: 0, inputTokens: 0, outputTokens: 0 };
    },
    getTaskContext: async () => null,
    upsertTaskContext: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
  };

  return {
    deps: {
      api: withApiDefaults(api) as unknown as WorkerApi,
      workerId: "test-worker",
      policy,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

describe("processTask budget enforcement (Phase 5)", () => {
  it("enforce: budget exhaustion ends the task as budget.exhausted with completed outputs intact", async () => {
    // Two calls fit the budget; the third subtask's pre-call gate throws.
    const policy: ExecutionPolicy = {
      ...BASE_POLICY,
      maxLLMCallsPerTask: 2,
      budgetMode: "enforce",
    };
    const { deps, captured, task } = createDeps(policy);
    await processTask(task, deps);

    // The first two subtasks ran their calls; the third never started.
    expect(mockState.callsStarted.get("s1")).toBe(1);
    expect(mockState.callsStarted.get("s2")).toBe(1);
    expect(mockState.callsStarted.get("s3")).toBeUndefined();

    // The task ended through the budget path, exactly once.
    expect(captured.completions).toHaveLength(1);
    expect(captured.completions[0]?.status).toBe("failed");
    expect(String(captured.completions[0]?.errorMessage)).toContain(
      "Budget exhausted: LLM call budget exhausted (2/2)"
    );
    const exhausted = captured.events.filter((e) => e.type === "budget.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.level).toBe("error");

    // Completed subtask outputs were persisted before the stop and stay.
    const byKey = new Map(captured.subtasks.map((s) => [s.key, s]));
    expect(byKey.get("s1")?.status).toBe("completed");
    expect(byKey.get("s1")?.output).toBe("output-s1");
    expect(byKey.get("s2")?.status).toBe("completed");
    expect(byKey.get("s2")?.output).toBe("output-s2");
  });

  it("warn: the over-budget task completes and emits a budget.warning event", async () => {
    const policy: ExecutionPolicy = {
      ...BASE_POLICY,
      maxLLMCallsPerTask: 2,
      budgetMode: "warn",
    };
    const { deps, captured, task } = createDeps(policy);
    await processTask(task, deps);

    expect(mockState.callsStarted.get("s3")).toBe(1);
    expect(captured.completions[0]?.status).toBe("done");
    const warnings = captured.events.filter((e) => e.type === "budget.warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]?.payload?.reason).toContain("LLM call budget exhausted (2/2)");
    expect(captured.events.some((e) => e.type === "budget.exhausted")).toBe(false);
  });

  it("seed failure surfaces as budget.seed_failed and the run continues", async () => {
    const { deps, captured, task } = createDeps(BASE_POLICY, { seedFails: true });
    await processTask(task, deps);
    const seedFailures = captured.events.filter((e) => e.type === "budget.seed_failed");
    expect(seedFailures).toHaveLength(1);
    expect(seedFailures[0]?.level).toBe("warn");
    expect(String(seedFailures[0]?.payload?.message)).toContain("usage backend unavailable");
    expect(captured.completions[0]?.status).toBe("done");
  });
});
