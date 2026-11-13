/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { holdsTaskLease } from "./orchestration";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "signals-test-token";

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

/** A task parked in needs_approval (no lease) with one pending apply_changes approval. */
async function parked() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p" });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "needs_approval" });
    const approvalId = await ctx.db.insert("approvals", {
      taskId,
      projectId,
      kind: "apply_changes",
      summary: "Apply 1 file",
      status: "pending",
    });
    return { projectId, taskId, approvalId };
  });
  return { t, ...ids };
}

async function signals(t: T, taskId: Id<"tasks">) {
  return await t.run((ctx) =>
    ctx.db
      .query("taskSignals")
      .withIndex("by_task_and_consumed", (q) => q.eq("taskId", taskId))
      .collect()
  );
}

describe("approval signals (apply_changes park)", () => {
  test("approve records a signal and makes the task resumable in the same mutation", async () => {
    const { t, taskId, approvalId } = await parked();
    expect(await t.query(internal.orchestration.getResumableTasks, {})).toHaveLength(0);
    await t.mutation(api.approvals.approve, { approvalId });
    const rows = await signals(t, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "approval", decision: "approved", approvalId });
    expect(rows[0].consumedAt).toBeUndefined();
    const resumable = await t.query(internal.orchestration.getResumableTasks, {});
    expect(resumable.map((r) => r.task._id)).toEqual([taskId]);
    expect(resumable[0].approvals[0]).toMatchObject({ kind: "apply_changes", status: "approved" });
  });

  test("reject records a rejected signal; the resume claim consumes it", async () => {
    const { t, taskId, approvalId } = await parked();
    await t.mutation(api.approvals.reject, { approvalId });
    expect((await signals(t, taskId))[0]).toMatchObject({ decision: "rejected" });
    const claimed = await t.mutation(internal.orchestration.claimResumableTask, { taskId, workerId: "w1", leaseMs: 60_000 });
    expect(claimed?.workerId).toBe("w1");
    expect((await signals(t, taskId))[0].consumedBy).toBe("w1");
    expect(await t.query(internal.orchestration.getResumableTasks, {})).toHaveLength(0);
  });

  test("pause while waiting on approval only records the pause; resume releases it", async () => {
    const { t, taskId, approvalId } = await parked();
    const paused = await t.mutation(api.taskControl.pause, { taskId });
    expect(paused).toMatchObject({ paused: true, changed: true });
    let task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ status: "needs_approval", pausedBy: "user" });
    // The approval is still actionable and still signals.
    await t.mutation(api.approvals.approve, { approvalId });
    expect(await signals(t, taskId)).toHaveLength(1);
    // ...but the paused task is not resumed.
    expect(await t.query(internal.orchestration.getResumableTasks, {})).toHaveLength(0);
    expect(await t.mutation(internal.orchestration.claimResumableTask, { taskId, workerId: "w1" })).toBeNull();
    const resumed = await t.mutation(api.taskControl.resume, { taskId });
    expect(resumed).toMatchObject({ resumed: true, status: "needs_approval" });
    task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.pausedBy).toBeUndefined();
    expect((await t.query(internal.orchestration.getResumableTasks, {})).map((r) => r.task._id)).toEqual([taskId]);
  });

  test("a pause recorded during the park drains as paused when the resumed run starts", async () => {
    const { t, taskId, approvalId } = await parked();
    // The resumed run holds the resume lease (plan 049: setTaskStatus is fenced to it).
    await t.mutation(api.approvals.approve, { approvalId });
    await t.mutation(internal.orchestration.claimResumableTask, { taskId, workerId: "w1", leaseMs: 60_000 });
    await t.mutation(api.taskControl.pause, { taskId });
    await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "running", workerId: "w1" });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("paused");
  });

  test("a dead resume claim is released and re-signalled by recovery", async () => {
    const { t, taskId, approvalId } = await parked();
    await t.mutation(api.approvals.approve, { approvalId });
    await t.mutation(internal.orchestration.claimResumableTask, { taskId, workerId: "w1", leaseMs: 60_000 });
    expect(await t.query(internal.orchestration.getResumableTasks, {})).toHaveLength(0);
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1_000 }));
    await t.mutation(internal.orchestration.recoverStale, {});
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("needs_approval");
    expect(task?.workerId).toBeUndefined();
    expect((await t.query(internal.orchestration.getResumableTasks, {})).map((r) => r.task._id)).toEqual([taskId]);
  });

  test("backfill creates a signal for a pre-signal resolved approval, once", async () => {
    const { t, taskId, approvalId } = await parked();
    await t.run((ctx) => ctx.db.patch(approvalId, { status: "approved", resolvedAt: 5 }));
    expect(await t.mutation(internal.taskSignals.backfillParkedApprovals, {})).toEqual({ created: 1 });
    expect(await t.mutation(internal.taskSignals.backfillParkedApprovals, {})).toEqual({ created: 0 });
    expect((await t.query(internal.orchestration.getResumableTasks, {})).map((r) => r.task._id)).toEqual([taskId]);
  });
});

