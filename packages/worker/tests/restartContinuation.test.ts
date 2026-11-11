import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { WorkerAgent, WorkerApi, WorkerSubtask, WorkerTask } from "@/workerApi";
import {
  CONTINUE_PROMPT,
  CONTINUATION_LOOP_WINDOW_MS,
  SUBTASK_CONTINUED_EVENT,
  buildContinuationText,
  decideContinuation,
  interruptedSubtaskKeys,
  isReadOnlyCommand,
  toRecordedStep,
  type RecordedStep,
} from "@/api/convex/lib/restartContinuation";
import { planContinuations } from "@/services/runner/state";
import { withApiDefaults } from "./helpers/fakeApi";

/**
 * G4 restart continuation. A worker restart is simulated the way
 * phase4HardeningRecovery.test.ts does it: generation 1 runs over a
 * shared store and is abandoned mid-subtask; the store then gets what
 * orchestration.recoverStale writes (running row → pending, execution
 * `leaseLost`); generation 2 is a fresh runner over the same store, and
 * its run context carries the recorded steps like getRunContext.
 */

type CommandOutcome = { allowed: boolean; via: string; reason: string };

const mock = vi.hoisted(() => ({
  generation: 1,
  descriptions: [] as string[],
  outcomes: [] as CommandOutcome[],
  pushes: 0,
  calls: 0,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; description: string };
    onEvent: (type: string, payload: unknown, level?: string) => Promise<void>;
    requestCommandApproval?: (cmd: { command: string; args: string[] }) => Promise<CommandOutcome>;
  }) => {
    mock.calls += 1;
    mock.descriptions.push(input.subtask.description);
    if (mock.generation === 1) {
      // The push starts (recorded), then the worker dies mid-subtask.
      await input.onEvent("shell.command", { command: "git", args: ["push", "origin", "main"], cwd: "/w" }, "info");
      mock.pushes += 1;
      await new Promise<never>(() => undefined);
    }
    // The continuation tries the same push again.
    const outcome = await input.requestCommandApproval!({ command: "git", args: ["push", "origin", "main"] });
    mock.outcomes.push(outcome);
    if (outcome.allowed) mock.pushes += 1;
    return { status: "completed", output: "pushed or confirmed" };
  },
}));

import { processTask } from "@/services/taskRunner";

