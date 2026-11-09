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
import { withApiDefaults } from "./helpers/fakeApi";
import { testPolicy } from "./helpers/policy";

/**
 * Phase 4 at the runner level (executor mocked, following the
 * orchestratorLive.integration pattern):
 *  - per-agent concurrency: two parallel subtasks routed to ONE agent
 *    are serialized at maxConcurrency 1 and overlap at 2;
 *  - the policy.taskTimeoutMs deadline aborts a running subtask and
 *    fails the task instead of letting it run on;
 *  - recovery: processTask adopting a stored plan does NOT re-execute
 *    subtasks the DB already marks completed (buildStateFromDb), and
 *    their staged file changes still reach the apply phase.
 */

const mockState = vi.hoisted(() => ({
  executed: [] as string[],
  activeByAgent: new Map<string, number>(),
  peakByAgent: new Map<string, number>(),
  sawAbort: false,
  mode: "track" as "track" | "hang",
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    agent: { _id: string };
    signal: AbortSignal;
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    mockState.executed.push(key);
    if (mockState.mode === "hang") {
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          mockState.sawAbort = true;
          resolve();
          return;
        }
        input.signal.addEventListener(
          "abort",
          () => {
            mockState.sawAbort = true;
            resolve();
          },
          { once: true }
        );
        // Safety net: resolve anyway so a broken abort path fails the
        // assertions below instead of hanging the suite.
        setTimeout(resolve, 4000);
      });
      return { status: "failed", error: "Execution cancelled" };
    }
    const agentId = input.agent._id;
    const now = (mockState.activeByAgent.get(agentId) ?? 0) + 1;
    mockState.activeByAgent.set(agentId, now);
    mockState.peakByAgent.set(
      agentId,
      Math.max(mockState.peakByAgent.get(agentId) ?? 0, now)
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (input.subtask.kind === "code_change") {
        const filePath = `file-${key}.txt`;
        await input.saveFileChange({
          filePath,
          changeType: "new",
          newContent: "content\n",
          diff: "",
        });
        return {
          status: "completed",
          output: "changed",
          meta: { filePaths: [filePath] },
        };
      }
      if (input.subtask.kind === "qa") {
        return {
          status: "completed",
          output: "QA verdict: passed",
          meta: { verdict: "passed", checks: [] },
        };
      }
      return { status: "completed", output: "ok" };
    } finally {
      mockState.activeByAgent.set(
        agentId,
        (mockState.activeByAgent.get(agentId) ?? 1) - 1
      );
    }
  },
}));

import { processTask } from "@/services/taskRunner";

const BASE_POLICY: ExecutionPolicy = testPolicy({
  maxConcurrency: 2,
  maxReplans: 0,
  maxPlanningIterations: 0,
  maxReviewIterations: 2,
  maxConcurrentLLMCalls: 2,
  allowFallback: true,
  orchestratorAuthoritative: true,
});

const implementer = (maxConcurrency?: number) =>
  ({
    _id: "agent-implementer",
    name: "Implementer",
    role: "frontend",
    capabilities: ["frontend-development"],
    isEnabled: true,
    priority: 0,
    maxConcurrency,
  }) as WorkerAgent;

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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-p4-runner-"));
  mockState.executed = [];
  mockState.activeByAgent = new Map();
  mockState.peakByAgent = new Map();
  mockState.sawAbort = false;
  mockState.mode = "track";
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const planWith = (
  subtasks: ExecutionPlan["subtasks"],
  maxConcurrency = 2
): ExecutionPlan => ({
  version: 1,
  goal: "Phase 4 runner test",
  strategy: "dag",
  requiresApproval: true,
  maxConcurrency,
  subtasks,
});

interface Captured {
  completions: Array<Record<string, unknown>>;
}

