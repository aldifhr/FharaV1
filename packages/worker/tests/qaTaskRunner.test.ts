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
  WorkerTask,
} from "@/workerApi";

/**
 * Spec §8, runner -> executor hop: processTask must resolve the project's
 * QA URL (qaUrl > devUrl > env fallback) and hand it to every subtask
 * execution as an explicit qaBaseUrl input — without touching
 * process.env.QA_BASE_URL. The executor is mocked and captures its inputs;
 * the executor -> runResponsiveQa hop is covered by qaThreading.test.ts.
 */

const execSpy = vi.hoisted(() => ({
  inputs: [] as Array<{ key: string; kind: string; qaBaseUrl?: string }>,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    qaBaseUrl?: string;
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    execSpy.inputs.push({
      key: input.subtask.key,
      kind: input.subtask.kind,
      qaBaseUrl: input.qaBaseUrl,
    });
    if (input.subtask.kind === "code_change") {
      await input.saveFileChange({
        filePath: "check.txt",
        changeType: "new",
        newContent: "content\n",
        diff: "",
      });
      return { status: "completed", output: "changed", meta: { filePaths: ["check.txt"] } };
    }
    if (input.subtask.kind === "qa") {
      return {
        status: "completed",
        output: "QA verdict: passed",
        meta: { verdict: "passed", checks: [] },
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
  goal: "Write check.txt then QA it",
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
      key: "qa",
      title: "QA the app",
      description: "Run responsive QA",
      kind: "qa",
      capability: "browser-testing",
      dependencies: ["implement"],
      order: 1,
    },
  ],
};

const AGENTS: WorkerAgent[] = [
  {
    _id: "agent-implementer",
    name: "Implementer",
    role: "frontend",
    capabilities: ["frontend-development"],
    isEnabled: true,
    priority: 0,
  } as WorkerAgent,
  {
    _id: "agent-qa",
    name: "QA",
    role: "qa",
    capabilities: ["browser-testing"],
    isEnabled: true,
    priority: 1,
  } as WorkerAgent,
];

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-qa-"));
  execSpy.inputs = [];
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps(projectExtras: Record<string, unknown>) {
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Write check.txt then QA it",
    command: "Write check.txt then QA it",
    status: "running",
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
    ...projectExtras,
  };
  const subtasks: WorkerSubtask[] = PLAN.subtasks.map((subtask, index) => ({
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
  const changes = new Map<string, WorkerFileChange>();
  const messages: Array<{ agentId?: string; content: string }> = [];

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
    logEvent: async () => undefined,
    startExecution: async () => "exec-1",
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find((candidate) => candidate.key === input.subtaskKey);
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
      const subtask = subtasks.find((candidate) => candidate.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as WorkerSubtask["status"];
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
      } as WorkerFileChange);
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
    completeTask: async () => undefined,
    appendAgentMessage: async (input: { agentId?: string; content: string }) => {
      messages.push(input);
    },
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
  };

  return {
    api: api as unknown as WorkerApi,
    workerId: "test-worker",
    policy: POLICY,
    workspaceRoot: workspace,
    log: () => undefined,
    messages,
  };
}

const TASK = {
  _id: "task-1",
  projectId: "project-1",
  title: "Write check.txt then QA it",
  command: "Write check.txt then QA it",
  status: "running",
} as unknown as WorkerTask;

describe("processTask QA URL threading", () => {
  it("threads project.qaUrl to the QA subtask execution", async () => {
    const deps = createDeps({ qaUrl: "http://127.0.0.1:9001", devUrl: "http://127.0.0.1:9002" });
    await processTask(TASK, deps);
    const qaCall = execSpy.inputs.find((input) => input.kind === "qa");
    expect(qaCall).toBeDefined();
    expect(qaCall?.qaBaseUrl).toBe("http://127.0.0.1:9001");
  });

  it("falls back to project.devUrl when qaUrl is absent", async () => {
    const deps = createDeps({ devUrl: "http://127.0.0.1:9002" });
    await processTask(TASK, deps);
    const qaCall = execSpy.inputs.find((input) => input.kind === "qa");
    expect(qaCall).toBeDefined();
    expect(qaCall?.qaBaseUrl).toBe("http://127.0.0.1:9002");
  });

  it("never mutates process.env.QA_BASE_URL", async () => {
    const before = process.env.QA_BASE_URL;
    const deps = createDeps({ qaUrl: "http://127.0.0.1:9001" });
    await processTask(TASK, deps);
    expect(process.env.QA_BASE_URL).toBe(before);
  });

  it("QA's pass message does not mention itself", async () => {
    const deps = createDeps({ qaUrl: "http://127.0.0.1:9001" });
    await processTask(TASK, deps);
    // The message is authored by the QA agent, so it must read in first
    // person — "@QA QA validation passed" talks about QA in third person.
    const qaMessages = deps.messages.filter((m) => m.agentId === "agent-qa");
    expect(qaMessages.length).toBeGreaterThan(0);
    for (const message of qaMessages) {
      expect(message.content).not.toMatch(/^@QA\b/);
    }
    expect(qaMessages.some((m) => m.content.startsWith("QA validation passed"))).toBe(true);
  });
});
