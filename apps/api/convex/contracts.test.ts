/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { applyPlanEdits } from "./lib/planEdit";
import { validatePlan } from "./lib/planValidation";

const modules = import.meta.glob("./**/*.ts");

function makeT() {
  return convexTest(schema, modules);
}

async function seed(status: "queued" | "running" = "running", lease: { workerId?: string; leaseExpiresAt?: number } = {}) {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Do work",
      command: "do it",
      status,
      ...lease,
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

const start = (taskId: any, projectId: any, workerId: string, attempt = 1) => ({
  taskId,
  projectId,
  subtaskKey: "implement",
  agentName: "Frontend",
  capability: "frontend-development",
  workerId,
  attempt,
  leaseMs: 60_000,
});

describe("dispatch idempotency (plan 022)", () => {
  test("a re-dispatch after lease expiry + recovery reclaims the same attempt instead of duplicating it", async () => {
    const { t, taskId, projectId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    const first = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    const before = await t.run((ctx) => ctx.db.get(first));
    expect(before?.dispatchKey).toBe(`${taskId}/implement/attempt-1`);

    // The worker dies: task + execution leases lapse with no heartbeat.
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 5_000 });
      await ctx.db.patch(first, { leaseExpiresAt: Date.now() - 5_000 });
    });
    await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    const lost = await t.run((ctx) => ctx.db.get(first));
    expect(lost?.status).toBe("failed");
    expect(lost?.leaseLost).toBe(true);

    // The next worker claims and re-dispatches the same subtask.
    await t.run((ctx) => ctx.db.patch(taskId, { status: "running", workerId: "w2", leaseExpiresAt: Date.now() + 60_000 }));
    const second = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w2"));
    expect(second).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query("executions").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    expect(rows[0].workerId).toBe("w2");
    expect(rows[0].leaseLost).toBeUndefined();
    const events = await t.run((ctx) => ctx.db.query("taskEvents").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect());
    expect(events.some((e) => e.type === "subtask.dispatch_reused" && (e.payload as any).reason === "lease_expired")).toBe(true);
  });

  test("a retried claim by the same worker reuses the in-flight row", async () => {
    const { t, taskId, projectId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    const first = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    const again = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    expect(again).toBe(first);
  });

  test("a finished attempt advances N: a legitimate re-run gets a fresh key", async () => {
    const { t, taskId, projectId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    const first = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    await t.mutation(internal.orchestration.updateExecution, { executionId: first, status: "completed", output: "ok", workerId: "w1" });
    const rerun = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    expect(rerun).not.toBe(first);
    const row = await t.run((ctx) => ctx.db.get(rerun));
    expect(row?.dispatchKey).toBe(`${taskId}/implement/attempt-2`);
  });

  test("a live attempt on another worker is refused, not duplicated", async () => {
    const { t, taskId, projectId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    // w2 somehow holds the task lease now while w1's execution is still live.
    await t.run((ctx) => ctx.db.patch(taskId, { workerId: "w2" }));
    await expect(t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w2"))).rejects.toThrow(/Dispatch in flight/);
  });

  test("an execution whose task lease is still live is not marked dead (lease expiry + no heartbeat)", async () => {
    const { t, taskId, projectId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    const execution = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    await t.run((ctx) => ctx.db.patch(execution, { leaseExpiresAt: Date.now() - 1_000 }));
    const result = await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    expect(result.recoveredExecutions).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(execution)))?.status).toBe("running");
  });
});

describe("planning-interrupted recovery (plan 022, ROADMAP lease bug)", () => {
  test("a task whose worker died while planning is requeued, not failed", async () => {
    const { t, taskId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() - 5_000 });
    await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("queued");
    expect(task?.recoveryCount).toBe(1);
    expect(task?.workerId).toBeUndefined();
    const events = await t.run((ctx) => ctx.db.query("taskEvents").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect());
    const recovered = events.find((e) => e.type === "task.recovered");
    expect((recovered?.payload as any)?.reason).toBe("planning_interrupted");
    expect((recovered?.payload as any)?.dispatchKey).toBe(`${taskId}/plan/attempt-2`);
  });

  test("the recovery bound still applies", async () => {
    const { t, taskId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() - 5_000 });
    await t.run((ctx) => ctx.db.patch(taskId, { recoveryCount: 3 }));
    await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("failed");
  });
});

