/**
 * Regression lane (regress-tests): failure injection.
 *
 *  - a provider timeout or a 429 that cuts a stream, injected at planning,
 *    execution and review, ends the task as a provider hold (429) or a
 *    failure (timeout) with the right failureKind, never a silent "done";
 *  - a corrupted or missing execution context on resume (missing plan,
 *    garbage plan payload, deleted worktree) fails cleanly.
 *
 * The planner and the executor are mocked (the runner is what is under
 * test); one case runs the real executor against a provider that dies
 * mid-stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerAgent, WorkerTask } from "@/workerApi";
import { classifyProviderHold } from "@/api/convex/lib/providerHold";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

const RATE_LIMIT = "LLM request failed (429) for model m: Too Many Requests (stream cut after 120 chars)";
const TIMEOUT = "LLM request timed out after 30000ms";

const inject = vi.hoisted(() => ({
  planning: null as string | null,
  byKind: {} as Record<string, string | undefined>,
}));

vi.mock("../src/orchestrator/planner", () => {
  const plan = {
    version: 1,
    goal: "Implement the feature",
    strategy: "dag",
    requiresApproval: false,
    maxConcurrency: 1,
    subtasks: [
      { key: "implement", title: "Implement", description: "Write the code", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
      { key: "review", title: "Review", description: "Review it", kind: "review", capability: "code-review", dependencies: ["implement"], order: 1 },
    ],
  };
  return {
    createPlan: async () => {
      if (inject.planning) throw new Error(inject.planning);
      return { plan, createdBy: "llm", notes: [] };
    },
    heuristicPlan: () => plan,
  };
});

vi.mock("../src/execution/agentExecutor", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/execution/agentExecutor")>();
  return {
    ...real,
    executeSubtask: async (input: { subtask: { key: string; kind: string }; saveFileChange: (c: unknown) => Promise<void> }) => {
      const error = inject.byKind[input.subtask.kind];
      if (error) return { status: "failed", error };
      if (input.subtask.kind === "code_change") {
        await input.saveFileChange({ filePath: "a.txt", changeType: "new", newContent: "a\n", diff: "+a" });
        return { status: "completed", output: "done", meta: { filePaths: ["a.txt"] } };
      }
      if (input.subtask.kind === "review") {
        return { status: "completed", output: '{"verdict":"approved","findings":[]}', meta: { verdict: "approved", findings: [] } };
      }
      return { status: "completed", output: "ok" };
    },
    realExecuteSubtask: real.executeSubtask,
  };
});

import { processTask } from "@/services/taskRunner";
import { resumeTask } from "@/services/runner/resume";
import * as executor from "@/execution/agentExecutor";

const AGENTS = [
  { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, priority: 0 },
  { _id: "rv", name: "Reviewer", role: "reviewer", capabilities: ["code-review"], isEnabled: true, priority: 1 },
] as WorkerAgent[];

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-faults-"));
  inject.planning = null;
  inject.byKind = {};
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function run() {
  const task = testTask({ title: "Implement the feature", command: "Implement the feature" });
  const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const { api, completions } = createFakeApi({
    getContext: async () => ({ task, project, agents: AGENTS, plan: null, subtasks: [], approvalMode: "auto" as const }),
    logEvent: async (event: { type: string; payload?: Record<string, unknown> }) => void events.push(event),
  });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxReplans: 0,
    maxPlanningIterations: 0,
    maxReviewIterations: 0,
    maxConcurrentLLMCalls: 1,
    orchestratorAuthoritative: false,
    reviewMode: "always",
  });
  return { deps: createRunnerDeps({ api, policy, workspaceRoot: workspace }), completions, events, task: task as unknown as WorkerTask };
}

function expectHold(events: Array<{ type: string; payload?: Record<string, unknown> }>, completions: Array<Record<string, unknown>>) {
  const hold = events.find((e) => e.type === "llm.provider_hold");
  expect(hold?.payload?.failureKind).toBe("provider_hold");
  expect(events.some((e) => e.type === "task.error")).toBe(false);
  expect(completions.at(-1)).toMatchObject({ status: "failed" });
  expect(String(completions.at(-1)?.errorMessage)).toMatch(/429/);
  // The backend turns exactly this message into a hold (completeTask).
  expect(classifyProviderHold(String(completions.at(-1)?.errorMessage))?.kind).toBe("rate_limit");
}

function expectFailure(events: Array<{ type: string; payload?: Record<string, unknown> }>, completions: Array<Record<string, unknown>>) {
  expect(completions.some((c) => c.status === "done")).toBe(false);
  expect(completions.at(-1)?.status).toBe("failed");
  expect(String(completions.at(-1)?.errorMessage)).toMatch(/timed out/);
  const error = events.find((e) => e.type === "task.error");
  expect(error?.payload?.failureKind).toBeTruthy();
  expect(error?.payload?.failureKind).not.toBe("provider_hold");
  expect(classifyProviderHold(String(completions.at(-1)?.errorMessage))).toBeNull();
}

describe("provider faults never end as a silent success", () => {
  it("planning: a 429 is a provider hold", async () => {
    inject.planning = RATE_LIMIT;
    const { deps, completions, events, task } = run();
    await processTask(task, deps);
    expectHold(events, completions);
  });

  it("planning: a timeout fails the task", async () => {
    inject.planning = TIMEOUT;
    const { deps, completions, events, task } = run();
    await processTask(task, deps);
    expectFailure(events, completions);
  });

  it("execution: a 429 mid-stream is a provider hold", async () => {
    inject.byKind.code_change = RATE_LIMIT;
    const { deps, completions, events, task } = run();
    await processTask(task, deps);
    expectHold(events, completions);
  });

  it("execution: a timeout fails the task", async () => {
    inject.byKind.code_change = TIMEOUT;
    const { deps, completions, events, task } = run();
    await processTask(task, deps);
    expectFailure(events, completions);
  });

  it("review: a 429 is a provider hold", async () => {
    inject.byKind.review = RATE_LIMIT;
    const { deps, completions, events, task } = run();
    await processTask(task, deps);
    expectHold(events, completions);
  });

  it("review: a timeout fails the task", async () => {
    inject.byKind.review = TIMEOUT;
    const { deps, completions, events, task } = run();
    await processTask(task, deps);
    expectFailure(events, completions);
  });

  it("the real executor surfaces a stream cut by a 429 with the provider error, staging nothing", async () => {
    const real = (executor as unknown as { realExecuteSubtask: typeof executor.executeSubtask }).realExecuteSubtask;
    const provider = {
      complete: async (_m: unknown, options?: { onChunk?: (chunk: string) => void }) => {
        options?.onChunk?.('{"files":[{"filePath":"a.txt","newCon');
        throw new Error(RATE_LIMIT);
      },
    };
    const saved: unknown[] = [];
    const subtask = { key: "n1", title: "n", description: "Edit a.txt", kind: "code_change" as const, capability: "frontend-development", dependencies: [], order: 0 };
    const call = real({
      workspacePath: workspace,
      command: "edit a.txt",
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: true, maxConcurrency: 1, subtasks: [subtask] },
      subtask,
      agent: { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, priority: 0 },
      llmHandles: [{ connectionId: "c", connectionName: "t", config: { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" }, provider }],
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async (change: unknown) => void saved.push(change),
    } as never);
    // The executor throws provider errors (the scheduler settles the node as
    // failed with this message); it never returns a partial success.
    const error = await call.then(
      (result) => (result.status === "failed" ? result.error : `unexpected ${result.status}`),
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown))
    );
    expect(saved).toHaveLength(0);
    expect(classifyProviderHold(error)?.kind).toBe("rate_limit");
  });
});

// ─── resume with a corrupted or missing execution context ─────────────────

function resumeDeps(overrides: { plan?: unknown; worktreePath?: string; branchName?: string }) {
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Implement the feature",
    command: "Implement the feature",
    status: "needs_approval",
    ...(overrides.worktreePath ? { worktreePath: overrides.worktreePath, branchName: overrides.branchName ?? "fhara/task-1" } : {}),
  };
  const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
  const statuses: string[] = [];
  const { api, completions } = createFakeApi({
    getContext: async () => ({
      task,
      project,
      agents: AGENTS,
      plan: overrides.plan === undefined ? null : { _id: "plan-1", taskId: "task-1", version: 1, strategy: "dag", createdBy: "orchestrator", goal: "g", payload: overrides.plan, createdAt: 0 },
      subtasks: [],
      executions: [],
      approvalMode: "auto" as const,
      llmProviders: [],
    }),
    getApprovals: async () => [{ _id: "ap-1", kind: "apply_changes", status: "approved" }],
    setTaskStatus: async (input: { status: string }) => {
      statuses.push(input.status);
      return true;
    },
  });
  const deps = createRunnerDeps({ api, policy: testPolicy({ maxConcurrency: 1, maxReplans: 0, maxReviewIterations: 0, maxConcurrentLLMCalls: 1 }), workspaceRoot: workspace });
  return { deps, completions, statuses };
}

describe("resume with a corrupted or missing execution context fails cleanly", () => {
  it("a missing plan fails the task without running anything", async () => {
    const { deps, completions, statuses } = resumeDeps({});
    await resumeTask("task-1", deps);
    expect(completions).toEqual([expect.objectContaining({ status: "failed", errorMessage: "Stored plan is missing or invalid" })]);
    expect(statuses).toEqual([]);
  });

  it("a garbage plan payload fails the task the same way", async () => {
    const { deps, completions } = resumeDeps({ plan: { subtasks: "not-an-array", goal: 42 } });
    await resumeTask("task-1", deps);
    expect(completions).toEqual([expect.objectContaining({ status: "failed", errorMessage: "Stored plan is missing or invalid" })]);
  });

  it("a deleted worktree fails the task instead of recreating an empty folder and running on", async () => {
    const plan = {
      version: 1,
      goal: "g",
      strategy: "single",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [{ key: "implement", title: "Implement", description: "Write the code", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 }],
    };
    const worktreePath = path.join(workspace, ".worktrees", "task-1");
    const { deps, completions } = resumeDeps({ plan, worktreePath });
    await resumeTask("task-1", deps);
    expect(completions.some((c) => c.status === "done")).toBe(false);
    expect(completions.at(-1)).toMatchObject({ status: "failed" });
    expect(String(completions.at(-1)?.errorMessage)).toMatch(/worktree/i);
    expect(existsSync(worktreePath)).toBe(false);
  });
});
