/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "test-service-token-live";

async function setup() {
  process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "T",
      command: "do it",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const base = { taskId, projectId, title: "S", description: "", kind: "analysis" as const, capability: "analysis", dependencies: [], attempts: 0 };
    await ctx.db.insert("subtasks", { ...base, key: "s1", order: 0, status: "running" });
    await ctx.db.insert("subtasks", { ...base, key: "s2", order: 1, status: "pending" });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

const liveRows = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.run(async (ctx) => await ctx.db.query("subtaskLive").collect());

describe("subtask live output", () => {
  test("worker action is service-token gated", async () => {
    const { t, taskId } = await setup();
    await expect(
      t.action(api.worker.setSubtaskLiveOutput, { taskId, key: "s1", text: "x", workerId: "w1", workerToken: "wrong" })
    ).rejects.toThrow();
    expect(await liveRows(t)).toHaveLength(0);
    const ok = await t.action(api.worker.setSubtaskLiveOutput, {
      taskId,
      key: "s1",
      text: "hello",
      workerId: "w1",
      workerToken: SERVICE_TOKEN,
    });
    expect(ok).toBe(true);
    expect(await t.query(api.subtaskLive.get, { taskId, key: "s1" })).toMatchObject({ text: "hello" });
  });

  test("set upserts one row, caps the tail, and empty text clears", async () => {
    const { t, taskId } = await setup();
    await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "a", workerId: "w1" });
    await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "x".repeat(9000) + "END", workerId: "w1" });
    const rows = await liveRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].text.length).toBe(8192);
    expect(rows[0].text.endsWith("END")).toBe(true);
    expect(await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "", workerId: "w1" })).toBe(false);
    expect(await liveRows(t)).toHaveLength(0);
    expect(await t.query(api.subtaskLive.get, { taskId, key: "s1" })).toBeNull();
  });

  test("only running subtasks and the lease holder may write", async () => {
    const { t, taskId } = await setup();
    expect(await t.mutation(internal.subtaskLive.set, { taskId, key: "s2", text: "x", workerId: "w1" })).toBe(false);
    expect(await t.mutation(internal.subtaskLive.set, { taskId, key: "nope", text: "x", workerId: "w1" })).toBe(false);
    expect(await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "x", workerId: "other" })).toBe(false);
    expect(await liveRows(t)).toHaveLength(0);
  });

  test("settling the subtask clears its tail; a late write does not bring it back", async () => {
    const { t, taskId } = await setup();
    await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "working", workerId: "w1" });
    expect(await liveRows(t)).toHaveLength(1);
    await t.mutation(internal.orchestration.updateSubtask, { taskId, key: "s1", status: "completed", output: "done", workerId: "w1" });
    expect(await liveRows(t)).toHaveLength(0);
    expect(await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "late", workerId: "w1" })).toBe(false);
    expect(await liveRows(t)).toHaveLength(0);
  });

  test("the read is gated by project visibility", async () => {
    const { t, taskId, projectId } = await setup();
    await t.mutation(internal.subtaskLive.set, { taskId, key: "s1", text: "secret", workerId: "w1" });
    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, { ownerId: "owner-1" });
    });
    await expect(t.query(api.subtaskLive.get, { taskId, key: "s1" })).rejects.toThrow();
    const owner = t.withIdentity({ subject: "owner-1" });
    expect(await owner.query(api.subtaskLive.get, { taskId, key: "s1" })).toMatchObject({ text: "secret" });
  });
});
