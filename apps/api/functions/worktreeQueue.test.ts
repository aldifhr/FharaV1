/// <reference types="vite/client" />
import { runtimeTest } from "@fhara/runtime/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "@fhara/runtime/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = runtimeTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const held = await ctx.db.insert("tasks", { projectId, title: "Held", command: "do", status: "queued" });
    const queued = await ctx.db.insert("tasks", { projectId, title: "Queued", command: "do", status: "queued" });
    const running = await ctx.db.insert("tasks", {
      projectId,
      title: "Running",
      command: "do",
      status: "running",
      workerId: "w0",
      leaseExpiresAt: Date.now() + 60_000,
    });
    return { projectId, held, queued, running };
  });
  return { t, ...ids };
}

describe("worktree setup queue hold", () => {
  test("a failed setup holds queued work and the claim skips it", async () => {
    const { t, projectId, held, queued, running } = await seed();
    await t.mutation(internal.orchestration.holdWorktreeQueue, {
      taskId: held,
      reason: "Worktree setup failed",
    });
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.worktreeQueueHold).toMatchObject({ reason: "Worktree setup failed", taskId: held });
    const rows = await t.run((ctx) => ctx.db.query("tasks").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect());
    expect(rows.find((r) => r._id === held)?.queueHeld).toBe(true);
    expect(rows.find((r) => r._id === queued)?.queueHeld).toBe(true);
    expect(rows.find((r) => r._id === running)?.queueHeld).toBeUndefined();
    expect(await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" })).toBeNull();
  });

  test("a task queued after the hold is also skipped", async () => {
    const { t, projectId, held } = await seed();
    await t.mutation(internal.orchestration.holdWorktreeQueue, { taskId: held, reason: "failed" });
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", { projectId, title: "Later", command: "do", status: "queued" });
    });
    expect(await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" })).toBeNull();
  });

  test("explicit resume clears the hold and the next claim takes the oldest queued task", async () => {
    const { t, projectId, held, queued } = await seed();
    await t.mutation(internal.orchestration.holdWorktreeQueue, { taskId: held, reason: "failed" });
    expect(await t.mutation(api.taskControl.resume, { taskId: held })).toEqual({ resumed: true, status: "queued" });
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.worktreeQueueHold).toBeUndefined();
    const rows = await t.run((ctx) => ctx.db.query("tasks").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect());
    expect(rows.every((r) => r.queueHeld !== true)).toBe(true);
    const first = await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" });
    const second = await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" });
    expect([first?._id, second?._id].sort()).toEqual([held, queued].sort());
  });
});
