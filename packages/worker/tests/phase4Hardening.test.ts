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
import { withApiDefaults } from "./helpers/fakeApi";
import { testPolicy } from "./helpers/policy";

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

const BASE_POLICY: ExecutionPolicy = testPolicy({
  maxConcurrency: 2,
  maxReplans: 0,
  maxPlanningIterations: 0,
  maxReviewIterations: 2,
  maxConcurrentLLMCalls: 2,
  allowFallback: true,
  orchestratorAuthoritative: true,
});

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
  reviewCalls: 0,
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
    // First review call requests changes with a high finding (reproducing
    // the trailing-newline review loop from the live runs); the second
    // approves after the fix.
    if (input.subtask.kind === "review") {
      mockState.reviewCalls += 1;
      if (mockState.reviewCalls === 1) {
        return {
          status: "completed",
          output: "Review requested changes:\n\n- **[high]** file-implement.txt — trailing blank line",
          meta: {
            verdict: "changes_requested",
            findings: [
              { severity: "high", filePath: "file-implement.txt", description: "trailing blank line" },
            ],
          },
        };
      }
      return {
        status: "completed",
        output: "Review approved.",
        meta: { verdict: "approved", findings: [] },
      };
    }
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
  },
}));

import { processTask, resumeTask, buildStateFromDb } from "@/services/taskRunner";

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

/** Implement + review, for the fresh-run review-fix loop regression test. */
const REVIEW_PLAN: ExecutionPlan = {
  version: 1,
  goal: "Phase 4 hardening review spam test",
  strategy: "dag",
  requiresApproval: false,
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
    {
      key: "review",
      title: "Review the change",
      description: "Review the changes",
      kind: "review",
      capability: "code-review",
      dependencies: ["implement"],
      order: 1,
    },
  ],
};

/**
 * Incident plan (plan-tone-check smoke): the review loop spawned a fix
 * subtask mid-run, so TWO code_change subtasks edited the same file.
 * The fileChanges table holds one row per path, attributed to the last
 * writer — the earlier implementer would look like it produced nothing.
 */
const INCIDENT_PLAN: ExecutionPlan = {
  version: 1,
  goal: "Phase 4 hardening resume attribution test",
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
    {
      key: "review_fix",
      title: "Fix review findings",
      description: "Address review findings",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: ["implement"],
      order: 1,
    },
    {
      key: "review",
      title: "CTO technical review",
      description: "Review the change",
      kind: "review",
      capability: "code-review",
      dependencies: ["review_fix"],
      order: 2,
    },
    {
      key: "qa",
      title: "QA validation",
      description: "Validate the change",
      kind: "qa",
      capability: "browser-testing",
      dependencies: ["review"],
      order: 3,
    },
  ],
};

/**
 * Approval-flow plan: implement + CTO review + QA all completed before the
 * run was interrupted (approval). After resume none of them may execute
 * again — re-running the review would re-post the same CTO messages.
 */
const FULL_PLAN: ExecutionPlan = {
  version: 1,
  goal: "Phase 4 hardening resume skip test",
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
    {
      key: "review",
      title: "CTO technical review",
      description: "Review the change",
      kind: "review",
      capability: "code-review",
      dependencies: ["implement"],
      order: 1,
    },
    {
      key: "qa",
      title: "QA validation",
      description: "Validate the change",
      kind: "qa",
      capability: "browser-testing",
      dependencies: ["review"],
      order: 2,
    },
  ],
};

interface RunnerCapture {
  completions: Array<Record<string, unknown>>;
  evaluations: number;
  savePlanCalls: number;
  eventTypes: string[];
  statuses: string[];
  messages: string[];
}

