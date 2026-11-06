import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LlmConcurrencyGate,
  runLlmCall,
  setWorkerLlmConcurrencyLimit,
} from "@/effects/llmCall";
import type {
  GlobalLLMConfig,
  LLMCallOptions,
  LLMMessage,
  LLMProvider,
  LLMResult,
} from "@/llm";
import type { TaskLlmResolver } from "@/llm/resolver";
import { createPlan } from "@/orchestrator/planner";
import { createAuthoritativePlan } from "@/orchestrator/orchestrator";
import { classifyCommand } from "@/orchestrator/classifier";
import type { BudgetTracker } from "@/orchestrator/budget";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type {
  AgentDefinition,
  ExecutionPlan,
} from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerFileChange,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";

/**
 * Phase 4 hardening — mandatory regression tests 1–7.
 *
 * Tests 1–4 exercise the REAL two-tier LLM gate through the REAL
 * runLlmCall with genuinely concurrent promises (Promise.all over
 * in-flight calls) and delay providers that measure actual overlap.
 * Test 5 cancels planning mid-flight. Tests 6–7 run the REAL
 * processTask/resumeTask with only the subtask executor mocked (the
 * established Phase 4 pattern) — cancellation and resume outcomes are
 * asserted on the captured backend writes.
 */

const MESSAGES: LLMMessage[] = [{ role: "user", content: "hi" }];

interface Tracker {
  active: number;
  peak: number;
  calls: number;
}

function makeTracker(): Tracker {
  return { active: 0, peak: 0, calls: 0 };
}

/** Provider that answers after a delay and tracks real overlap. */
function delayProvider(tracker: Tracker, delayMs: number): LLMProvider {
  return {
    complete: (
      _messages: LLMMessage[],
      _model?: string,
      opts?: LLMCallOptions
    ) => {
      tracker.calls += 1;
      tracker.active += 1;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      return new Promise<LLMResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          tracker.active -= 1;
          resolve({ content: "ok", inputTokens: 1, outputTokens: 1 });
        }, delayMs);
        opts?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            tracker.active -= 1;
            reject(new Error("LLM request aborted by caller"));
          },
          { once: true }
        );
      });
    },
  } as unknown as LLMProvider;
}

/** Provider that never answers until the caller's signal aborts. */
function hangProvider(tracker: Tracker): LLMProvider {
  return {
    complete: (
      _messages: LLMMessage[],
      _model?: string,
      opts?: LLMCallOptions
    ) => {
      tracker.calls += 1;
      return new Promise<LLMResult>((_resolve, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new Error("LLM request aborted by caller")),
          { once: true }
        );
        // Safety net: if the abort never reaches the provider the test
        // must fail on its assertions, not hang the suite.
        setTimeout(
          () => reject(new Error("hang provider safety timeout")),
          8_000
        );
      });
    },
  } as unknown as LLMProvider;
}

