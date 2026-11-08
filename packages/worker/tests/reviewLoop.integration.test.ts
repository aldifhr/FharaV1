import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerFileChange,
  WorkerSubtask,
} from "@/workerApi";

const mockState = vi.hoisted(() => ({
  reviewCalls: 0,
  changesRequestedCount: 2,
  subtaskCalls: [] as Array<{ key: string; kind: string; description: string }>,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string; description: string };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    mockState.subtaskCalls.push({
      key: input.subtask.key,
      kind: input.subtask.kind,
      description: input.subtask.description,
    });

    if (input.subtask.kind === "review") {
      mockState.reviewCalls += 1;
      if (mockState.reviewCalls <= mockState.changesRequestedCount) {
        return {
          status: "completed",
          output: "Review requested changes",
          meta: {
            verdict: "changes_requested",
            findings: [
              {
                severity: "high",
                filePath: "check.txt",
                description: "Automated test finding",
                suggestion: "Apply the suggested change",
              },
            ],
          },
        };
      }
      return {
        status: "completed",
        output: "Review approved",
        meta: { verdict: "approved", findings: [] },
      };
    }

    if (input.subtask.kind === "code_change") {
      const newContent = `content-${input.subtask.key}\n`;
      await input.saveFileChange({
        filePath: "check.txt",
        changeType: "new",
        newContent,
        diff: "",
      });
      return {
        status: "completed",
        output: `Changed ${input.subtask.key}`,
        meta: { filePaths: ["check.txt"] },
      };
    }

    return { status: "completed", output: "ok" };
  },
}));

import { processTask } from "@/services/taskRunner";

const POLICY: ExecutionPolicy = {
  maxSubtasks: 8,
  maxConcurrency: 2,
  maxReplans: 0,
  maxReviewIterations: 2,
  subtaskTimeoutMs: 5_000,
  subtaskRetries: 0,
  approvalTimeoutMs: 60_000,
  taskTimeoutMs: 60_000,
  verificationEnabled: false,
  verificationIncludeBuild: false,
  verificationTimeoutMs: 10_000,
  maxAgentsPerTask: 3,
  maxLLMCallsPerTask: 5,
  maxDelegationDepth: 2,
  maxConcurrentLLMCalls: 1,
  maxTokenBudgetPerTask: 50_000,
};

const PLAN: ExecutionPlan = {
  version: 1,
  goal: "Write check.txt",
  strategy: "dag",
  requiresApproval: true,
  maxConcurrency: 1,
  subtasks: [
    {
      key: "implement",
      title: "Implement change",
      description: "Write the file",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 0,
    },
    {
      key: "review",
      title: "Review change",
      description: "Review the prepared change",
      kind: "review",
      capability: "code-review",
      dependencies: ["implement"],
      order: 1,
    },
  ],
};

const AGENTS: any[] = [
  {
    _id: "agent-implementer",
    name: "Implementer",
    role: "frontend",
    capabilities: ["frontend-development"],
    isEnabled: true,
    priority: 0,
  },
  {
    _id: "agent-reviewer",
    name: "Reviewer",
    role: "reviewer",
    capabilities: ["code-review"],
    isEnabled: true,
    priority: 1,
  },
];

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-review-"));
  mockState.reviewCalls = 0;
  mockState.changesRequestedCount = 2;
  mockState.subtaskCalls = [];
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps() {
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Write check.txt",
    command: "Write check.txt",
    status: "running",
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
  };

  const subtasks: any[] = PLAN.subtasks.map((subtask, index) => ({
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
  }));

  const changes = new Map<string, WorkerFileChange>();
  const events: Array<{ type: string; payload?: unknown }> = [];
  const messages: string[] = [];
  let execution = 0;
  let completed: { status: string; error?: string } | null = null;
  let evaluations = 0;

  const api = {
    getContext: async () => ({
      task,
      project,
      agents: AGENTS,
      plan: {
        _id: "plan-1",
        taskId: task._id,
        version: 1,
        strategy: PLAN.strategy,
        createdBy: "orchestrator" as const,
        goal: PLAN.goal,
        payload: PLAN,
        createdAt: 0,
      },
      subtasks,
      approvalMode: "auto" as const,
    }),
    logEvent: async (event: { type: string; payload?: unknown }) => {
      events.push({ type: event.type, payload: event.payload });
    },
    startExecution: async () => `exec-${(execution += 1)}`,
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find((candidate) => candidate.key === input.subtaskKey);
      if (!subtask) return;
      subtask.status = input.status as any;
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
    },
    updateSubtask: async (input: {
      key: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      const subtask = subtasks.find((candidate) => candidate.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as any;
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
      return true;
    },
    saveFileChange: async (change: {
      filePath: string;
      changeType: "new" | "modified" | "deleted";
      oldContent?: string;
      newContent?: string;
      oldContentHash?: string;
      newContentHash?: string;
      diff: string;
    }) => {
      changes.set(change.filePath, {
        _id: `change-${changes.size + 1}`,
        taskId: task._id,
        ...change,
        diff: change.diff ?? "",
      } as any);
      return `change-${changes.size}`;
    },
    // Matches the real WorkerApi signature: a single object argument.
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
    recordEvaluation: async () => {
      evaluations += 1;
    },
    // Matches the real WorkerApi signature: a single object argument.
    completeTask: async (input: { taskId: string; status: string; errorMessage?: string }) => {
      completed = { status: input.status, error: input.errorMessage };
    },
    appendAgentMessage: async (message: { content: string }) => {
      messages.push(message.content);
    },
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
  };

  return {
    deps: {
      api: api as unknown as WorkerApi,
      workerId: "test-worker",
      policy: POLICY,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    events,
    messages,
    completed: () => completed,
    evaluations: () => evaluations,
  };
}

describe("review -> fix -> re-review loop", () => {
  it("runs fixes until the reviewer approves", async () => {
    const harness = createDeps();
    await processTask(
      {
        _id: "task-1" as any,
        _creationTime: 0,
        projectId: "project-1" as any,
        title: "Write check.txt",
        command: "Write check.txt",
        status: "running",
      },
      harness.deps
    );

    expect(harness.completed()).toEqual({ status: "done", error: undefined });
    expect(mockState.reviewCalls).toBe(3);

    const fixCalls = mockState.subtaskCalls.filter((call) => call.key.startsWith("review_fix_"));
    expect(fixCalls.map((call) => call.key)).toEqual(["review_fix_1", "review_fix_2"]);
    expect(fixCalls.every((call) => call.description.includes("Automated test finding"))).toBe(true);

    const events = harness.events.map((event) => event.type);
    expect(events.filter((type) => type === "review.requested_changes")).toHaveLength(2);
    expect(events.filter((type) => type === "review.fix_started")).toHaveLength(2);
    expect(events.filter((type) => type === "review.approved")).toHaveLength(1);

    const applied = await fs.readFile(path.join(workspace, "check.txt"), "utf-8");
    expect(applied).toBe("content-review_fix_2\n");
  });

  it("fails after the review iteration budget is exhausted", async () => {
    mockState.changesRequestedCount = 99;
    const harness = createDeps();
    await processTask(
      {
        _id: "task-1" as any,
        _creationTime: 0,
        projectId: "project-1" as any,
        title: "Write check.txt",
        command: "Write check.txt",
        status: "running",
      },
      harness.deps
    );

    expect(harness.completed()?.status).toBe("failed");
    expect(harness.completed()?.error).toContain("still requested changes after 2 fix attempt(s)");
    expect(harness.completed()?.error).toContain("Automated test finding");
    expect(mockState.reviewCalls).toBe(3);
  });
});
