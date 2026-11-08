/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function makeT() {
  return convexTest(schema, modules);
}

async function needsApprovalTask() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
    });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Do work",
      command: "do it",
      status: "needs_approval",
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

describe("claimResumableTask (plan 011 single-consumer resume)", () => {
  test("the first worker wins the resume claim", async () => {
    const { t, taskId } = await needsApprovalTask();
    const claimed = await t.mutation(internal.orchestration.claimResumableTask, {
      taskId,
      workerId: "w1",
      leaseMs: 60_000,
    });
    expect(claimed?.workerId).toBe("w1");
    expect(claimed?.leaseExpiresAt).toBeTypeOf("number");
  });

  test("a second worker is refused while the lease is live", async () => {
    const { t, taskId } = await needsApprovalTask();
    await t.mutation(internal.orchestration.claimResumableTask, {
      taskId,
      workerId: "w1",
      leaseMs: 60_000,
    });
    const second = await t.mutation(internal.orchestration.claimResumableTask, {
      taskId,
      workerId: "w2",
      leaseMs: 60_000,
    });
    expect(second).toBeNull();
  });

  test("a second worker may claim after the lease expired", async () => {
    const { t, taskId } = await needsApprovalTask();
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, {
        workerId: "w1",
        leaseExpiresAt: Date.now() - 1_000,
      });
    });
    const second = await t.mutation(internal.orchestration.claimResumableTask, {
      taskId,
      workerId: "w2",
      leaseMs: 60_000,
    });
    expect(second?.workerId).toBe("w2");
  });

  test("only a needs_approval task can be claimed for resume", async () => {
    const { t, taskId } = await needsApprovalTask();
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { status: "running" });
    });
    const claimed = await t.mutation(internal.orchestration.claimResumableTask, {
      taskId,
      workerId: "w1",
    });
    expect(claimed).toBeNull();
  });
});

describe("lease fencing on worker writes (plan 011)", () => {
  test("completeTask is refused for a displaced worker holding no lease", async () => {
    const { t, taskId } = await needsApprovalTask();
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, {
        status: "running",
        workerId: "w2",
        leaseExpiresAt: Date.now() + 60_000,
      });
    });
    const result = await t.mutation(internal.orchestration.completeTask, {
      taskId,
      status: "done",
      workerId: "w1",
    });
    expect(result.applied).toBe(false);
    const task = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task?.status).toBe("running");
  });

  test("completeTask still applies for the current lease owner", async () => {
    const { t, taskId } = await needsApprovalTask();
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, {
        status: "running",
        workerId: "w2",
        leaseExpiresAt: Date.now() + 60_000,
      });
    });
    const result = await t.mutation(internal.orchestration.completeTask, {
      taskId,
      status: "done",
      workerId: "w2",
    });
    expect(result.applied).toBe(true);
  });

  test("saveFileChange is refused for a displaced worker", async () => {
    const { t, taskId, projectId } = await needsApprovalTask();
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, {
        status: "running",
        workerId: "w2",
        leaseExpiresAt: Date.now() + 60_000,
      });
    });
    const result = await t.mutation(internal.orchestration.saveFileChange, {
      taskId,
      projectId,
      filePath: "a.txt",
      changeType: "new",
      newContent: "x",
      diff: "diff",
      workerId: "w1",
    });
    expect(result).toBeNull();
    const changes = await t.run(
      async (ctx) =>
        await ctx.db
          .query("fileChanges")
          .withIndex("by_task", (q) => q.eq("taskId", taskId))
          .collect()
    );
    expect(changes).toHaveLength(0);
  });
});