describe("two-tier LLM concurrency (mandatory tests 1-3)", () => {
  it("test 1: two concurrent tasks with different per-task limits each honor their own", async () => {
    const workerGate = new LlmConcurrencyGate(10);
    const gateA = new LlmConcurrencyGate(1);
    const gateB = new LlmConcurrencyGate(3);
    const trackerA = makeTracker();
    const trackerB = makeTracker();

    const calls = [
      ...Array.from({ length: 4 }, () =>
        runLlmCall(delayProvider(trackerA, 50), MESSAGES, "m", {
          gate: workerGate,
          taskGate: gateA,
          retries: 0,
        })
      ),
      ...Array.from({ length: 4 }, () =>
        runLlmCall(delayProvider(trackerB, 50), MESSAGES, "m", {
          gate: workerGate,
          taskGate: gateB,
          retries: 0,
        })
      ),
    ];
    await Promise.all(calls);

    expect(trackerA.calls).toBe(4);
    expect(trackerB.calls).toBe(4);
    // Task A's limit is 1 even though task B (limit 3) ran alongside:
    // neither task's policy resized the other's gate.
    expect(trackerA.peak).toBe(1);
    expect(trackerB.peak).toBe(3);
  });

  it("test 2: the worker-wide limit is never exceeded across tasks", async () => {
    setWorkerLlmConcurrencyLimit(2);
    try {
      const shared = makeTracker();
      const gateA = new LlmConcurrencyGate(5);
      const gateB = new LlmConcurrencyGate(5);
      const calls = [
        ...Array.from({ length: 3 }, () =>
          runLlmCall(delayProvider(shared, 50), MESSAGES, "m", {
            taskGate: gateA,
            retries: 0,
          })
        ),
        ...Array.from({ length: 3 }, () =>
          runLlmCall(delayProvider(shared, 50), MESSAGES, "m", {
            taskGate: gateB,
            retries: 0,
          })
        ),
      ];
      await Promise.all(calls);
      expect(shared.calls).toBe(6);
      // Both per-task gates would allow 5; the worker gate held the
      // total at exactly its configured 2 — reached (real parallelism)
      // and never exceeded.
      expect(shared.peak).toBe(2);
    } finally {
      setWorkerLlmConcurrencyLimit(8);
    }
  });

  it("test 3: per-task concurrency is never exceeded", async () => {
    const workerGate = new LlmConcurrencyGate(8);
    const taskGate = new LlmConcurrencyGate(2);
    const tracker = makeTracker();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        runLlmCall(delayProvider(tracker, 50), MESSAGES, "m", {
          gate: workerGate,
          taskGate,
          retries: 0,
        })
      )
    );
    expect(tracker.calls).toBe(5);
    expect(tracker.peak).toBe(2);
  });

  it("test 4: cancellation while queued on the semaphore leaves the queue and never calls the provider", async () => {
    const workerGate = new LlmConcurrencyGate(4);
    const taskGate = new LlmConcurrencyGate(1);
    const hangTracker = makeTracker();
    const firstController = new AbortController();
    const first = runLlmCall(hangProvider(hangTracker), MESSAGES, "m", {
      gate: workerGate,
      taskGate,
      signal: firstController.signal,
      retries: 0,
    });
    await vi.waitFor(() => expect(hangTracker.calls).toBe(1));
    expect(taskGate.getActiveCount()).toBe(1);

    const secondTracker = makeTracker();
    const secondController = new AbortController();
    const second = runLlmCall(delayProvider(secondTracker, 10), MESSAGES, "m", {
      gate: workerGate,
      taskGate,
      signal: secondController.signal,
      retries: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(taskGate.getQueuedCount()).toBe(1);
    expect(secondTracker.calls).toBe(0);

    secondController.abort();
    await expect(second).rejects.toThrowError(/aborted/);
    // The waiter is gone from the queue and its provider was NEVER
    // invoked — the cancelled call consumed no provider work.
    expect(taskGate.getQueuedCount()).toBe(0);
    expect(secondTracker.calls).toBe(0);

    firstController.abort();
    await expect(first).rejects.toThrowError(/aborted/);
    // Slots are always released, even on abort.
    expect(taskGate.getActiveCount()).toBe(0);
    expect(workerGate.getActiveCount()).toBe(0);
  });
});

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

const CONFIG: GlobalLLMConfig = {
  provider: "openai-compatible",
  model: "test-model",
  baseUrl: "http://127.0.0.1:9",
  apiKey: ["test", "key"].join("-"),
};