function createRunnerDeps(options: {
  policy: ExecutionPolicy;
  taskStatus: string;
  approvals?: unknown[];
  completedSubtasks?: string[];
  plan?: ExecutionPlan;
  completedSubtaskOutputs?: Record<string, string>;
  preparedFileChanges?: Array<{
    filePath: string;
    subtaskKey?: string;
    newContent: string;
  }>;
  executions?: Array<{
    subtaskKey: string;
    status: string;
    meta?: unknown;
  }>;
  extraAgents?: Array<Record<string, unknown>>;
}) {
  const captured: RunnerCapture = {
    completions: [],
    evaluations: 0,
    savePlanCalls: 0,
    eventTypes: [],
    statuses: [],
    messages: [],
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
  const subtasks: WorkerSubtask[] = (options.plan ?? SINGLE_IMPL_PLAN).subtasks.map(
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
        status: options.completedSubtasks?.includes(subtask.key)
          ? "completed"
          : "pending",
        output: options.completedSubtaskOutputs?.[subtask.key],
        attempts: 0,
      }) as WorkerSubtask
  );
  const changes = new Map<string, WorkerFileChange>();
  // Changes persisted by the implementation in the previous run; on
  // resume the apply phase consumes them from the DB.
  for (const change of options.preparedFileChanges ?? []) {
    changes.set(change.filePath, {
      _id: `change-${change.filePath}`,
      taskId: task._id,
      filePath: change.filePath,
      changeType: "new",
      newContent: change.newContent,
      diff: "",
      subtaskKey: change.subtaskKey,
    } as WorkerFileChange);
  }
  const context = {
    task,
    project,
    agents: [IMPLEMENTER, ...((options.extraAgents ?? []) as unknown as WorkerAgent[])],
    plan: {
      _id: "plan-1",
      taskId: task._id,
      version: 1,
      strategy: SINGLE_IMPL_PLAN.strategy,
      createdBy: "orchestrator" as const,
      goal: SINGLE_IMPL_PLAN.goal,
      payload: options.plan ?? SINGLE_IMPL_PLAN,
      createdAt: 0,
    },
    subtasks,
    executions: options.executions ?? [],
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
    setTaskStatus: async (input: { status: string }) => {
      captured.statuses.push(input.status);
      return true;
    },
    appendAgentMessage: async (input: { content?: string }) => {
      captured.messages.push(input.content ?? "");
    },
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
      api: withApiDefaults(api) as unknown as WorkerApi,
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-p4h-"));
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

  it(
    "resume leaves needs_approval and does not re-run completed subtasks",
    async () => {
      mockState.mode = "track";
      const { deps, captured } = createRunnerDeps({
        policy: BASE_POLICY,
        taskStatus: "needs_approval",
        approvals: approvedContext.approvals,
        completedSubtasks: ["implement"],
      });

      await resumeTask("task-1", deps);

      // The user already approved: the task must report "running" while the
      // resumed run executes, not keep the stale needs_approval status that
      // makes the UI advertise an approval button with nothing to approve.
      expect(captured.statuses).toContain("running");
      // A subtask the DB reports completed must not execute again after an
      // approval: that would duplicate the work and its messages.
      expect(mockState.executed).not.toContain("implement");
    },
    15_000
  );

  it(
    "resume does not re-run review/QA stages that already passed before approval",
    async () => {
      mockState.mode = "track";
      const { deps, captured } = createRunnerDeps({
        policy: BASE_POLICY,
        taskStatus: "needs_approval",
        approvals: approvedContext.approvals,
        plan: FULL_PLAN,
        completedSubtasks: ["implement", "review", "qa"],
        completedSubtaskOutputs: {
          review: "Review approved.",
          qa: "QA verdict: passed. Checks: application reachable=passed",
        },
        preparedFileChanges: [
          { filePath: "index.html", subtaskKey: "implement", newContent: "content\n" },
        ],
      });

      await resumeTask("task-1", deps);

      // The verdicts were seeded from the recorded outputs, so the
      // review and QA stages are satisfied without executing them again:
      // re-running the review would re-post the same CTO approval
      // messages and "Checked diff" note.
      expect(mockState.executed).not.toContain("review");
      expect(mockState.executed).not.toContain("qa");
      expect(captured.completions.some((c) => c.status === "done")).toBe(true);
    },
    15_000
  );

  it(
    "a high review finding the fix loop handles does not spam objective-unmet messages",
    async () => {
      // Regression (live runs): the review requests changes with a high
      // finding; the fix loop handles it, but every node settling while
      // the finding is open downgraded to "replan" and posted a CTO
      // "I'm stopping this step" message — 5 copies in one task. The
      // downgrade is bookkeeping and must not narrate to the user.
      mockState.mode = "track";
      mockState.reviewCalls = 0;
      const { deps, captured } = createRunnerDeps({
        policy: BASE_POLICY,
        taskStatus: "running",
        plan: REVIEW_PLAN,
        // Plan 040: the review needs a Reviewer (no fallback owner).
        extraAgents: [{ _id: "agent-reviewer", name: "Reviewer", role: "reviewer", capabilities: ["code-review"], isEnabled: true, priority: 0 }],
      });

      await processTask(
        {
          _id: "task-1",
          projectId: "project-1",
          title: "Review spam test",
          command: "Create file.txt with one line",
          status: "running",
        } as unknown as WorkerTask,
        deps
      );

      expect(mockState.reviewCalls).toBe(2);
      expect(captured.completions.some((c) => c.status === "done")).toBe(true);
      expect(
        captured.messages.filter((m) => m.includes("stopping this step"))
      ).toHaveLength(0);
      // The objective downgrade itself is deferred while the review loop
      // owns the open findings — no objective_unmet churn mid-loop.
      expect(captured.eventTypes).not.toContain("orchestrator.objective_unmet");
    },
    15_000
  );

  it(
    "resume does not spam objective-unmet messages when the file row is attributed to the last writer",
    async () => {
      // Regression (plan-tone-check smoke): implement and review_fix both
      // edited index.html; the fileChanges row keeps only the last
      // writer's subtaskKey (review_fix), so the rebuilt evidence
      // dropped implement. The runner then downgraded every skipped
      // node and posted one "I'm stopping this step" message per node,
      // even though the task completed fine. Executions restore the
      // attribution, and skipped nodes no longer downgrade at all.
      mockState.mode = "track";
      const { deps, captured } = createRunnerDeps({
        policy: BASE_POLICY,
        taskStatus: "needs_approval",
        approvals: approvedContext.approvals,
        plan: INCIDENT_PLAN,
        completedSubtasks: ["implement", "review_fix", "review"],
        completedSubtaskOutputs: {
          review: "Review approved.",
        },
        preparedFileChanges: [
          { filePath: "index.html", subtaskKey: "review_fix", newContent: "content\n" },
        ],
        executions: [
          { subtaskKey: "implement", status: "completed", meta: { filePaths: ["index.html"] } },
          { subtaskKey: "review_fix", status: "completed", meta: { filePaths: ["index.html"] } },
        ],
        extraAgents: [
          {
            _id: "agent-qa",
            name: "QA",
            role: "qa",
            capabilities: ["browser-testing"],
            isEnabled: true,
            priority: 1,
          },
        ],
      });

      await resumeTask("task-1", deps);

      expect(mockState.executed).not.toContain("implement");
      expect(mockState.executed).not.toContain("review_fix");
      expect(mockState.executed).not.toContain("review");
      expect(captured.completions.some((c) => c.status === "done")).toBe(true);
      expect(
        captured.messages.filter((m) => m.includes("stopping this step"))
      ).toHaveLength(0);
      expect(captured.eventTypes).not.toContain("orchestrator.objective_unmet");
    },
    15_000
  );
});