const POLICY: ExecutionPolicy = {
  maxSubtasks: 8,
  maxConcurrency: 1,
  maxReplans: 0,
  maxPlanningIterations: 0,
  maxReviewIterations: 2,
  subtaskTimeoutMs: 30_000,
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

const AGENTS = [
  { _id: "agent-devops", name: "DevOps", role: "devops", capabilities: ["devops"], isEnabled: true, priority: 0 },
] as WorkerAgent[];

const PLAN: ExecutionPlan = {
  version: 1,
  goal: "Ship it",
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: [
    { key: "ship", title: "Ship", description: "Push the release branch", kind: "analysis", capability: "devops", dependencies: [], order: 0 },
  ],
};

interface Store {
  status: string;
  output?: string;
  events: Array<{ type: string; subtaskKey?: string; payload?: unknown; createdAt: number; sequence: number }>;
  executions: Array<{ subtaskKey: string; status: string; leaseLost?: boolean; attempt: number; createdAt: number }>;
  completions: Array<Record<string, unknown>>;
}

const newStore = (): Store => ({ status: "pending", events: [], executions: [], completions: [] });

/** What getRunContext.recordedSteps holds (lib/restartSteps.loadRecordedSteps). */
function recordedSteps(store: Store, subtasks: Array<{ key: string; status: string }>): RecordedStep[] {
  const keys = new Set(interruptedSubtaskKeys(subtasks, store.executions));
  return store.events.filter((event) => event.subtaskKey && keys.has(event.subtaskKey)).map(toRecordedStep);
}

function generation(store: Store, workspacePath: string) {
  const task = { _id: "task-1", projectId: "project-1", title: "Ship it", command: "Ship it", status: "running", replanCount: 0 };
  const project = { _id: "project-1", name: "Fixture", workspacePath, approvalMode: "auto" as const };
  const rows = (): WorkerSubtask[] => [
    { _id: "sub-1", taskId: task._id, ...PLAN.subtasks[0], status: store.status, output: store.output, attempts: 0 } as unknown as WorkerSubtask,
  ];
  const api = {
    getContext: async () => ({
      task,
      project,
      agents: AGENTS,
      plan: { _id: "plan-1", taskId: task._id, version: 1, strategy: "dag", createdBy: "orchestrator", goal: PLAN.goal, payload: PLAN, createdAt: 0 },
      subtasks: rows(),
      executions: store.executions,
      recordedSteps: recordedSteps(store, rows()),
      approvalMode: "auto" as const,
    }),
    logEvent: async (input: { type: string; subtaskKey?: string; payload?: unknown }) => {
      store.events.push({ type: input.type, subtaskKey: input.subtaskKey, payload: input.payload, createdAt: Date.now(), sequence: store.events.length + 1 });
    },
    startExecution: async (input: { subtaskKey: string }) => {
      store.status = store.status === "completed" ? "completed" : "running";
      store.executions.push({ subtaskKey: input.subtaskKey, status: "running", attempt: store.executions.length + 1, createdAt: Date.now() });
      return `exec-${store.executions.length}`;
    },
    updateExecution: async (input: { status: string; output?: string }) => {
      store.status = store.status === "completed" ? "completed" : input.status;
      if (input.output) store.output = input.output;
      const last = store.executions[store.executions.length - 1];
      if (last) last.status = input.status;
    },
    updateSubtask: async (input: { status: string; output?: string }) => {
      store.status = store.status === "completed" ? "completed" : input.status;
      if (input.output) store.output = input.output;
      return true;
    },
    getFileChanges: async () => [],
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    recordDelegation: async () => undefined,
    completeTask: async (input: Record<string, unknown>) => {
      store.completions.push(input);
      return { applied: true, status: input.status };
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
    markFilesApplied: async () => undefined,
  };
  return {
    deps: { api: withApiDefaults(api) as unknown as WorkerApi, workerId: "test-worker", policy: POLICY, workspaceRoot: workspacePath, log: () => undefined },
    task: task as unknown as WorkerTask,
  };
}

/** orchestration.recoverStale: the running row returns to pending, its execution is ended leaseLost. */
function recoverStale(store: Store): void {
  if (store.status === "running") store.status = "pending";
  for (const execution of store.executions) {
    if (execution.status === "running") Object.assign(execution, { status: "failed", leaseLost: true });
  }
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-g4-"));
  Object.assign(mock, { generation: 1, descriptions: [], outcomes: [], pushes: 0, calls: 0 });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("G4 restart continuation (worker)", () => {
  it("a killed subtask resumes with CONTINUE_PROMPT and its recorded steps, and the recorded push is not run again", async () => {
    const store = newStore();
    const gen1 = generation(store, workspace);
    processTask(gen1.task, gen1.deps).catch(() => undefined); // the dead worker, never awaited
    await vi.waitFor(() => expect(mock.pushes).toBe(1), { timeout: 5_000, interval: 20 });
    expect(store.status).toBe("running");

    recoverStale(store);
    mock.generation = 2;
    const gen2 = generation(store, workspace);
    await processTask(gen2.task, gen2.deps);

    expect(mock.calls).toBe(2);
    const resumed = mock.descriptions[1];
    expect(resumed.startsWith("Push the release branch")).toBe(true);
    expect(resumed).toContain(CONTINUE_PROMPT);
    expect(resumed).toContain("ran `git push origin main`");
    expect(resumed).toContain("will not be run again");
    // The recorded side effect is refused by the gate, never repeated.
    expect(mock.outcomes).toEqual([expect.objectContaining({ allowed: false, via: "recorded" })]);
    expect(mock.pushes).toBe(1);
    const continued = store.events.filter((event) => event.type === SUBTASK_CONTINUED_EVENT);
    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject({ subtaskKey: "ship", payload: { attempt: 1, steps: 1, sideEffects: ["git push origin main"] } });
    expect(store.events.some((event) => event.type === "shell.command_declined")).toBe(true);
    expect(store.completions.at(-1)?.status).toBe("done");
  }, 20_000);

  it("a 4th continuation inside 5 minutes is refused with a clear reason and the task fails the normal way", async () => {
    const store = newStore();
    const now = Date.now();
    store.status = "pending";
    store.executions.push({ subtaskKey: "ship", status: "failed", leaseLost: true, attempt: 4, createdAt: now - 1_000 });
    for (const ago of [240_000, 120_000, 30_000]) {
      store.events.push({ type: SUBTASK_CONTINUED_EVENT, subtaskKey: "ship", payload: {}, createdAt: now - ago, sequence: store.events.length + 1 });
    }
    mock.generation = 2;
    const gen = generation(store, workspace);
    await processTask(gen.task, gen.deps);

    expect(mock.calls).toBe(0);
    expect(store.events.filter((event) => event.type === SUBTASK_CONTINUED_EVENT)).toHaveLength(3);
    const refused = store.events.find((event) => event.type === "subtask.continuation_refused");
    expect((refused?.payload as { reason: string }).reason).toMatch(/Continuation refused: this run was already continued 3 times in the last 5 minutes/);
    const last = store.completions.at(-1);
    expect(last?.status).toBe("failed");
    expect(String(last?.errorMessage)).toContain("Continuation refused");
  }, 20_000);
});

describe("G4 continuation pieces", () => {
  const now = 10_000_000;

  it("the loop guard allows 3 continuations in 5 minutes and refuses the 4th", () => {
    expect(decideContinuation([], now)).toEqual({ allowed: true, attempt: 1 });
    expect(decideContinuation([now - 10_000, now - 20_000], now)).toEqual({ allowed: true, attempt: 3 });
    const fourth = decideContinuation([now - 10_000, now - 20_000, now - 30_000], now);
    expect(fourth.allowed).toBe(false);
    // An old continuation outside the window does not count.
    expect(decideContinuation([now - CONTINUATION_LOOP_WINDOW_MS - 1, now - 1, now - 2], now)).toEqual({ allowed: true, attempt: 3 });
  });

  it("planContinuations picks only cut-off subtasks and counts their own continuations", () => {
    const subtasks = [
      { key: "a", status: "pending" },
      { key: "b", status: "completed" },
      { key: "c", status: "pending" },
      { key: "d", status: "pending" },
    ];
    const executions = [
      { subtaskKey: "a", status: "failed", leaseLost: true, attempt: 1 },
      { subtaskKey: "b", status: "failed", leaseLost: true, attempt: 1 },
      { subtaskKey: "c", status: "failed", attempt: 1 },
      { subtaskKey: "d", status: "failed", leaseLost: true, attempt: 1 },
    ];
    const steps: RecordedStep[] = [
      { type: "shell.command", subtaskKey: "a", command: "npm", args: ["test"] },
      ...[1, 2, 3].map((n) => ({ type: SUBTASK_CONTINUED_EVENT, subtaskKey: "d", createdAt: now - n * 1_000 })),
    ];
    const plan = planContinuations(subtasks, executions, steps, now);
    expect([...plan.keys()].sort()).toEqual(["a", "d"]);
    expect(plan.get("a")).toMatchObject({ allowed: true, attempt: 1, sideEffects: [] });
    expect(plan.get("d")).toMatchObject({ allowed: false });
  });

  it("read-only commands may run again; state-changing ones are listed as recorded side effects", () => {
    expect(isReadOnlyCommand("git", ["status"])).toBe(true);
    expect(isReadOnlyCommand("npm", ["run", "typecheck"])).toBe(true);
    expect(isReadOnlyCommand("git", ["push", "origin", "main"])).toBe(false);
    expect(isReadOnlyCommand("find", [".", "-delete"])).toBe(false);
    expect(isReadOnlyCommand("rm", ["-rf", "dist"])).toBe(false);
    const text = buildContinuationText([
      toRecordedStep({ type: "shell.command", payload: { command: "git", args: ["status"] } }),
      toRecordedStep({ type: "fileChanges.updated", payload: { filePaths: ["src/a.ts"] } }),
      toRecordedStep({ type: "shell.command", payload: { command: "rm", args: ["-rf", "dist"] } }),
    ]);
    expect(text.startsWith(CONTINUE_PROMPT)).toBe(true);
    expect(text).toContain("- ran `git status`\n- edited src/a.ts\n- ran `rm -rf dist`");
    expect(text).toContain("will not be run again:\n- rm -rf dist");
    expect(text).not.toContain("will not be run again:\n- git status");
  });
});
