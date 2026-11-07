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

/**
 * Phase 5 Step 5.2 at the runner level (executor mocked, following the
 * phase5Runner pattern): a QA node that settles `failed` must NOT let
 * executePlan return "completed". The QA loop spawns a targeted
 * `fix_qa_<n>` subtask for the implementer capability carrying the QA
 * findings, runs it, and re-runs the same QA nodes. A still-failing QA
 * after the last attempt fails the task explicitly — never a silent
 * "done" and never a full replan (the plan is adopted from the stored
 * one, so createPlan is not called at all).
 *
 * Scenario D (PLAN test plan).
 */

const qaState = vi.hoisted(() => ({
  /** How many times the QA executor has been invoked. */
  attempts: 0,
  /** QA passes once this many fix rounds have run. */
  passAfterFixes: 1,
  /** Fix subtasks that have completed. */
  fixRuns: 0,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    if (input.subtask.kind === "qa") {
      qaState.attempts += 1;
      if (qaState.fixRuns >= qaState.passAfterFixes) {
        return {
          status: "completed",
          output: "QA verdict: passed",
          meta: { verdict: "passed", checks: [] },
        };
      }
      return {
        status: "completed",
        output: "QA verdict: failed",
        meta: {
          verdict: "failed",
          checks: [
            { label: "smoke", status: "failed", details: "submit button missing" },
            { label: "console", status: "passed", details: "no errors" },
          ],
        },
      };
    }
    if (input.subtask.kind === "code_change") {
      if (key.startsWith("fix_qa_")) qaState.fixRuns += 1;
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

const QA_AGENT = {
  _id: "agent-qa",
  name: "QA",
  role: "qa",
  capabilities: ["browser-testing"],
  isEnabled: true,
  priority: 1,
} as WorkerAgent;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-p6-completion-"));
  qaState.attempts = 0;
  qaState.fixRuns = 0;
  qaState.passAfterFixes = 1;
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const planFixture = (): ExecutionPlan => ({
  version: 1,
  goal: "Write the helper and validate it",
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 2,
  subtasks: [
    {
      key: "impl",
      title: "Implement",
      description: "Write the helper",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 0,
    },
    {
      key: "qa-1",
      title: "QA",
      description: "Validate the helper",
      kind: "qa",
      capability: "browser-testing",
      dependencies: ["impl"],
      order: 1,
    },
  ],
});

interface Captured {
  completions: Array<Record<string, unknown>>;
  events: Array<{ type: string; payload?: Record<string, unknown>; level?: string }>;
  dynamic: Array<{ added: Array<Record<string, unknown>>; origin: string }>;
  subtasks: WorkerSubtask[];
}

function createDeps(policy: ExecutionPolicy) {
  const plan = planFixture();
  const captured: Captured = { completions: [], events: [], dynamic: [], subtasks: [] };
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Write the helper and validate it",
    command: "Write a small helper function",
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
      agents: [IMPLEMENTER, QA_AGENT],
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
    getTaskTokenUsage: async () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }),
    getTaskContext: async () => null,
    upsertTaskContext: async () => undefined,
    saveDynamicSubtasks: async (input: {
      subtasks: Array<Record<string, unknown> & { origin?: string }>;
      origin?: string;
    }) => {
      captured.dynamic.push({
        added: input.subtasks,
        origin: input.subtasks[0]?.origin ?? input.origin ?? "unknown",
      });
    },
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
  };

  return {
    deps: {
      api: api as unknown as WorkerApi,
      workerId: "test-worker",
      policy,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

describe("processTask QA correction (Phase 5 Step 5.2, scenario D)", () => {
  it("a failing QA spawns fix_qa_1 for the implementer, re-runs QA, and completes — no replan", async () => {
    const { deps, captured, task } = createDeps(BASE_POLICY);
    await processTask(task, deps);

    // QA ran twice: once failing, once after the fix.
    expect(qaState.attempts).toBe(2);
    expect(qaState.fixRuns).toBe(1);

    // Exactly one dynamic fix node, persisted with origin "fix".
    expect(captured.dynamic).toHaveLength(1);
    const fix = captured.dynamic[0];
    expect(fix?.origin).toBe("fix");
    expect(fix?.added).toHaveLength(1);
    const fixNode = fix?.added[0];
    expect(fixNode?.key).toBe("fix_qa_1");
    expect(fixNode?.kind).toBe("code_change");
    // The QA failure is carried to the fix subtask as findings.
    expect(String(fixNode?.description)).toContain("submit button missing");

    const fixStarted = captured.events.filter((e) => e.type === "qa.fix_started");
    expect(fixStarted).toHaveLength(1);
    expect(fixStarted[0]?.payload?.iteration).toBe(1);

    // The QA fix never triggered a full replan, and the task completed.
    expect(captured.events.some((e) => e.type === "plan.replanned")).toBe(false);
    expect(captured.completions).toHaveLength(1);
    expect(captured.completions[0]?.status).toBe("done");

    // The QA node's own row reflects the second, passing run.
    const qaRow = captured.subtasks.find((s) => s.key === "qa-1");
    expect(qaRow?.status).toBe("completed");
  });

  it("a persistently failing QA fails the task after the bounded fix attempts — no replan", async () => {
    qaState.passAfterFixes = Number.POSITIVE_INFINITY;
    const { deps, captured, task } = createDeps(BASE_POLICY);
    await processTask(task, deps);

    // Three QA runs (initial + two fix rounds), two fix subtasks spawned.
    expect(qaState.attempts).toBe(3);
    expect(qaState.fixRuns).toBe(2);
    expect(captured.dynamic).toHaveLength(2);
    expect(captured.dynamic.map((entry) => entry.added[0]?.key)).toEqual([
      "fix_qa_1",
      "fix_qa_2",
    ]);
    expect(
      captured.events.filter((e) => e.type === "qa.fix_started").map((e) => e.payload?.iteration)
    ).toEqual([1, 2]);

    // No replan: the run ended as an explicit failure.
    expect(captured.events.some((e) => e.type === "plan.replanned")).toBe(false);
    expect(captured.completions).toHaveLength(1);
    expect(captured.completions[0]?.status).toBe("failed");
    expect(String(captured.completions[0]?.errorMessage)).toContain(
      "QA still failing after 2 fix attempt(s)"
    );
    expect(captured.events.some((e) => e.type === "task.error")).toBe(true);
  });
});