describe("buildStateFromDb file attribution", () => {
  it("attributes the file to every writer, not only the last one", () => {
    // fileChanges holds one row per path; when implement and review_fix
    // both edited the same file the row keeps only the last writer.
    // Executions restore the earlier writers' attribution.
    const { state } = buildStateFromDb({
      subtasks: [
        { key: "implement", kind: "code_change", status: "completed" },
        { key: "review_fix", kind: "code_change", status: "completed" },
        { key: "review", kind: "review", status: "completed", output: "Review approved." },
      ] as any,
      fileChanges: [
        { filePath: "index.html", subtaskKey: "review_fix" },
      ] as any,
      executions: [
        { subtaskKey: "implement", status: "completed", meta: { filePaths: ["index.html"] } },
        { subtaskKey: "review_fix", status: "completed", meta: { filePaths: ["index.html"] } },
      ] as any,
    });
    expect(state.appliedFilesBySubtask.get("implement")).toEqual(["index.html"]);
    expect(state.appliedFilesBySubtask.get("review_fix")).toEqual(["index.html"]);
    expect(state.reviewVerdicts["review"]?.verdict).toBe("approved");
  });

  it("without execution evidence, attribution falls back to the file row", () => {
    const { state } = buildStateFromDb({
      subtasks: [
        { key: "implement", kind: "code_change", status: "completed" },
      ] as any,
      fileChanges: [{ filePath: "index.html", subtaskKey: "implement" }] as any,
    });
    expect(state.appliedFilesBySubtask.get("implement")).toEqual(["index.html"]);
  });

  it("waiting_approval counts as finished for attribution", () => {
    const { completedKeys } = buildStateFromDb({
      subtasks: [
        { key: "implement", kind: "code_change", status: "waiting_approval" },
      ] as any,
      fileChanges: [] as any,
    });
    expect([...completedKeys]).toEqual(["implement"]);
  });
});