function createDeps(
  plan: ExecutionPlan,
  agents: WorkerAgent[],
  policy: ExecutionPolicy = BASE_POLICY,
  seed: {
    subtaskStatus?: Record<string, WorkerSubtask["status"]>;
    subtaskOutput?: Record<string, string>;
    fileChanges?: WorkerFileChange[];
  } = {}
) {
  const captured: Captured = { completions: [] };
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Phase 4 runner test",
    command: "Phase 4 runner test",
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
    status: seed.subtaskStatus?.[subtask.key] ?? "pending",
    output: seed.subtaskOutput?.[subtask.key],
    attempts: 0,
  })) as WorkerSubtask[];
  const seededChanges = seed.fileChanges ?? [];
  const changes = new Map<string, WorkerFileChange>();

  const api = {
    getContext: async () => ({
      task,
      project,
      agents,
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
    logEvent: async () => undefined,
    startExecution: async () => "exec-1",
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find(
        (candidate) => candidate.key === input.subtaskKey
      );
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
      newContent?: string;
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
        const change =
          changes.get(filePath) ??
          seededChanges.find((candidate) => candidate.filePath === filePath);
        if (change) change.appliedAt = now;
      }
    },
    getFileChanges: async () => [
      ...seededChanges,
      ...Array.from(changes.values()),
    ],
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    recordDelegation: async () => undefined,
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
      policy,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

const twoParallelImpl = (): ExecutionPlan =>
  planWith([
    {
      key: "impl_a",
      title: "Implement A",
      description: "Write A",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 0,
      // Disjoint scopes: two unscoped writers are serialized by the
      // conflict guard, which would hide the per-agent gate under test.
      allowedPaths: ["src/a"],
    },
    {
      key: "impl_b",
      title: "Implement B",
      description: "Write B",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 1,
      allowedPaths: ["src/b"],
    },
  ]);

describe("processTask per-agent concurrency (Phase 4)", () => {
  it("maxConcurrency 1 serializes two parallel subtasks routed to the same agent", async () => {
    const { deps, captured, task } = createDeps(twoParallelImpl(), [
      implementer(1),
    ]);
    await processTask(task, deps);
    expect(mockState.executed.sort()).toEqual(["impl_a", "impl_b"]);
    expect(mockState.peakByAgent.get("agent-implementer")).toBe(1);
    expect(captured.completions[0]?.status).toBe("done");
  });

  it("maxConcurrency 2 lets both subtasks of the same agent overlap", async () => {
    const { deps, captured, task } = createDeps(twoParallelImpl(), [
      implementer(2),
    ]);
    await processTask(task, deps);
    expect(mockState.executed.sort()).toEqual(["impl_a", "impl_b"]);
    expect(mockState.peakByAgent.get("agent-implementer")).toBe(2);
    expect(captured.completions[0]?.status).toBe("done");
  });
});

describe("processTask deadline (Phase 4)", () => {
  it("taskTimeoutMs aborts the running subtask and fails the task", async () => {
    mockState.mode = "hang";
    const plan = planWith([
      {
        key: "implement",
        title: "Implement",
        description: "Write the file",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: [],
        order: 0,
      },
    ]);
    const policy: ExecutionPolicy = { ...BASE_POLICY, taskTimeoutMs: 150 };
    const { deps, captured, task } = createDeps(
      plan,
      [implementer(1)],
      policy
    );
    const started = Date.now();
    await processTask(task, deps);
    const elapsed = Date.now() - started;
    expect(mockState.sawAbort).toBe(true);
    expect(elapsed).toBeLessThan(4000);
    expect(captured.completions[0]?.status).toBe("failed");
  });
});

describe("processTask recovery (Phase 4)", () => {
  it("does not re-execute subtasks the DB already marks completed", async () => {
    const plan = planWith([
      {
        key: "implement",
        title: "Implement",
        description: "Write the file",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: [],
        order: 0,
      },
      {
        key: "qa",
        title: "QA",
        description: "Run QA",
        kind: "qa",
        capability: "browser-testing",
        dependencies: ["implement"],
        order: 1,
      },
    ]);
    const seededChange = {
      _id: "change-seed",
      taskId: "task-1",
      filePath: "file-implement.txt",
      changeType: "new",
      newContent: "content\n",
      diff: "",
    } as unknown as WorkerFileChange;
    const { deps, captured, task } = createDeps(
      plan,
      [implementer(1), QA_AGENT],
      BASE_POLICY,
      {
        subtaskStatus: { implement: "completed" },
        subtaskOutput: { implement: "implemented earlier" },
        fileChanges: [seededChange],
      }
    );
    await processTask(task, deps);

    // The completed subtask was skipped; only the pending QA ran.
    expect(mockState.executed).toEqual(["qa"]);
    expect(captured.completions[0]?.status).toBe("done");
    // Its staged change still flowed through the apply phase.
    const applied = await fs.readFile(
      path.join(workspace, "file-implement.txt"),
      "utf-8"
    );
    expect(applied).toBe("content\n");
  });
});
