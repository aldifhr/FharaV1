import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerFileChange,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";
import { withApiDefaults } from "./helpers/fakeApi";

/**
 * Phase 4 hardening — mandatory regression tests 8–10: durable
 * recovery of the DYNAMIC DAG.
 *
 * RESTART SIMULATION (labeled honestly): a real worker restart cannot
 * happen inside a unit test, so a restart is simulated by running
 * processTask with a FRESH deps object (fresh runner state, fresh
 * in-memory execution state) over the SAME persistent store — exactly
 * the boundary a real restart crosses, since everything the runner
 * knows after a restart comes from the backend. The fake store
 * mirrors the real backend mutations' semantics:
 *  - savePlan replaces the plan payload AND all subtask rows;
 *  - saveDynamicSubtasks upserts rows by (taskId, key) insert-only and
 *    merges the payload by key (the Phase 4H mutation; the same
 *    semantics are verified against the REAL handler in
 *    phase4HardeningBackend.test.ts);
 *  - startExecution marks the row running, updateExecution patches it
 *    monotonically (completed is absorbing);
 *  - the stale-recovery step between generations mirrors
 *    orchestration.recoverStale: running rows return to pending.
 *
 * Generation 1 runs a task whose implement subtask delegates to a
 * security audit; the audit node hangs (the "worker" is abandoned
 * mid-flight — its processTask promise is never awaited again).
 * Generation 2 must recover the delegation from persistence alone.
 */

const mockState = vi.hoisted(() => ({
  executed: [] as string[],
  hangKeys: new Set<string>(),
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    mockState.executed.push(key);
    if (mockState.hangKeys.has(key)) {
      // The dead worker: never settles, never writes again.
      await new Promise<never>(() => undefined);
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
      const meta: Record<string, unknown> = { filePaths: [filePath] };
      if (key === "implement") {
        meta.delegationRecommendation = {
          targetCapability: "security-audit",
          reason: "needs a security pass",
        };
      }
      return { status: "completed", output: "changed", meta };
    }
    return { status: "completed", output: `${key} output` };
  },
}));

import { processTask } from "@/services/taskRunner";

const POLICY: ExecutionPolicy = {
  maxSubtasks: 8,
  maxConcurrency: 2,
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
  {
    _id: "agent-implementer",
    name: "Implementer",
    role: "frontend",
    capabilities: ["frontend-development"],
    isEnabled: true,
    priority: 0,
  },
  {
    _id: "agent-security",
    name: "Security",
    role: "security",
    capabilities: ["security-audit"],
    isEnabled: true,
    priority: 1,
  },
] as WorkerAgent[];

// The delegation node's key is decided by the engine at its first
// decision step (decisionStep 0): applyDecision keys delegate nodes via
// `decision_delegate_<step>`. The legacy advisory path keyed nodes
// `delegate_<slug>_<n>` — plan 013 step 7 deleted that branch.
const DELEGATE_KEY = "decision_delegate_0";

interface StoreRow {
  key: string;
  title: string;
  description: string;
  kind: string;
  capability: string;
  dependencies: string[];
  order: number;
  status: string;
  output?: string;
  origin?: string;
}

interface Store {
  planPayload: ExecutionPlan;
  planVersion: number;
  rows: Map<string, StoreRow>;
  changes: Map<string, WorkerFileChange>;
  completions: Array<Record<string, unknown>>;
  dynamicSaveCalls: number;
  evaluations: number;
}

