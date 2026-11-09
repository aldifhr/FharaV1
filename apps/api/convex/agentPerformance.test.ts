/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("agentPerformance (plan 027)", () => {
  test("scores per agent + capability from recorded rows; setting toggles", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle" });
      const fe2 = await ctx.db.insert("agents", { name: "Frontend B", role: "frontend", status: "idle" });
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [fe, fe2] });
      for (let i = 0; i < 4; i++) {
        const taskId = await ctx.db.insert("tasks", { projectId, title: `T${i}`, command: "c", status: "done", updatedAt: now });
        const base = { taskId, projectId, description: "d", order: 1, kind: "code_change" as const, capability: "frontend-development", dependencies: [] };
        await ctx.db.insert("subtasks", { ...base, key: "good", title: "g", status: "completed", attempts: 1, assignedAgentId: fe, startedAt: now - 2000, completedAt: now - 1000, acceptanceStatus: "accepted" });
        await ctx.db.insert("subtasks", { ...base, key: "bad", title: "b", status: i === 0 ? "completed" : "failed", attempts: 2, assignedAgentId: fe2, startedAt: now - 2000, completedAt: now - 1500 });
        await ctx.db.insert("executions", { taskId, projectId, subtaskKey: "good", agentId: fe, agentName: "Frontend", capability: "frontend-development", workerId: "w", status: "completed", attempt: 1, createdAt: now, meta: { filePaths: ["a.ts"] } });
        await ctx.db.insert("tokenUsage", { projectId, taskId, agentId: fe, agentName: "Frontend", model: "m", inputTokens: 100, outputTokens: 50, subtaskKey: "good", createdAt: now });
      }
      return { fe, fe2, projectId };
    });

    const { scores } = await t.query(internal.agentPerformance.scoresForProject, { projectId: ids.projectId });
    const good = scores.find((s) => s.agentId === ids.fe)!;
    const bad = scores.find((s) => s.agentId === ids.fe2)!;
    expect(good).toMatchObject({ capability: "frontend-development", samples: 4, insufficient: false });
    expect(good.factors.efficiency.tokensPerAccepted).toBe(150);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.factors.retry.raw).toBe(1);

    const profile = await t.query(api.agentPerformance.agentScores, { agentId: ids.fe, projectId: ids.projectId });
    expect(profile!.scores).toHaveLength(1);
    expect(profile!.performanceRouting).toBeNull();
    await t.mutation(api.agentPerformance.setPerformanceRouting, { projectId: ids.projectId, enabled: true });
    expect((await t.query(api.agentPerformance.agentScores, { agentId: ids.fe, projectId: ids.projectId }))!.performanceRouting).toBe(true);
    expect((await t.query(api.orgIntel.capacity, { projectId: ids.projectId })).performanceRouting).toBe(true);
  });
});