describe("planning cancellation (mandatory test 5)", () => {
  it("test 5: aborting while the planner LLM call is running stops planning — no plan, no fallback, no retry", async () => {
    const tracker = makeTracker();
    const handle = {
      connectionId: "conn-1",
      connectionName: "test",
      config: CONFIG,
      provider: hangProvider(tracker),
    };
    const fakeResolver = {
      handlesFor: () => [handle],
    } as unknown as TaskLlmResolver;
    const plannerAgent: AgentDefinition = {
      _id: "agent-cto",
      name: "CTO",
      role: "cto",
      capabilities: ["architecture", "code-review"],
      isEnabled: true,
      priority: 0,
    };
    const controller = new AbortController();
    const pending = createPlan({
      command: "build a feature",
      classification: classifyCommand("build a feature"),
      agents: [plannerAgent],
      policy: BASE_POLICY,
      llmResolver: fakeResolver,
      signal: controller.signal,
      llmTaskGate: new LlmConcurrencyGate(2),
    });
    await vi.waitFor(() => expect(tracker.calls).toBe(1));
    controller.abort();
    // Planning REJECTS: it must not degrade into the heuristic fallback
    // plan (which would let a cancelled task keep executing).
    await expect(pending).rejects.toThrowError(/abort/i);
    expect(tracker.calls).toBe(1);
  });

  it("test 5b: createAuthoritativePlan with an already-aborted signal produces no plan at all", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createAuthoritativePlan({
        taskId: "task-x",
        projectId: "project-x",
        command: "build a feature",
        title: "Build",
        agents: [],
        budget: {} as unknown as BudgetTracker,
        sharedContext: {} as unknown as SharedTaskContext,
        policy: BASE_POLICY,
        signal: controller.signal,
      })
    ).rejects.toThrowError(/abort/i);
  });
});

// ---------------------------------------------------------------------------
// Runner-level tests (6, 7): real processTask/resumeTask, mocked executor.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  executed: [] as string[],
  sawAbort: false,
  mode: "track" as "track" | "hang" | "fail",
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    signal: AbortSignal;
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    mockState.executed.push(key);
    if (mockState.mode === "fail") {
      return { status: "failed", error: "boom" };
    }
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
        setTimeout(resolve, 4_000);
      });
      return { status: "failed", error: "Execution cancelled" };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    return { status: "completed", output: "ok" };
  },
}));

import { processTask, resumeTask } from "@/services/taskRunner";

const IMPLEMENTER = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;

