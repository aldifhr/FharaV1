/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// fx-ui 2026-11-11 #4: a Done whose QA could not run keeps the caveat on
// the task row (completionWarning) and in the task.done event.
describe("completeTask: completionWarning", () => {
  async function running(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      return await ctx.db.insert("tasks", {
        projectId, title: "T", command: "x", status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60_000,
      });
    });
  }

  test("done + warning stores it and logs it on task.done", async () => {
    const t = convexTest(schema, modules);
    const taskId = await running(t);
    await t.mutation(internal.orchestration.completeTask, {
      taskId, status: "done", workerId: "w1", completionWarning: "QA blocked: Chromium is not installed on the worker",
    });
    const { task, events } = await t.run(async (ctx) => ({
      task: await ctx.db.get(taskId),
      events: await ctx.db.query("taskEvents").collect(),
    }));
    expect(task?.status).toBe("done");
    expect(task?.completionWarning).toBe("QA blocked: Chromium is not installed on the worker");
    expect(events.find((e) => e.type === "task.done")?.payload).toEqual({ warning: "QA blocked: Chromium is not installed on the worker" });
  });

  test("a failed task never keeps a completion warning", async () => {
    const t = convexTest(schema, modules);
    const taskId = await running(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", workerId: "w1", errorMessage: "boom", completionWarning: "QA blocked: x" });
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.completionWarning).toBeUndefined();
  });
});
