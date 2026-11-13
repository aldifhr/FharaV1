/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Regression lane (regress-tests): claim atomicity, lease fencing and
 * claimNextTask head-of-line blocking.
 *
 *  - two workers racing for one queued task: exactly one wins;
 *  - a displaced (zombie) worker's completeTask and late writes are refused
 *    as values, the new owner's are applied;
 *  - setTaskStatus is fenced to the lease owner (B4, plan 049);
 *  - 25+ unclaimable rows (legacy direct threads) ahead of a valid task
 *    do not starve it (bug 10), and the migration
 *    closes the legacy direct rows idempotently.
 */

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function project(t: T): Promise<Id<"projects">> {
  return await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
}

async function queued(t: T, projectId: Id<"projects">, fields: Record<string, unknown> = {}): Promise<Id<"tasks">> {
  return (await t.run((ctx) =>
    ctx.db.insert("tasks", { projectId, title: "t", command: "do it", status: "queued", ...fields } as never)
  )) as Id<"tasks">;
}

const status = async (t: T, taskId: Id<"tasks">) => (await t.run((ctx) => ctx.db.get(taskId)))?.status;

describe("claimNextTask: two workers race for the same task", () => {
  test("exactly one wins; the other gets null", async () => {
    const t = convexTest(schema, modules);
    const taskId = await queued(t, await project(t));
    const [a, b] = await Promise.all([
      t.mutation(internal.orchestration.claimNextTask, { workerId: "w-a", leaseMs: 60_000 }),
      t.mutation(internal.orchestration.claimNextTask, { workerId: "w-b", leaseMs: 60_000 }),
    ]);
    const winners = [a, b].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?._id).toBe(taskId);
    const row = await t.run((ctx) => ctx.db.get(taskId));
    expect(row?.workerId).toBe(winners[0]?.workerId);
  });
});

/** A running task owned by w-old whose lease lapsed, requeued and re-claimed by w-new. */
async function displaced() {
  const t = convexTest(schema, modules);
  const projectId = await project(t);
  const taskId = await queued(t, projectId);
  await t.mutation(internal.orchestration.claimNextTask, { workerId: "w-old", leaseMs: 60_000 });
  await t.run((ctx) => ctx.db.patch(taskId, { status: "queued", workerId: undefined, leaseExpiresAt: undefined }));
  const claimed = await t.mutation(internal.orchestration.claimNextTask, { workerId: "w-new", leaseMs: 60_000 });
  expect(claimed?._id).toBe(taskId);
  return { t, projectId, taskId };
}

describe("lease fencing: a zombie worker's writes are refused", () => {
  test("completeTask from the displaced worker is refused; the owner's applies", async () => {
    const { t, taskId } = await displaced();
    const late = await t.mutation(internal.orchestration.completeTask, { taskId, status: "done", workerId: "w-old" });
    expect(late).toMatchObject({ applied: false, reason: "lease_lost" });
    expect(await status(t, taskId)).toBe("running");
    const owner = await t.mutation(internal.orchestration.completeTask, { taskId, status: "done", workerId: "w-new" });
    expect(owner).toMatchObject({ applied: true, status: "done" });
  });

  test("late subtask, plan and file writes from the displaced worker change nothing", async () => {
    const { t, projectId, taskId } = await displaced();
    expect(await t.mutation(internal.orchestration.updateSubtask, { taskId, key: "s1", status: "completed", workerId: "w-old" })).toBe(false);
    const savedChange = await t.mutation(internal.orchestration.saveFileChange, {
      taskId,
      projectId,
      filePath: "a.txt",
      changeType: "new",
      newContent: "zombie",
      diff: "+zombie",
      workerId: "w-old",
    });
    expect(savedChange).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("fileChanges").collect());
    expect(rows).toHaveLength(0);
  });

  test("a lapsed lease refuses even the old owner until it is renewed", async () => {
    const { t, taskId } = await displaced();
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1_000 }));
    const result = await t.mutation(internal.orchestration.completeTask, { taskId, status: "done", workerId: "w-new" });
    expect(result).toMatchObject({ applied: false, reason: "lease_lost" });
    expect(await status(t, taskId)).toBe("running");
  });
});

describe("setTaskStatus is fenced to the lease owner (B4, plan 049)", () => {
  test("a displaced worker and a write with no worker id are refused; the owner applies", async () => {
    const { t, taskId } = await displaced();
    expect(await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "needs_approval", workerId: "w-old" })).toBe(false);
    expect(await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "needs_approval" })).toBe(false);
    expect(await status(t, taskId)).toBe("running");
    expect(await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "needs_approval", workerId: "w-new" })).toBe(true);
    expect(await status(t, taskId)).toBe("needs_approval");
  });

  test("an expired lease is refused", async () => {
    const { t, taskId } = await displaced();
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1_000 }));
    expect(await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "paused", workerId: "w-new" })).toBe(false);
    expect(await status(t, taskId)).toBe("running");
  });

  test("a terminal task is never resurrected; the same terminal status stays an idempotent yes", async () => {
    const { t, taskId } = await displaced();
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: "boom", workerId: "w-new" });
    expect(await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "running", workerId: "w-new" })).toBe(false);
    expect(await t.mutation(internal.orchestration.setTaskStatus, { taskId, status: "failed" })).toBe(true);
    expect(await status(t, taskId)).toBe("failed");
  });
});

describe("claimNextTask head-of-line blocking (bug 10)", () => {
  test("30 legacy direct rows ahead of a valid task do not starve it", async () => {
    const t = convexTest(schema, modules);
    const projectId = await project(t);
    for (let i = 0; i < 30; i++) await queued(t, projectId, { mode: "direct", title: `legacy ${i}` });
    const valid = await queued(t, projectId, { title: "valid" });
    const claimed = await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1", leaseMs: 60_000 });
    expect(claimed?._id).toBe(valid);
  });

  test("the migration closes queued legacy direct rows, idempotently, and leaves others alone", async () => {
    const t = convexTest(schema, modules);
    const projectId = await project(t);
    const legacy: Id<"tasks">[] = [];
    for (let i = 0; i < 3; i++) legacy.push(await queued(t, projectId, { mode: "direct" }));
    const normal = await queued(t, projectId);
    const first = await t.mutation(internal.migrations.cancelLegacyDirectQueued, {});
    expect(first).toMatchObject({ cancelled: 3, done: true });
    for (const id of legacy) expect(await status(t, id)).toBe("cancelled");
    expect(await status(t, normal)).toBe("queued");
    const again = await t.mutation(internal.migrations.cancelLegacyDirectQueued, {});
    expect(again).toMatchObject({ cancelled: 0, done: true });
  });
});
