/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const PLAN = {
  version: 1,
  goal: "Add a dark mode toggle",
  strategy: "dag",
  requiresApproval: true,
  maxConcurrency: 2,
  visualQa: true,
  subtasks: [
    { key: "api", title: "Theme setting API", description: "Store the theme", kind: "code_change", capability: "backend-development", dependencies: [], order: 0, allowedPaths: ["apps/api"] },
    { key: "ui", title: "Toggle component", description: "Build it", kind: "code_change", capability: "frontend-development", dependencies: ["api"], order: 1, allowedPaths: ["apps/web/components", "apps/web/app/layout.tsx"] },
    { key: "review", title: "Review", description: "Review the diff", kind: "review", capability: "code-review", dependencies: ["ui"], order: 2 },
  ],
};

async function setup(options: { estimate?: unknown } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const agentIds: Id<"agents">[] = [];
    for (const role of ["cto", "frontend", "backend", "reviewer"]) {
      agentIds.push(await ctx.db.insert("agents", { name: role.toUpperCase(), role, status: "idle", isEnabled: true }));
    }
    // A disabled QA agent: not a valid reassignment target.
    agentIds.push(await ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle", isEnabled: false }));
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds, planReview: "always" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Dark mode",
      command: "add a dark mode toggle",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    return { projectId, taskId };
  });
  // The worker's savePlan (lease held by w1).
  await t.mutation(internal.orchestration.savePlan, {
    taskId: ids.taskId,
    projectId: ids.projectId,
    version: 1,
    strategy: "dag",
    createdBy: "orchestrator",
    goal: PLAN.goal,
    payload: PLAN,
    subtasks: PLAN.subtasks as never,
    workerId: "w1",
    ...(options.estimate ? { estimate: options.estimate } : {}),
  });
  return { t, ...ids };
}

async function openReview(t: ReturnType<typeof convexTest>, taskId: Id<"tasks">, projectId: Id<"projects">) {
  const result = await t.mutation(internal.planReview.requestReview, { taskId, projectId, planVersion: 1, workerId: "w1" });
  expect(result.applied).toBe(true);
  return (result as { approvalId: Id<"approvals"> }).approvalId;
}

describe("plan review: pause and resume", () => {
  test("requestReview pauses the task at waiting_plan_approval with a plan approval and one Plan card", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    // Idempotent: a second request returns the same pending approval and no second card.
    const again = await t.mutation(internal.planReview.requestReview, { taskId, projectId, planVersion: 1 });
    expect((again as { approvalId: string }).approvalId).toBe(approvalId);

    const state = await t.run(async (ctx) => ({
      task: await ctx.db.get(taskId),
      approvals: await ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
      cards: (await ctx.db.query("messages").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect()).filter((m) => m.card?.kind === "plan"),
      events: await ctx.db.query("taskEvents").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
    }));
    expect(state.task?.status).toBe("needs_approval");
    expect(state.task?.workerId).toBeUndefined();
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({ kind: "plan", status: "pending", planVersion: 1 });
    expect(state.cards).toHaveLength(1);
    expect(
      state.events.some((e) => e.type === "task.stage" && (e.payload as { stage?: string }).stage === "waiting_plan_approval")
    ).toBe(true);
  });

  test("a displaced worker cannot open a review", async () => {
    const { t, taskId, projectId } = await setup();
    const result = await t.mutation(internal.planReview.requestReview, { taskId, projectId, planVersion: 1, workerId: "w2" });
    expect(result).toMatchObject({ applied: false, reason: "lease_lost" });
  });

  test("approve re-queues the task for the next worker claim", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    await t.mutation(api.approvals.approve, { approvalId });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("queued");
    expect(task?.workerId).toBeUndefined();
    const review = await t.query(api.planReview.forTask, { taskId });
    expect(review?.approval?.status).toBe("approved");
  });

  test("reject ends the task as rejected and skips its pending subtasks", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    await t.mutation(api.approvals.reject, { approvalId });
    const { task, subtasks } = await t.run(async (ctx) => ({
      task: await ctx.db.get(taskId),
      subtasks: await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
    }));
    expect(task?.status).toBe("rejected");
    expect(task?.errorMessage).toMatch(/Plan rejected/);
    expect(subtasks.every((s) => s.status === "skipped")).toBe(true);
  });

  test("approving a superseded version is refused", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    // A newer plan version lands (e.g. a replan) without the old approval being closed.
    await t.run(async (ctx) => {
      const plan = (await ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect())[0];
      await ctx.db.patch(plan._id, { version: 2 });
    });
    await expect(t.mutation(api.approvals.approve, { approvalId })).rejects.toThrow(/replaced/);
    const approval = await t.run((ctx) => ctx.db.get(approvalId));
    expect(approval?.status).toBe("pending"); // the throw rolled the approve back
  });
});

