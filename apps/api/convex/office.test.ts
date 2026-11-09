/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("office.feed", () => {
  test("returns subtasks with activity, pushes and 24h usage of the project only", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const other = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
      const agentId = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "working" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "Login", command: "x", status: "running" });
      const otherTask = await ctx.db.insert("tasks", { projectId: other, title: "Other", command: "x", status: "running" });
      const base = { description: "", kind: "analysis" as const, capability: "analysis", dependencies: [], attempts: 0, order: 0 };
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "ui", title: "Form", status: "running", assignedAgentId: agentId, activity: "Running npm test", activityAt: Date.now() });
      await ctx.db.insert("subtasks", { ...base, taskId: otherTask, projectId: other, key: "x", title: "X", status: "running" });
      const now = Date.now();
      await ctx.db.insert("taskPushes", { taskId, projectId, branchName: "fhara/login", commitSha: "abc", commitMessage: "m", filesChanged: 1, status: "pushed", attempts: 1, pushedAt: now, createdAt: now, updatedAt: now });
      await ctx.db.insert("tokenUsage", { projectId, agentName: "Frontend", model: "m", inputTokens: 100, outputTokens: 50, estimatedCost: 0.01, createdAt: now });
      await ctx.db.insert("tokenUsage", { projectId, agentName: "Frontend", model: "m", inputTokens: 999, outputTokens: 1, kind: "playground", createdAt: now });
      await ctx.db.insert("tokenUsage", { projectId: other, agentName: "X", model: "m", inputTokens: 5, outputTokens: 5, createdAt: now });
      return { projectId };
    });

    const feed = await t.query(api.office.feed, { projectId });
    expect(feed).not.toBeNull();
    expect(feed!.subtasks).toHaveLength(1);
    expect(feed!.subtasks[0]).toMatchObject({ key: "ui", status: "running", activity: "Running npm test" });
    expect(feed!.pushes).toHaveLength(1);
    expect(feed!.pushes[0]).toMatchObject({ status: "pushed", branchName: "fhara/login" });
    expect(feed!.usage).toMatchObject({ tokens: 150, calls: 1 });
    expect(feed!.usage.cost).toBeCloseTo(0.01);
  });

  test("a project owned by someone else reads as null", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", ownerId: "someone-else" }));
    expect(await t.query(api.office.feed, { projectId })).toBeNull();
  });
});