describe("command signals (run_command in-process wait)", () => {
  async function running() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p" });
      const taskId = await ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "c",
        status: "running",
        workerId: "w1",
        leaseExpiresAt: Date.now() + 60_000,
        permissionMode: "supervised",
      });
      return { projectId, taskId };
    });
    const request = (workerId = "w1") =>
      t.mutation(internal.commandApprovals.request, {
        projectId: ids.projectId,
        taskId: ids.taskId,
        command: "npm",
        args: ["run", "test"],
        workspaceRoot: "/ws/p",
        workerId,
        subtaskKey: "s1",
      });
    return { t, ...ids, request };
  }

  test("approve records a command signal; ack consumes it", async () => {
    const { t, taskId, request } = await running();
    const asked = await request();
    expect(asked.status).toBe("pending");
    await t.mutation(api.approvals.approve, { approvalId: asked.approvalId });
    const [signal] = await signals(t, taskId);
    expect(signal).toMatchObject({ name: "command", decision: "approved", command: "npm run test", subtaskKey: "s1" });
    expect(await t.mutation(internal.commandApprovals.ack, { approvalId: asked.approvalId, workerId: "w1" })).toEqual({ consumed: 1 });
    // One-time: after the waiter consumed it, a new request asks again.
    expect((await request()).status).toBe("pending");
  });

  test("a replay after the worker died reuses the user's unconsumed allow", async () => {
    const { t, taskId, request } = await running();
    const asked = await request();
    await t.mutation(api.commandApprovals.respond, { approvalId: asked.approvalId, decision: "allow" });
    // Worker died before reading it; another worker owns the replay.
    await t.run((ctx) => ctx.db.patch(taskId, { workerId: "w2", leaseExpiresAt: Date.now() + 60_000 }));
    const replay = await request("w2");
    expect(replay).toMatchObject({ status: "auto", approvalId: asked.approvalId });
    expect((await signals(t, taskId))[0].consumedBy).toBe("w2");
  });

  test("a replay before the user decided adopts the orphaned pending card", async () => {
    const { t, taskId, request } = await running();
    const asked = await request();
    await t.run((ctx) => ctx.db.patch(taskId, { workerId: "w2", leaseExpiresAt: Date.now() + 60_000 }));
    const replay = await request("w2");
    expect(replay).toMatchObject({ status: "pending", approvalId: asked.approvalId });
    const pending = await t.run((ctx) =>
      ctx.db
        .query("approvals")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .collect()
    );
    expect(pending).toHaveLength(1);
  });

  test("lease recovery cancels the dead waiter's pending card; the re-run shows exactly one", async () => {
    const { t, taskId, request } = await running();
    // A plan + subtask rows so recovery requeues (not fails) the task.
    await t.run(async (ctx) => {
      const task = (await ctx.db.get(taskId))!;
      await ctx.db.insert("plans", { taskId, projectId: task.projectId, version: 1, strategy: "s", createdBy: "orchestrator", goal: "g", createdAt: Date.now(), payload: { subtasks: [{ key: "s1" }] } } as never);
      await ctx.db.insert("subtasks", { taskId, projectId: task.projectId, key: "s1", title: "s1", description: "", kind: "analysis", capability: "c", dependencies: [], order: 0, status: "running", attempts: 1 } as never);
    });
    const first = await request();
    expect(first.status).toBe("pending");
    // Worker dies: lease lapses, recovery (cron) requeues.
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1_000 }));
    await t.mutation(internal.orchestration.recoverStale, {});
    expect((await t.run((ctx) => ctx.db.get(first.approvalId)))?.status).toBe("cancelled");
    // Re-claimed by a new worker; the re-run asks again.
    await t.mutation(internal.orchestration.claimNextTask, { workerId: "w2" });
    const second = await request("w2");
    expect(second.status).toBe("pending");
    const pending = await t.query(api.approvals.listPendingAll, {});
    expect(pending.filter((a) => a.taskId === taskId)).toHaveLength(1);
  });

  test("a re-run asking a different command supersedes the subtask's older pending card", async () => {
    const { t, taskId, projectId, request } = await running();
    const first = await request();
    await t.run((ctx) => ctx.db.patch(taskId, { workerId: "w2", leaseExpiresAt: Date.now() + 60_000 }));
    const second = await t.mutation(internal.commandApprovals.request, {
      projectId, taskId, command: "npx", args: ["vitest", "run"], workspaceRoot: "/ws/p", workerId: "w2", subtaskKey: "s1",
    });
    expect(second.status).toBe("pending");
    expect(second.approvalId).not.toBe(first.approvalId);
    expect((await t.run((ctx) => ctx.db.get(first.approvalId)))?.status).toBe("cancelled");
    const pending = await t.query(api.approvals.listPendingAll, {});
    expect(pending.filter((a) => a.taskId === taskId).map((a) => a._id)).toEqual([second.approvalId]);
  });

  test("parallel subtasks keep their own pending cards", async () => {
    const { t, taskId, projectId, request } = await running();
    await request();
    await t.mutation(internal.commandApprovals.request, {
      projectId, taskId, command: "npm", args: ["run", "lint"], workspaceRoot: "/ws/p", workerId: "w1", subtaskKey: "s2",
    });
    const pending = await t.query(api.approvals.listPendingAll, {});
    expect(pending.filter((a) => a.taskId === taskId)).toHaveLength(2);
  });

  test("pausing a running task whose command waits keeps the approval pending", async () => {
    const { t, taskId, request } = await running();
    const asked = await request();
    await t.mutation(api.taskControl.pause, { taskId });
    const row = await t.query(internal.commandApprovals.get, { approvalId: asked.approvalId });
    expect(row).toMatchObject({ status: "pending", taskStatus: "paused" });
    // The draining worker keeps its lease and can still write.
    const ok = await t.run((ctx) => holdsTaskLease(ctx, taskId, "w1"));
    expect(ok).toBe(true);
  });
});

