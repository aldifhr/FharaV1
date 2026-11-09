import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerAgent, WorkerTask } from "@/workerApi";
import { applyPlanEdits } from "@/api/convex/lib/planEdit";
import { validatePlan } from "@/orchestrator/planValidator";

/**
 * Plan Inspector, worker side: processTask pauses after plan.created when
 * the project's planReview setting applies, a re-claim after approval
 * adopts the stored (approved) plan and executes it, and "Replan with
 * note" plans afresh with the note as planner feedback. Plus: a user
 * edit produced by the backend's applyPlanEdits passes the worker's own
 * validator (the SAME shared rules).
 */

const mocks = vi.hoisted(() => ({
  createPlanCalls: [] as Array<{ feedback?: string }>,
  executed: [] as string[],
}));

const PLAN = {
  version: 1,
  goal: "Add a toggle",
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: [
    { key: "implement", title: "Implement", description: "Write the code", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
    { key: "review", title: "Review", description: "Review it", kind: "review", capability: "code-review", dependencies: ["implement"], order: 1 },
  ],
};

vi.mock("../src/orchestrator/planner", () => ({
  createPlan: async (input: { feedback?: string }) => {
    mocks.createPlanCalls.push({ feedback: input.feedback });
    return { plan: PLAN, createdBy: "llm", notes: [] };
  },
  heuristicPlan: () => PLAN,
  pickOrchestrator: () => null,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: { subtask: { key: string } }) => {
    mocks.executed.push(input.subtask.key);
    return { status: "completed", output: "done" };
  },
}));

import { processTask } from "@/services/taskRunner";
import { planReviewGate } from "@/services/runner/planReview";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

const AGENTS = [
  { _id: "agent-fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, priority: 0 },
  { _id: "agent-rv", name: "Reviewer", role: "reviewer", capabilities: ["code-review"], isEnabled: true, priority: 0 },
] as WorkerAgent[];

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-plan-review-"));
  mocks.createPlanCalls = [];
  mocks.executed = [];
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function harness(input: {
  planReview?: string;
  taskFields?: Record<string, unknown>;
  storedPlan?: { version: number; payload: unknown; createdBy: string } | null;
  approvals?: Array<{ kind: string; status: string; planVersion?: number }>;
  command?: string;
}) {
  const saved: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const task = testTask({ command: input.command ?? "Add a dark mode toggle to the header", ...(input.taskFields ?? {}) });
  const project = { _id: "project-1", name: "P", workspacePath: workspace, approvalMode: "auto" as const, planReview: input.planReview };
  const { api, completions } = createFakeApi({
    getContext: async () => ({
      task,
      project,
      agents: AGENTS,
      plan: input.storedPlan ?? null,
      subtasks: [],
      executions: [],
      approvalMode: "auto" as const,
    }),
    getApprovals: async () => input.approvals ?? [],
    savePlan: async (row: Record<string, unknown>) => {
      saved.push(row);
      return row.version;
    },
    requestPlanReview: async (row: Record<string, unknown>) => {
      reviews.push(row);
      return { applied: true, approvalId: "approval-plan" };
    },
    getEstimateSamples: async () => [],
    logEvent: async (e: { type: string; payload?: Record<string, unknown> }) => {
      events.push(e);
    },
    upsertTaskContext: async () => undefined,
    getTaskContext: async () => null,
    pauseForInput: async () => ({ applied: false, reason: "lease_lost" as const }),
  });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxReplans: 0,
    maxPlanningIterations: 0,
    maxReviewIterations: 1,
    maxConcurrentLLMCalls: 1,
    orchestratorAuthoritative: true,
    decisionLlmMode: "off",
    reviewMode: "never",
    qaMode: "never",
  } as never);
  return { deps: createRunnerDeps({ api, policy, workspaceRoot: workspace }), saved, reviews, events, completions, task: task as unknown as WorkerTask };
}