function seedStore(workspacePath: string): Store {
  const plan: ExecutionPlan = {
    version: 1,
    goal: "Recovery test",
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
  void workspacePath;
  return {
    planPayload: plan,
    planVersion: 1,
    rows: new Map([
      [
        "implement",
        {
          key: "implement",
          title: "Implement",
          description: "Write the code",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
          status: "pending",
        },
      ],
    ]),
    changes: new Map(),
    completions: [],
    dynamicSaveCalls: 0,
    evaluations: 0,
  };
}

const monotonic = (current: string, next: string): string =>
  current === "completed" ? "completed" : next;

/** Fresh runner deps over the shared store = one worker generation. */
function createGenerationDeps(store: Store, workspacePath: string) {
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "Recovery test",
    command: "Recovery test",
    status: "running",
    replanCount: 0,
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath,
    approvalMode: "auto" as const,
  };
  const snapshotRows = (): WorkerSubtask[] =>
    [...store.rows.values()].map(
      (row, index) =>
        ({
          _id: `sub-${index}`,
          taskId: task._id,
          projectId: project._id,
          key: row.key,
          title: row.title,
          description: row.description,
          kind: row.kind,
          capability: row.capability,
          dependencies: row.dependencies,
          order: row.order,
          status: row.status,
          output: row.output,
          attempts: 0,
        }) as unknown as WorkerSubtask
    );
  const api = {
    getContext: async () => ({
      task,
      project,
      agents: AGENTS,
      plan: {
        _id: "plan-1",
        taskId: task._id,
        version: store.planVersion,
        strategy: store.planPayload.strategy,
        createdBy: "orchestrator" as const,
        goal: store.planPayload.goal,
        payload: store.planPayload,
        createdAt: 0,
      },
      subtasks: snapshotRows(),
      approvalMode: "auto" as const,
    }),
    logEvent: async () => undefined,
    startExecution: async (input: { subtaskKey: string }) => {
      const row = store.rows.get(input.subtaskKey);
      if (row) row.status = monotonic(row.status, "running");
      return "exec-1";
    },
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
    }) => {
      if (!input.subtaskKey) return;
      const row = store.rows.get(input.subtaskKey);
      if (!row) return;
      row.status = monotonic(row.status, input.status);
      if (input.output) row.output = input.output;
    },
    updateSubtask: async (input: {
      key: string;
      status: string;
      output?: string;
    }) => {
      const row = store.rows.get(input.key);
      if (!row) return false;
      row.status = monotonic(row.status, input.status);
      if (input.output) row.output = input.output;
      return true;
    },
    saveFileChange: async (change: {
      filePath: string;
      changeType: "new" | "modified" | "deleted";
      newContent?: string;
      diff: string;
    }) => {
      store.changes.set(change.filePath, {
        _id: `change-${store.changes.size + 1}`,
        taskId: task._id,
        ...change,
        diff: change.diff ?? "",
      } as WorkerFileChange);
      return `change-${store.changes.size}`;
    },
    markFilesApplied: async (input: {
      taskId: string;
      filePaths: string[];
    }) => {
      const now = Date.now();
      for (const filePath of input.filePaths) {
        const change = store.changes.get(filePath);
        if (change) change.appliedAt = now;
      }
    },
    getFileChanges: async () => [...store.changes.values()],
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => {
      store.evaluations += 1;
    },
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
    // Mirrors the real saveDynamicSubtasks mutation: insert-only rows
    // keyed by (taskId, key); payload merged by key, same version only.
    saveDynamicSubtasks: async (input: {
      version: number;
      payload: ExecutionPlan;
      subtasks: Array<PlanSubtask & { origin?: string }>;
    }) => {
      store.dynamicSaveCalls += 1;
      const inserted: string[] = [];
      const existing: string[] = [];
      for (const subtask of input.subtasks) {
        if (store.rows.has(subtask.key)) {
          existing.push(subtask.key);
          continue;
        }
        store.rows.set(subtask.key, {
          key: subtask.key,
          title: subtask.title,
          description: subtask.description,
          kind: subtask.kind,
          capability: subtask.capability,
          dependencies: subtask.dependencies,
          order: subtask.order,
          status: "pending",
          origin: subtask.origin,
        });
        inserted.push(subtask.key);
      }
      let payloadUpdated = false;
      if (input.version === store.planVersion) {
        const known = new Set(
          store.planPayload.subtasks.map((s) => s.key)
        );
        const merged = [...store.planPayload.subtasks];
        for (const subtask of input.payload.subtasks) {
          if (!known.has(subtask.key)) {
            merged.push(subtask);
            known.add(subtask.key);
          }
        }
        if (merged.length !== store.planPayload.subtasks.length) {
          store.planPayload = { ...store.planPayload, subtasks: merged };
          payloadUpdated = true;
        }
      }
      return { inserted, existing, payloadUpdated };
    },
  };
  return {
    deps: {
      api: withApiDefaults(api) as unknown as WorkerApi,
      workerId: "test-worker",
      policy: POLICY,
      workspaceRoot: workspacePath,
      log: () => undefined,
    },
    task: task as unknown as WorkerTask,
  };
}