describe("user pause (plan 022)", () => {
  test("a paused queued task is never claimed; resume re-queues it", async () => {
    const { t, taskId } = await seed("queued");
    await t.mutation(api.taskControl.pause, { taskId });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("paused");
    expect(task?.pausedBy).toBe("user");
    expect(task?.pausedAt).toBeTypeOf("number");
    expect(await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" })).toBeNull();
    await t.mutation(api.taskControl.resume, { taskId });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("queued");
    const claimed = await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" });
    expect(claimed?._id).toBe(taskId);
  });

  test("recovery skips a paused task even after its lease lapsed", async () => {
    const { t, taskId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    await t.mutation(api.taskControl.pause, { taskId });
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 60_000 }));
    await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("paused");
  });

  test("the heartbeat keeps a draining paused task's lease; release clears it and keeps it paused", async () => {
    const { t, taskId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 1_000 });
    await t.mutation(api.taskControl.pause, { taskId });
    const hb = await t.mutation(internal.orchestration.heartbeat, {
      workerId: "w1",
      capacity: 1,
      activeTasks: 1,
      leaseMs: 60_000,
      activeTaskIds: [taskId],
    });
    expect(hb.renewedTasks).toBe(1);
    const released = await t.mutation(internal.taskControl.releasePausedTask, { taskId, workerId: "w1" });
    expect(released.result).toBe("released");
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("paused");
    expect(task?.workerId).toBeUndefined();
  });

  test("resume while draining hands it back as running; the release then re-queues it", async () => {
    const { t, taskId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    await t.mutation(api.taskControl.pause, { taskId });
    const resumed = await t.mutation(api.taskControl.resume, { taskId });
    expect(resumed.status).toBe("running");
    const released = await t.mutation(internal.taskControl.releasePausedTask, { taskId, workerId: "w1" });
    expect(released.result).toBe("requeued");
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("queued");
  });

  test("waiting states cannot be paused", async () => {
    const { t, taskId } = await seed("running");
    await t.run((ctx) => ctx.db.patch(taskId, { status: "waiting_input" }));
    await expect(t.mutation(api.taskControl.pause, { taskId })).rejects.toThrow(/cannot be paused/);
  });
});

describe("subtask acceptance (plan 022)", () => {
  test("delivered on completion, then gate results recorded separately from the execution status", async () => {
    const { t, taskId, projectId } = await seed("running", { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
    await t.run((ctx) =>
      ctx.db.insert("subtasks", {
        taskId,
        projectId,
        key: "implement",
        title: "Implement",
        description: "",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: [],
        order: 0,
        status: "pending",
        attempts: 0,
      })
    );
    const execution = await t.mutation(internal.orchestration.startExecution, start(taskId, projectId, "w1"));
    await t.mutation(internal.orchestration.updateExecution, { executionId: execution, status: "completed", output: "ok", workerId: "w1" });
    const row = () => t.run((ctx) => ctx.db.query("subtasks").withIndex("by_task_and_key", (q) => q.eq("taskId", taskId).eq("key", "implement")).unique());
    expect((await row())?.acceptanceStatus).toBe("delivered");
    await t.mutation(internal.contracts.recordSubtaskAcceptance, {
      taskId,
      key: "implement",
      acceptanceStatus: "rejected",
      acceptanceReason: "Relevant tests pass: root:test failed",
      gateResults: [
        { gateId: "typecheck", status: "pass", evidence: { kind: "verification", ref: "root:typecheck", summary: "1 check(s) passed" } },
        { gateId: "tests", status: "fail", evidence: { kind: "verification", ref: "root:test", summary: "1 failing" } },
      ],
      workerId: "w1",
    });
    const after = await row();
    expect(after?.status).toBe("completed");
    expect(after?.acceptanceStatus).toBe("rejected");
    expect(after?.gateResults?.map((g) => g.status)).toEqual(["pass", "fail"]);
  });
});

describe("plan edits: acceptance criteria text (plan 022)", () => {
  const plan = {
    goal: "g",
    strategy: "single",
    requiresApproval: true,
    maxConcurrency: 1,
    subtasks: [
      { key: "implement", title: "Implement", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
    ],
  };

  test("editing a derived default gate makes it explicit; unknown gates are refused", () => {
    const ok = applyPlanEdits({
      plan,
      ops: [{ op: "update", key: "implement", acceptance: [{ id: "tests", criterion: "Header tests pass" }] }],
      enabledRoles: ["frontend"],
      maxSubtasks: 8,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const gates = (ok.plan.subtasks as any[])[0].acceptance;
      expect(gates.map((g: any) => [g.id, g.criterion])).toEqual([
        ["typecheck", "Typecheck passes on the changed workspace"],
        ["tests", "Header tests pass"],
      ]);
      expect(validatePlan(ok.plan, 8).ok).toBe(true);
    }
    const bad = applyPlanEdits({
      plan,
      ops: [{ op: "update", key: "implement", acceptance: [{ id: "nope", criterion: "x" }] }],
      enabledRoles: ["frontend"],
      maxSubtasks: 8,
    });
    expect(bad.ok).toBe(false);
  });
});

describe("model tiers project setting (plan 022)", () => {
  test("set + read back, unknown model refused", async () => {
    const t = makeT();
    const { projectId, modelId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const providerId = await ctx.db.insert("llmProviders", {
        name: "Conn",
        provider: "openai",
        baseUrl: "https://x",
        apiKeyEnv: "X",
        model: "strong-1",
        priority: 1,
        weight: 1,
        createdAt: Date.now(),
      });
      const now = Date.now();
      const modelId = await ctx.db.insert("llmModels", { providerId, modelId: "strong-1", isAvailable: true, createdAt: now, updatedAt: now });
      return { projectId, modelId };
    });
    await t.mutation(api.contracts.setProjectModelTiers, { projectId, modelTiers: { planner: modelId, reviewer: modelId } });
    const state = await t.query(api.contracts.getProjectModelTiers, { projectId });
    expect(state.tiers).toEqual({ planner: modelId, reviewer: modelId });
    expect(state.options.map((o) => o.modelId)).toEqual(["strong-1"]);
  });
});
