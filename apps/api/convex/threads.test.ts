/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { patchTask, syncConversationThread, syncTaskThread, taskThreadStatus } from "./lib/threadIndex";

/** Paradev B1: threadIndex, threads.list / rename / markSeen / backfill. */

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" });
    const ownerId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add auth",
      command: "add auth",
      status: "done",
      branchName: "fhara/auth",
      worktreePath: "/tmp/p/.wt/fhara/auth/",
      updatedAt: 1_000,
    });
    const fixId = await ctx.db.insert("tasks", {
      projectId,
      title: "Fix review round 1",
      command: "fix",
      status: "running",
      parentTaskId: ownerId,
      branchName: "fhara/auth",
      worktreePath: "/tmp/p/.wt/fhara/auth",
      updatedAt: 2_000,
    });
    const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: 500, title: "Planning" });
    return { projectId, ownerId, fixId, conversationId };
  });
  return { t, ...ids };
}

const rowsOf = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("threadIndex").collect());

describe("threadIndex", () => {
  test("backfill is idempotent and indexes tasks and project conversations", async () => {
    const { t, projectId, ownerId, fixId } = await seed();
    const first = await t.mutation(internal.threads.backfill, { once: true });
    expect(first.done).toBe(false);
    await t.mutation(internal.threads.backfill, { table: "conversations", once: true });
    expect(await rowsOf(t)).toHaveLength(3);
    const again = await t.mutation(internal.threads.backfill, { once: true });
    const againConv = await t.mutation(internal.threads.backfill, { table: "conversations", once: true });
    expect(again.written + againConv.written).toBe(0);
    expect(await rowsOf(t)).toHaveLength(3);

    const list = await t.query(api.threads.list, { projectId });
    expect(list.map((row) => row.kind).sort()).toEqual(["conversation", "task", "task"]);
    // Newest activity first; backfilled rows count as seen.
    expect(list[0].taskId).toBe(fixId);
    expect(list.every((row) => !row.unread)).toBe(true);
    // list returns fix tasks with ownerTaskId, sharing the owner's worktree key.
    const fix = list.find((row) => row.taskId === fixId)!;
    const owner = list.find((row) => row.taskId === ownerId)!;
    expect(fix.ownerTaskId).toBe(ownerId);
    expect(fix.worktreeKey).toBe(owner.worktreeKey);
  });

  test("a preview-only change writes nothing; a status change writes one row", async () => {
    const { t, fixId } = await seed();
    await t.run((ctx) => syncTaskThread(ctx, fixId, { seen: true }));
    const before = (await rowsOf(t))[0];
    await t.run((ctx) => patchTask(ctx, fixId, { leaseExpiresAt: 99, updatedAt: 3_000 }));
    await t.run((ctx) => ctx.db.patch(before._id, { preview: "new text" }));
    expect(await t.run((ctx) => syncTaskThread(ctx, fixId))).toBe("unchanged");
    expect((await rowsOf(t))[0].updatedMs).toBe(before.updatedMs);
    await t.run((ctx) => patchTask(ctx, fixId, { status: "needs_approval" }));
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("needs you");
    expect(rows[0].needsYou).toBe(true);
  });

  test("conversation message bumps are throttled", async () => {
    const { t, conversationId } = await seed();
    await t.run((ctx) => syncConversationThread(ctx, conversationId, { seen: true }));
    await t.run((ctx) => ctx.db.patch(conversationId, { lastMessageAt: 10_000 }));
    expect(await t.run((ctx) => syncConversationThread(ctx, conversationId))).toBe("unchanged");
    await t.run((ctx) => ctx.db.patch(conversationId, { lastMessageAt: 120_000 }));
    expect(await t.run((ctx) => syncConversationThread(ctx, conversationId))).toBe("patched");
  });

  test("legacy direct threads in waiting_input read as idle, not needs you", () => {
    expect(taskThreadStatus({ status: "waiting_input", mode: "direct" })).toEqual({ status: "idle", needsYou: false });
    expect(taskThreadStatus({ status: "waiting_input" })).toEqual({ status: "needs you", needsYou: true });
    expect(taskThreadStatus({ status: "paused", pausedBy: "held" }).status).toBe("held");
  });

  test("rename patches the title, sets titleSetBy user and refuses blanks", async () => {
    const { t, projectId, ownerId, conversationId } = await seed();
    await t.mutation(api.threads.rename, { taskId: ownerId, title: "  Auth   flow " });
    const task = await t.run((ctx) => ctx.db.get(ownerId));
    expect(task?.title).toBe("Auth flow");
    expect(task?.titleSetBy).toBe("user");
    await expect(t.mutation(api.threads.rename, { taskId: ownerId, title: "   " })).rejects.toThrow(/empty/);
    // The system does not overwrite a user rename.
    await t.run((ctx) => patchTask(ctx, ownerId, { title: "System title", status: "running" }));
    expect((await t.run((ctx) => ctx.db.get(ownerId)))?.title).toBe("Auth flow");
    await t.mutation(api.threads.rename, { conversationId, title: "Roadmap" });
    const list = await t.query(api.threads.list, { projectId });
    expect(list.find((row) => row.taskId === ownerId)?.title).toBe("Auth flow");
    expect(list.find((row) => row.conversationId === conversationId)?.title).toBe("Roadmap");
  });

  test("markSeen clears unread", async () => {
    const { t, projectId, fixId } = await seed();
    await t.run((ctx) => syncTaskThread(ctx, fixId));
    expect((await t.query(api.threads.list, { projectId }))[0].unread).toBe(true);
    await t.mutation(api.threads.markSeen, { taskId: fixId });
    expect((await t.query(api.threads.list, { projectId }))[0].unread).toBe(false);
  });

  test("deleting a task takes its thread row with it", async () => {
    const { t, projectId, ownerId } = await seed();
    await t.run((ctx) => syncTaskThread(ctx, ownerId, { seen: true }));
    expect(await rowsOf(t)).toHaveLength(1);

    await t.mutation(api.tasks.remove, { taskId: ownerId });

    expect(await rowsOf(t)).toHaveLength(0);
    expect(await t.query(api.threads.list, { projectId })).toHaveLength(0);
  });

  test("the project cascade deletes thread rows", async () => {
    const { t, projectId } = await seed();
    await t.mutation(internal.threads.backfill, { once: true });
    expect((await rowsOf(t)).length).toBeGreaterThan(0);
    let step = 0;
    let deleted = 0;
    for (let i = 0; i < 100; i++) {
      const out = await t.mutation(internal.projects.cascadeDelete, { projectId, step, deleted });
      if (out.done) break;
      ({ step, deleted } = out);
    }
    expect(await rowsOf(t)).toHaveLength(0);
  });
});
