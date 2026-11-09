/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { dayKey, median } from "./evals";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const otherProjectId = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
    const coder = await ctx.db.insert("agents", { name: "Coder", role: "backend", status: "idle" });
    const qa = await ctx.db.insert("agents", { name: "Tester", role: "qa", status: "idle" });

    const mkTask = (status: "done" | "failed" | "rejected" | "running", pid = projectId) =>
      ctx.db.insert("tasks", { projectId: pid, title: status, command: "x", status, completedAt: now });
    const t1 = await mkTask("done");
    const t2 = await mkTask("done");
    const t3 = await mkTask("failed");
    await mkTask("running");
    await mkTask("failed", otherProjectId);

    const exec = (taskId: typeof t1, agentId: typeof coder, agentName: string, status: "completed" | "failed", attempt = 1, ms = 1000) =>
      ctx.db.insert("executions", {
        taskId,
        projectId,
        agentId,
        agentName,
        capability: "code",
        workerId: "w",
        status,
        attempt,
        startedAt: now - ms,
        completedAt: now,
        createdAt: now,
      });
    await exec(t1, coder, "Coder", "completed", 1, 2000);
    await exec(t3, coder, "Coder", "failed", 2, 4000);
    await exec(t2, qa, "Tester", "completed", 1, 1000);

    await ctx.db.insert("evaluations", { taskId: t1, projectId, planVersion: 1, verdict: "passed", checks: [], createdAt: now });
    await ctx.db.insert("evaluations", { taskId: t3, projectId, planVersion: 1, verdict: "failed", checks: [], createdAt: now });
    await ctx.db.insert("evaluations", { taskId: t2, projectId, planVersion: 1, verdict: "inconclusive", checks: [], createdAt: now });

    const use = (taskId: typeof t1, agentId: typeof coder, agentName: string, model: string, cost?: number) =>
      ctx.db.insert("tokenUsage", {
        projectId,
        taskId,
        agentId,
        agentName,
        model,
        inputTokens: 100,
        outputTokens: 50,
        ...(cost !== undefined ? { estimatedCost: cost } : {}),
        createdAt: now,
      });
    await use(t1, coder, "Coder", "gpt-a", 0.1);
    await use(t3, coder, "Coder", "gpt-a", 0.3);
    await use(t2, qa, "Tester", "gpt-b");

    const audit = (tool: string, decision: "allowed" | "denied" | "recorded") =>
      ctx.db.insert("audit", { projectId, actor: "Coder", tool, action: "run", decision, createdAt: now });
    await audit("run_command", "allowed");
    await audit("read_file", "allowed");
    await audit("write_file", "allowed");
    await audit("run_command", "denied");
    await audit("config", "recorded");
    return { projectId, otherProjectId };
  });
  return { t, ...ids };
}

describe("evals.summary", () => {
  test("aggregates success, QA, tools, agents, cost and models for one project", async () => {
    const { t, projectId } = await seed();
    const s = await t.query(api.evals.summary, { projectId, days: 7 });

    expect(s.hasData).toBe(true);
    expect(s.taskSuccess).toMatchObject({ done: 2, failed: 1, finished: 3 });
    expect(s.taskSuccess.rate).toBeCloseTo(2 / 3);

    expect(s.qa.source).toBe("evaluations");
    expect(s.qa.rate).toBe(0.5);
    expect(s.qa.evaluations.inconclusive).toBe(1);

    // config rows are excluded: 3 allowed / 4 governed calls.
    expect(s.toolCalls).toMatchObject({ source: "audit", allowed: 3, denied: 1, rate: 0.75 });

    const coder = s.agents.find((a) => a.role === "backend")!;
    expect(coder).toMatchObject({ executions: 2, failed: 1, retries: 1, tokens: 300 });
    expect(coder.failureRate).toBe(0.5);
    expect(coder.avgDurationMs).toBe(3000);
    expect(coder.cost).toBeCloseTo(0.4);
    // Sorted by failure rate, worst first.
    expect(s.agents[0].role).toBe("backend");
    const tester = s.agents.find((a) => a.role === "qa")!;
    expect(tester.cost).toBeNull();

    expect(s.cost.pricedCalls).toBe(2);
    expect(s.cost.unpricedCalls).toBe(1);
    expect(s.cost.avgPerTask).toBeCloseTo(0.2);
    expect(s.cost.medianPerTask).toBeCloseTo(0.2);
    expect(s.cost.note).toMatch(/1 of 3 calls had no pricing/);

    const a = s.models.find((m) => m.model === "gpt-a")!;
    expect(a).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 100, executions: 2 });
    expect(a.failureRate).toBe(0.5);
    expect(s.models.find((m) => m.model === "gpt-b")!.cost).toBeNull();
    expect(s.modelAttribution).toBe("task_and_agent");

    expect(s.trend.length).toBeGreaterThanOrEqual(7);
    const today = s.trend[s.trend.length - 1];
    expect(today).toMatchObject({ finished: 3, done: 2 });
    expect(today.cost).toBeCloseTo(0.4);
  });

  test("without a project it covers every visible project", async () => {
    const { t } = await seed();
    const s = await t.query(api.evals.summary, { days: 30 });
    expect(s.taskSuccess.finished).toBe(4);
    expect(s.taskSuccess.failed).toBe(2);
  });

  test("empty window reports no data and a no-calls note", async () => {
    const t = convexTest(schema, modules);
    const s = await t.query(api.evals.summary, { days: 90 });
    expect(s.hasData).toBe(false);
    expect(s.taskSuccess.rate).toBeNull();
    expect(s.cost.avgPerTask).toBeNull();
    expect(s.cost.note).toMatch(/No model calls/);
    expect(s.agents).toEqual([]);
  });

  test("an owned project is refused to an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Owned", workspacePath: "/tmp/o", ownerId: "someone" })
    );
    await expect(t.query(api.evals.summary, { projectId, days: 7 })).rejects.toThrow(/Unauthorized/);
  });

  test("model outcome uses tokenUsage.executionId when present", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const now = Date.now();
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const agentId = await ctx.db.insert("agents", { name: "Coder", role: "backend", status: "idle" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "t", command: "x", status: "done" });
      const base = { taskId, projectId, agentId, agentName: "Coder", capability: "code", workerId: "w", attempt: 1, startedAt: now - 1000, completedAt: now, createdAt: now };
      const ok = await ctx.db.insert("executions", { ...base, status: "completed" });
      const bad = await ctx.db.insert("executions", { ...base, status: "failed" });
      const usage = { projectId, taskId, agentId, agentName: "Coder", inputTokens: 1, outputTokens: 1, createdAt: now };
      await ctx.db.insert("tokenUsage", { ...usage, model: "good-model", executionId: ok });
      await ctx.db.insert("tokenUsage", { ...usage, model: "bad-model", executionId: bad });
      return projectId;
    });
    const s = await t.query(api.evals.summary, { projectId, days: 7 });
    expect(s.modelAttribution).toBe("executionId");
    expect(s.models.find((m) => m.model === "good-model")!.failureRate).toBe(0);
    expect(s.models.find((m) => m.model === "bad-model")!.failureRate).toBe(1);
  });
});

describe("evals helpers", () => {
  test("median and dayKey", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    // 2026-11-09 20:00 UTC is already Nov 10 in Jakarta (offset -420).
    const ms = Date.UTC(2026, 10, 9, 20, 0);
    expect(dayKey(ms, 0)).toBe("2026-11-09");
    expect(dayKey(ms, -420)).toBe("2026-11-10");
  });
});