/** Mirrors orchestration.recoverStale's subtask step. */
function simulateStaleRecovery(store: Store): void {
  for (const row of store.rows.values()) {
    if (row.status === "running") row.status = "pending";
  }
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-p4h-rec-"));
  mockState.executed = [];
  mockState.hangKeys = new Set();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("durable dynamic DAG recovery (mandatory tests 8-10)", () => {
  it(
    "tests 8+9+10: dynamic delegation survives a worker restart; completed nodes are not re-executed; the pending dynamic node resumes",
    async () => {
      const store = seedStore(workspace);

      // --- Generation 1: implement completes and delegates; the
      // audit node starts and the worker "dies" mid-flight.
      mockState.hangKeys = new Set([DELEGATE_KEY]);
      const gen1 = createGenerationDeps(store, workspace);
      const gen1Run = processTask(gen1.task, gen1.deps);
      gen1Run.catch(() => undefined); // abandoned, never awaited

      // Wait until the delegation is DURABLY persisted: the dynamic
      // row exists and the stored plan payload contains the node.
      await vi.waitFor(
        () => {
          expect(store.rows.has(DELEGATE_KEY)).toBe(true);
          expect(
            store.planPayload.subtasks.some((s) => s.key === DELEGATE_KEY)
          ).toBe(true);
          expect(mockState.executed).toContain(DELEGATE_KEY);
        },
        { timeout: 5_000, interval: 20 }
      );
      expect(store.dynamicSaveCalls).toBeGreaterThanOrEqual(1);
      const delegateRow = store.rows.get(DELEGATE_KEY)!;
      expect(delegateRow.origin).toBe("delegation");
      expect(delegateRow.dependencies).toEqual(["implement"]);
      expect(delegateRow.capability).toBe("security-audit");
      expect(store.rows.get("implement")?.status).toBe("completed");
      // The dead worker left the delegate row running.
      expect(delegateRow.status).toBe("running");
      expect(store.completions).toHaveLength(0);

      // --- Stale recovery (backend step): running rows go back to
      // pending; the task is requeued for the next worker.
      simulateStaleRecovery(store);
      expect(store.rows.get(DELEGATE_KEY)?.status).toBe("pending");

      // --- Generation 2 (simulated restart): fresh runner, same
      // store. Test 8: the dynamic node is recovered from persistence.
      // Test 10: the pending dynamic node is continued and completes.
      // Test 9 (part 1): the completed static node is NOT re-executed.
      mockState.executed = [];
      mockState.hangKeys = new Set();
      const gen2 = createGenerationDeps(store, workspace);
      await processTask(gen2.task, gen2.deps);

      expect(mockState.executed).toEqual([DELEGATE_KEY]);
      expect(store.rows.get(DELEGATE_KEY)?.status).toBe("completed");
      expect(store.rows.get(DELEGATE_KEY)?.output).toBe(
        `${DELEGATE_KEY} output`
      );
      expect(store.completions).toHaveLength(1);
      expect(store.completions[0].status).toBe("done");

      // --- Generation 3 (another restart): test 9 (part 2) — the
      // completed DYNAMIC node is not re-executed either; nothing
      // runs at all, and the task completes from the checkpoint.
      mockState.executed = [];
      const gen3 = createGenerationDeps(store, workspace);
      await processTask(gen3.task, gen3.deps);
      expect(mockState.executed).toEqual([]);
      expect(store.completions).toHaveLength(2);
      expect(store.completions[1].status).toBe("done");
    },
    20_000
  );
});