describe("plan review: edits", () => {
  test("an edit writes a validated user version under a fresh approval and keeps plan-level fields", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    const result = await t.mutation(api.planReview.editPlan, {
      approvalId,
      ops: [
        { op: "update", key: "ui", title: "Theme toggle in the header", description: "Render it in layout.tsx" },
        { op: "reassign", key: "review", role: "cto" },
        { op: "remove", key: "api", dependents: "relink" },
      ],
    });
    expect(result).toMatchObject({ ok: true, version: 2 });

    const state = await t.run(async (ctx) => ({
      plans: await ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
      approvals: await ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
      subtasks: await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
      task: await ctx.db.get(taskId),
    }));
    expect(state.plans).toHaveLength(1);
    const plan = state.plans[0];
    expect(plan.version).toBe(2);
    expect(plan.createdBy).toBe("user");
    const payload = plan.payload as typeof PLAN;
    expect(payload.visualQa).toBe(true);
    expect(payload.subtasks.map((s) => s.key)).toEqual(["ui", "review"]);
    expect(payload.subtasks[0]).toMatchObject({ title: "Theme toggle in the header", dependencies: [], order: 0 });
    expect(payload.subtasks[1]).toMatchObject({ capability: "architecture", kind: "analysis" });
    expect(state.subtasks.map((s) => s.key).sort()).toEqual(["review", "ui"]);
    // Old approval superseded, a new pending one for v2; task still waits.
    const byVersion = Object.fromEntries(state.approvals.map((a) => [a.planVersion, a.status]));
    expect(byVersion).toEqual({ 1: "cancelled", 2: "pending" });
    expect(state.task?.status).toBe("needs_approval");
    expect(plan.estimate).toMatchObject({ version: 1, subtaskCount: 2 });
  });

  test("invalid edits are refused as a whole and nothing changes", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    const cases = [
      [{ op: "update" as const, key: "ui", title: "   " }],
      [{ op: "reassign" as const, key: "ui", role: "qa" }], // QA agent is disabled
      [{ op: "reassign" as const, key: "ui", role: "growth" }],
      [{ op: "remove" as const, key: "api", dependents: "reject" as const }], // ui depends on it
      [{ op: "remove" as const, key: "api" }, { op: "remove" as const, key: "ui" }, { op: "remove" as const, key: "review" }],
      [{ op: "update" as const, key: "nope", title: "x" }],
    ];
    for (const ops of cases) {
      const result = await t.mutation(api.planReview.editPlan, { approvalId, ops });
      expect(result.ok, JSON.stringify(ops)).toBe(false);
      expect((result as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
    const state = await t.run(async (ctx) => ({
      plan: (await ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect())[0],
      approval: await ctx.db.get(approvalId),
    }));
    expect(state.plan.version).toBe(1);
    expect(state.approval?.status).toBe("pending");
  });

  test("Replan with note re-queues with the note; the next planner version clears it", async () => {
    const { t, taskId, projectId } = await setup();
    const approvalId = await openReview(t, taskId, projectId);
    expect(await t.mutation(api.planReview.replanWithNote, { approvalId, note: "  " })).toMatchObject({ ok: false });
    await t.mutation(api.planReview.replanWithNote, { approvalId, note: "Skip the API change, the setting exists" });
    let task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ status: "queued", planReviewNote: "Skip the API change, the setting exists" });
    expect((await t.run((ctx) => ctx.db.get(approvalId)))?.status).toBe("cancelled");

    await t.mutation(internal.orchestration.savePlan, {
      taskId,
      projectId,
      version: 2,
      strategy: "single",
      createdBy: "orchestrator",
      goal: PLAN.goal,
      payload: { ...PLAN, subtasks: [PLAN.subtasks[1]] },
      subtasks: [{ ...PLAN.subtasks[1], dependencies: [] }] as never,
    });
    task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.planReviewNote).toBeUndefined();
  });

  test("a replan without an estimate carries the first estimate forward", async () => {
    const estimate = { version: 1, subtaskCount: 3, tokens: { input: 1, output: 1, total: 2 } };
    const { t, taskId, projectId } = await setup({ estimate });
    await t.mutation(internal.orchestration.savePlan, {
      taskId,
      projectId,
      version: 2,
      strategy: "dag",
      createdBy: "orchestrator",
      goal: PLAN.goal,
      payload: PLAN,
      subtasks: PLAN.subtasks as never,
      workerId: "w1",
    });
    const plan = (await t.run((ctx) => ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect()))[0];
    expect(plan.estimate).toMatchObject({ subtaskCount: 3, carriedOver: true });
  });
});

describe("plan review: project setting", () => {
  test("setProjectPlanReview stores the setting", async () => {
    const { t, projectId } = await setup();
    await t.mutation(api.planReview.setProjectPlanReview, { projectId, planReview: "medium_plus" });
    expect(await t.query(api.planReview.getProjectPlanReview, { projectId })).toBe("medium_plus");
  });
});
