/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("workload.byRole", () => {
  test("reads subtasks, executions, usage, routes and agent replies per role, scoped by project", async () => {
    const t = convexTest(schema, modules);
    const { projectId, otherId } = await t.run(async (ctx) => {
      const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle" });
      const be = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle" });
      const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle" });
      const projectId = await ctx.db.insert("projects", { name: "Shop", workspacePath: "/tmp/a" });
      const otherId = await ctx.db.insert("projects", { name: "Blog", workspacePath: "/tmp/b" });
      const hidden = await ctx.db.insert("projects", { name: "Secret", workspacePath: "/tmp/c", ownerId: "someone-else" });
      const now = Date.now();
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "done", updatedAt: now });
      const otherTask = await ctx.db.insert("tasks", { projectId: otherId, title: "T2", command: "c", status: "done", updatedAt: now });
      const hiddenTask = await ctx.db.insert("tasks", { projectId: hidden, title: "T3", command: "c", status: "done", updatedAt: now });
      const base = { description: "d", dependencies: [], order: 1, attempts: 1, status: "completed" as const };
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "ui", title: "UI", kind: "code_change", capability: "frontend-development", assignedAgentId: fe, startedAt: now - 5000, completedAt: now - 1000 });
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "api", title: "API", kind: "code_change", capability: "backend-development", assignedAgentId: be, status: "failed" });
      await ctx.db.insert("subtasks", { ...base, taskId: otherTask, projectId: otherId, key: "ui2", title: "UI2", kind: "code_change", capability: "frontend-development", assignedAgentId: fe });
      await ctx.db.insert("subtasks", { ...base, taskId: hiddenTask, projectId: hidden, key: "x", title: "X", kind: "code_change", capability: "backend-development", assignedAgentId: be });
      await ctx.db.insert("executions", { taskId, projectId, subtaskKey: "ui", agentId: fe, agentName: "Frontend", capability: "frontend-development", workerId: "w", status: "completed", attempt: 1, startedAt: now - 5000, completedAt: now - 1000, createdAt: now - 5000 });
      await ctx.db.insert("tokenUsage", { projectId, taskId, agentId: fe, agentName: "Frontend", model: "m", inputTokens: 300, outputTokens: 0, estimatedCost: 0.01, createdAt: now });
      await ctx.db.insert("tokenUsage", { projectId, taskId, agentName: "CTO", model: "m", inputTokens: 100, outputTokens: 0, estimated: true, createdAt: now });
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "subtask.routed", payload: { subtaskKey: "ui", agent: "Frontend", role: "frontend", match: "exact" }, createdAt: now });
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "subtask.routed", payload: { subtaskKey: "api", agent: "Backend", capability: "backend-development", capabilities: ["general"] }, createdAt: now });
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "tool.started", payload: {}, createdAt: now });
      await ctx.db.insert("messages", { projectId, agentId: cto, authorType: "agent", content: "hi" });
      await ctx.db.insert("messages", { projectId, authorType: "user", content: "yo" });
      return { projectId, otherId };
    });

    const all = await t.query(api.workload.byRole, {});
    expect(all.totals.subtasks).toBe(3); // the owned project is not visible
    expect(all.rows.find((r) => r.key === "frontend")).toMatchObject({ subtasks: 2, timedRuns: 1, totalDurationMs: 4000, routes: 1, fallbackRoutes: 0 });
    expect(all.rows.find((r) => r.key === "backend")).toMatchObject({ subtasks: 1, routes: 1, fallbackRoutes: 1 });
    expect(all.rows.find((r) => r.key === "cto")).toMatchObject({ tokens: 100, tokensEstimated: true, chatReplies: 1 });
    expect(all.totals).toMatchObject({ tokens: 400, routes: 2, fallbackRoutes: 1, chatReplies: 1 });
    expect(all.summary).toMatch(/^Frontend did 67% of subtasks; /);

    const one = await t.query(api.workload.byRole, { projectId, sinceDays: 7 });
    expect(one.totals.subtasks).toBe(2);
    expect(one.sinceDays).toBe(7);
    const other = await t.query(api.workload.byRole, { projectId: otherId });
    expect(other.totals).toMatchObject({ subtasks: 1, tokens: 0, routes: 0 });
    expect(other.totals.subtasksWithoutRouteEvent).toBe(1);
    // An unsupported window falls back to 30 days.
    expect((await t.query(api.workload.byRole, { sinceDays: 12 })).sinceDays).toBe(30);
  });
});