describe("plan review pause / resume (processTask)", () => {
  it("pauses after plan.created: plan saved with an estimate, review requested, nothing executed", async () => {
    const h = harness({ planReview: "always" });
    await processTask(h.task, h.deps);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].estimate).toMatchObject({ version: 1, subtaskCount: 2, agentCount: 2 });
    expect(h.reviews).toEqual([expect.objectContaining({ taskId: "task-1", planVersion: 1, reason: "always" })]);
    expect(mocks.executed).toEqual([]);
    expect(h.completions).toEqual([]);
  });

  it("resumes on re-claim: the approved stored plan is adopted (no new planner call) and executed", async () => {
    const h = harness({
      planReview: "always",
      storedPlan: { version: 1, payload: PLAN, createdBy: "orchestrator" },
      approvals: [{ kind: "plan", status: "approved", planVersion: 1 }],
    });
    await processTask(h.task, h.deps);
    expect(mocks.createPlanCalls).toHaveLength(0);
    expect(h.reviews).toHaveLength(0);
    expect(mocks.executed).toContain("implement");
  });

  it("an approval for an older version does not count: the new version is reviewed", async () => {
    const h = harness({
      planReview: "always",
      storedPlan: { version: 2, payload: PLAN, createdBy: "user" },
      approvals: [{ kind: "plan", status: "approved", planVersion: 1 }],
    });
    await processTask(h.task, h.deps);
    expect(h.reviews).toEqual([expect.objectContaining({ planVersion: 2 })]);
    expect(mocks.executed).toEqual([]);
  });

  it("Replan with note: the stored plan is discarded and the planner gets the note", async () => {
    const h = harness({
      planReview: "always",
      taskFields: { planReviewNote: "Keep it in one component" },
      storedPlan: { version: 1, payload: PLAN, createdBy: "orchestrator" },
    });
    await processTask(h.task, h.deps);
    expect(mocks.createPlanCalls).toEqual([{ feedback: "Keep it in one component" }]);
    expect(h.saved[0].version).toBe(2);
    expect(h.reviews).toEqual([expect.objectContaining({ planVersion: 2 })]);
  });

  it("setting off: runs straight through", async () => {
    const h = harness({});
    await processTask(h.task, h.deps);
    expect(h.reviews).toHaveLength(0);
    expect(mocks.executed).toContain("implement");
  });
});

describe("planReviewGate", () => {
  const classification = (complexity: string) => ({ kind: "change", strategy: "dag", reasons: [], complexity }) as never;
  const gate = async (opts: { setting?: string; complexity?: string; permissionMode?: string; executionStarted?: boolean; approvals?: unknown[] }) => {
    const h = harness({ planReview: opts.setting, approvals: opts.approvals as never });
    const result = await planReviewGate({
      deps: h.deps,
      task: { _id: "task-1", permissionMode: opts.permissionMode } as never,
      project: { _id: "project-1", planReview: opts.setting } as never,
      planVersion: 1,
      classification: classification(opts.complexity ?? "medium"),
      executionStarted: opts.executionStarted ?? false,
    });
    return { result, reviews: h.reviews, events: h.events };
  };

  it("medium_plus pauses medium+ and passes low", async () => {
    expect((await gate({ setting: "medium_plus", complexity: "medium" })).result).toBe("paused");
    expect((await gate({ setting: "medium_plus", complexity: "ultra" })).result).toBe("paused");
    expect((await gate({ setting: "medium_plus", complexity: "low" })).result).toBe("proceed");
  });

  it("Full access skips review unless the setting is always", async () => {
    const skipped = await gate({ setting: "medium_plus", complexity: "high", permissionMode: "full_access" });
    expect(skipped.result).toBe("proceed");
    expect(skipped.events.some((e) => e.type === "plan.review_skipped")).toBe(true);
    expect((await gate({ setting: "always", permissionMode: "full_access" })).result).toBe("paused");
  });

  it("never pauses a run whose execution already started", async () => {
    expect((await gate({ setting: "always", executionStarted: true })).result).toBe("proceed");
  });

  it("fails closed: a review that cannot be opened still stops the run", async () => {
    const h = harness({ planReview: "always" });
    (h.deps.api as unknown as Record<string, unknown>).requestPlanReview = async () => ({ applied: false, reason: "plan_version_mismatch" });
    const result = await planReviewGate({
      deps: h.deps,
      task: { _id: "task-1" } as never,
      project: { _id: "project-1", planReview: "always" } as never,
      planVersion: 1,
      classification: classification("low"),
      executionStarted: false,
    });
    expect(result).toBe("paused");
    expect(h.completions.at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("user plan edits pass the worker's validator", () => {
  it("applyPlanEdits output is accepted by validatePlan; an invalid edit is refused", () => {
    const edited = applyPlanEdits({
      plan: PLAN,
      ops: [
        { op: "update", key: "implement", title: "Implement the toggle" },
        { op: "reassign", key: "review", role: "qa" },
      ],
      enabledRoles: ["frontend", "reviewer", "qa"],
      maxSubtasks: 8,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const validated = validatePlan(edited.plan, 8);
    expect(validated.ok).toBe(true);
    expect(validated.plan?.subtasks[1]).toMatchObject({ capability: "browser-testing", kind: "qa" });

    const removedOnly = applyPlanEdits({ plan: PLAN, ops: [{ op: "remove", key: "implement" }], enabledRoles: [], maxSubtasks: 8 });
    expect(removedOnly.ok).toBe(true);
    if (removedOnly.ok) {
      expect((removedOnly.plan.subtasks as Array<{ key: string; dependencies: string[] }>)[0]).toMatchObject({ key: "review", dependencies: [] });
      expect(validatePlan(removedOnly.plan, 8).ok).toBe(true);
    }

    const bad = applyPlanEdits({ plan: PLAN, ops: [{ op: "reassign", key: "review", role: "qa" }], enabledRoles: ["frontend"], maxSubtasks: 8 });
    expect(bad).toMatchObject({ ok: false });
  });
});
