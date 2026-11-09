/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("completeTask closes open subtasks (e2e ULTRA)", () => {
  test("a failed task leaves no pending/ready/blocked/running subtask", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "Ultra", command: "x", status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60_000 });
      const base = { taskId, projectId, description: "", kind: "code_change" as const, capability: "frontend-development", dependencies: [], attempts: 0 };
      await ctx.db.insert("subtasks", { ...base, key: "implement", title: "Implement", order: 0, status: "failed", error: "Subtask timed out after 300000ms", attempts: 1 });
      await ctx.db.insert("subtasks", { ...base, key: "qa", title: "QA", kind: "qa", capability: "browser-testing", order: 1, status: "pending" });
      await ctx.db.insert("subtasks", { ...base, key: "docs", title: "Docs", order: 2, status: "blocked" });
      await ctx.db.insert("subtasks", { ...base, key: "tests", title: "Tests", order: 3, status: "running", attempts: 1 });
      await ctx.db.insert("subtasks", { ...base, key: "style", title: "Style", order: 4, status: "completed", attempts: 1 });
      return { taskId };
    });
    const result = await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: "boom", workerId: "w1" });
    expect(result.applied).toBe(true);
    const rows = await t.run(async (ctx) => await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect());
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.qa.status).toBe("skipped");
    expect(byKey.qa.error).toBe("Not run: task failed");
    expect(byKey.docs.status).toBe("skipped");
    expect(byKey.tests.status).toBe("failed");
    // Settled rows keep their own outcome.
    expect(byKey.implement).toMatchObject({ status: "failed", error: "Subtask timed out after 300000ms" });
    expect(byKey.style.status).toBe("completed");
    expect(rows.some((r) => ["pending", "ready", "blocked", "running", "waiting_approval"].includes(r.status))).toBe(false);
  });

  test("a refused completion (already terminal) does not touch subtasks", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "Done", command: "x", status: "done" });
      await ctx.db.insert("subtasks", { taskId, projectId, key: "qa", title: "QA", description: "", kind: "qa", capability: "browser-testing", dependencies: [], order: 0, status: "pending", attempts: 0 });
      return { taskId };
    });
    const result = await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed" });
    expect(result.applied).toBe(false);
    const row = await t.run(async (ctx) => await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).first());
    expect(row?.status).toBe("pending");
  });
});