const SINGLE_IMPL_PLAN: ExecutionPlan = {
  version: 1,
  goal: "Phase 4 hardening runner test",
  strategy: "dag",
  requiresApproval: true,
  maxConcurrency: 2,
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

interface RunnerCapture {
  completions: Array<Record<string, unknown>>;
  evaluations: number;
  savePlanCalls: number;
  eventTypes: string[];
}

function createRunnerDeps(options: {
  policy: ExecutionPolicy;
  taskStatus: string;
  approvals?: unknown[];
}) {
  const captured: RunnerCapture = {
    completions: [],
    evaluations: 0,
    savePlanCalls: 0,
    eventTypes: [],
  };
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Hardening runner test",
    command: "Hardening runner test",
    status: options.taskStatus,
    replanCount: 0,
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
  };
  const subtasks: WorkerSubtask[] = SINGLE_IMPL_PLAN.subtasks.map(
    (subtask, index) =>
      ({
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
      }) as WorkerSubtask
  );
  const changes = new Map<string, WorkerFileChange>();
  const context = {
    task,
    project,
    agents: [IMPLEMENTER],
    plan: {
      _id: "plan-1",
      taskId: task._id,
      version: 1,
      strategy: SINGLE_IMPL_PLAN.strategy,
      createdBy: "orchestrator" as const,
      goal: SINGLE_IMPL_PLAN.goal,
      payload: SINGLE_IMPL_PLAN,
      createdAt: 0,
    },
    subtasks,
    approvals: options.approvals ?? [],
    approvalMode: "auto" as const,
  };
  const api = {
    getContext: async () => context,
    logEvent: async (input: { type: string }) => {
      captured.eventTypes.push(input.type);
    },
    startExecution: async () => "exec-1",
    // Mirrors the backend: updateExecution also patches the subtask
    // row (status + output), which is what finalize later reads.
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
    }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find((c) => c.key === input.subtaskKey);
      if (!subtask) return;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
    },
    updateSubtask: async (input: {
      key: string;
      status: string;
      output?: string;
    }) => {
      const subtask = subtasks.find((c) => c.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
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
    markFilesApplied: async (input: {
      taskId: string;
      filePaths: string[];
    }) => {
      const now = Date.now();
      for (const filePath of input.filePaths) {
        const change = changes.get(filePath);
        if (change) change.appliedAt = now;
      }
    },
    getFileChanges: async () => Array.from(changes.values()),
    getApprovals: async () =>
      (options.approvals ?? []) as Array<{
        _id: string;
        kind: string;
        status: string;
      }>,
    recordAudit: async () => undefined,
    recordEvaluation: async () => {
      captured.evaluations += 1;
    },
    recordDelegation: async () => undefined,
    completeTask: async (input: Record<string, unknown>) => {
      captured.completions.push(input);
      return { applied: true, status: input.status };
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => {
      captured.savePlanCalls += 1;
      return 1;
    },
    requestApproval: async () => "approval-1",
    saveDynamicSubtasks: async () => ({ inserted: [], existing: [] }),
  };
  return {
    deps: {
      api: api as unknown as WorkerApi,
      workerId: "test-worker",
      policy: options.policy,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-p4h-"));
  mockState.executed = [];
  mockState.sawAbort = false;
  mockState.mode = "track";
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("cancellation is terminal at the runner (mandatory test 6)", () => {
  it(
    "test 6: a task that hits its deadline mid-execution is NOT replanned and ends cancelled",
    async () => {
      mockState.mode = "hang";
      const policy: ExecutionPolicy = {
        ...BASE_POLICY,
        taskTimeoutMs: 150,
        // Replanning is fully available: if cancellation did not gate
        // it, this task would be replanned up to 3 times.
        maxPlanningIterations: 3,
        maxReplans: 3,
      };
      const { deps, captured, task } = createRunnerDeps({
        policy,
        taskStatus: "running",
      });

      await processTask(task, deps);

      expect(mockState.sawAbort).toBe(true);
      // Exactly one completion: failed with the deadline message (the
      // documented cancelled mapping — the backend has no dedicated
      // "cancelled" task status).
      expect(captured.completions).toHaveLength(1);
      expect(captured.completions[0].status).toBe("failed");
      expect(String(captured.completions[0].errorMessage)).toMatch(
        /deadline exceeded/i
      );
      expect(captured.eventTypes).toContain("task.cancelled");
      // No replan: savePlan was never called at all (the stored plan
      // was adopted, and a replan would have persisted a fresh plan
      // through it); no replanned event was emitted.
      expect(captured.savePlanCalls).toBe(0);
      expect(captured.eventTypes).not.toContain("plan.replanned");
      expect(captured.evaluations).toBe(0);
    },
    15_000
  );
});

describe("resume outcome handling (mandatory test 7)", () => {
  const approvedContext = {
    approvals: [
      {
        _id: "approval-1",
        taskId: "task-1",
        kind: "apply_changes",
        status: "approved",
      },
    ],
  };

  it(
    "test 7: resume with a FAILED execution ends failed — finalize never marks it done",
    async () => {
      mockState.mode = "fail";
      const { deps, captured } = createRunnerDeps({
        policy: BASE_POLICY,
        taskStatus: "needs_approval",
        approvals: approvedContext.approvals,
      });

      await resumeTask("task-1", deps);

      expect(captured.completions).toHaveLength(1);
      expect(captured.completions[0].status).toBe("failed");
      expect(
        captured.completions.some((c) => c.status === "done")
      ).toBe(false);
      // finalize (evaluation + completion as success) never ran.
      expect(captured.evaluations).toBe(0);
    },
    15_000
  );

  it(
    "test 7 control: resume with a COMPLETED execution still finalizes to done",
    async () => {
      mockState.mode = "track";
      const { deps, captured } = createRunnerDeps({
        policy: BASE_POLICY,
        taskStatus: "needs_approval",
        approvals: approvedContext.approvals,
      });

      await resumeTask("task-1", deps);

      expect(captured.completions).toHaveLength(1);
      expect(captured.completions[0].status).toBe("done");
      expect(captured.evaluations).toBe(1);
    },
    15_000
  );
});