describe("strict lease fencing", () => {
  async function owned(leaseExpiresAt: number) {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p" });
      return await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "running", workerId: "w1", leaseExpiresAt });
    });
    return { t, taskId };
  }

  test("the live owner may write", async () => {
    const { t, taskId } = await owned(Date.now() + 60_000);
    expect(await t.run((ctx) => holdsTaskLease(ctx, taskId, "w1"))).toBe(true);
  });

  test("a write with no workerId is refused", async () => {
    const { t, taskId } = await owned(Date.now() + 60_000);
    expect(await t.run((ctx) => holdsTaskLease(ctx, taskId, undefined))).toBe(false);
    expect(await t.mutation(internal.orchestration.setSubtaskActivity, { taskId, key: "a", activity: "x" })).toBe(false);
  });

  test("a write from a lapsed lease is refused, even the owner's", async () => {
    const { t, taskId } = await owned(Date.now() - 1);
    expect(await t.run((ctx) => holdsTaskLease(ctx, taskId, "w1"))).toBe(false);
    expect(await t.run((ctx) => holdsTaskLease(ctx, taskId, "w2"))).toBe(false);
  });

  test("a displaced writer is refused while the new owner's lease is live", async () => {
    const { t, taskId } = await owned(Date.now() + 60_000);
    expect(await t.run((ctx) => holdsTaskLease(ctx, taskId, "w2"))).toBe(false);
  });

  test("heartbeat reports tasks the worker lost", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p" });
      const mine = await ctx.db.insert("tasks", { projectId, title: "a", command: "c", status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
      const stolen = await ctx.db.insert("tasks", { projectId, title: "b", command: "c", status: "running", workerId: "w2", leaseExpiresAt: Date.now() + 60_000 });
      const requeued = await ctx.db.insert("tasks", { projectId, title: "c", command: "c", status: "queued" });
      const parkedTask = await ctx.db.insert("tasks", { projectId, title: "d", command: "c", status: "needs_approval" });
      return { mine, stolen, requeued, parkedTask };
    });
    const res = await t.mutation(internal.orchestration.heartbeat, {
      workerId: "w1",
      capacity: 1,
      activeTasks: 4,
      activeTaskIds: [ids.mine, ids.stolen, ids.requeued, ids.parkedTask],
    });
    expect(res.lostTaskIds.sort()).toEqual([ids.stolen, ids.requeued].sort());
  });

  test("the cron entry point (recoverStale with no args) requeues an expired lease", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p" });
      return await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "running", workerId: "dead", leaseExpiresAt: Date.now() - 120_000 });
    });
    const res = await t.mutation(internal.orchestration.recoverStale, {});
    expect(res.recoveredTasks).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("queued");
  });
});

describe("worker.pendingWork (subscription wake-up)", () => {
  test("changes when work is queued or an approval is signalled", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const { t, taskId, approvalId, projectId } = await parked();
    await expect(t.query(api.worker.pendingWork, { workerToken: "nope" })).rejects.toThrow();
    const empty = await t.query(api.worker.pendingWork, { workerToken: SERVICE_TOKEN });
    expect(empty).toEqual({ queuedTaskId: null, resumeSignalId: null });
    await t.mutation(api.approvals.approve, { approvalId });
    const signalled = await t.query(api.worker.pendingWork, { workerToken: SERVICE_TOKEN });
    expect(signalled.resumeSignalId).not.toBeNull();
    const queuedId = await t.run((ctx) => ctx.db.insert("tasks", { projectId, title: "q", command: "c", status: "queued" }));
    const queued = await t.query(api.worker.pendingWork, { workerToken: SERVICE_TOKEN });
    expect(queued.queuedTaskId).toBe(queuedId);
    expect(taskId).toBeTruthy();
  });
});
