/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle" });
    const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle" });
    const qa = await ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle" });
    const projectId = await ctx.db.insert("projects", { name: "Shedi", workspacePath: "/tmp/s" });
    const ownedId = await ctx.db.insert("projects", { name: "Secret", workspacePath: "/tmp/x", ownerId: "someone-else" });
    const t0 = 1_700_000_000_000;
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Pricing page",
      command: "Build a pricing page",
      status: "done",
      startedAt: t0,
      completedAt: t0 + 60_000,
    });
    await ctx.db.insert("plans", {
      taskId, projectId, version: 1, strategy: "dag", createdBy: "orchestrator", goal: "Ship pricing",
      payload: { subtasks: [{ key: "fe-1" }, { key: "qa-1" }] }, createdAt: t0 + 5_000,
    });
    const feSub = await ctx.db.insert("subtasks", {
      taskId, projectId, key: "fe-1", title: "Build UI", description: "Make the page", kind: "code_change",
      capability: "frontend", dependencies: [], order: 1, status: "completed", attempts: 2,
      assignedAgentId: fe, assignedAgentName: "Frontend", output: "done UI",
    });
    const qaSub = await ctx.db.insert("subtasks", {
      taskId, projectId, key: "qa-1", title: "Test UI", description: "Check it", kind: "qa",
      capability: "qa", dependencies: ["fe-1"], order: 2, status: "completed", attempts: 1,
      assignedAgentId: qa, assignedAgentName: "QA",
    });
    const fe1 = await ctx.db.insert("executions", {
      taskId, projectId, subtaskId: feSub, subtaskKey: "fe-1", agentId: fe, agentName: "Frontend", capability: "frontend",
      workerId: "w", status: "failed", attempt: 1, startedAt: t0 + 6_000, completedAt: t0 + 16_000, error: "boom", createdAt: t0 + 6_000,
    });
    const fe2 = await ctx.db.insert("executions", {
      taskId, projectId, subtaskId: feSub, subtaskKey: "fe-1", agentId: fe, agentName: "Frontend", capability: "frontend",
      workerId: "w", status: "completed", attempt: 2, startedAt: t0 + 17_000, completedAt: t0 + 37_000, output: "done UI", createdAt: t0 + 17_000,
    });
    const qa1 = await ctx.db.insert("executions", {
      taskId, projectId, subtaskId: qaSub, subtaskKey: "qa-1", agentId: qa, agentName: "QA", capability: "qa",
      workerId: "w", status: "completed", attempt: 1, startedAt: t0 + 40_000, completedAt: t0 + 55_000, output: "ok", createdAt: t0 + 40_000,
    });
    // Planner call (no execution link).
    await ctx.db.insert("tokenUsage", { projectId, taskId, agentId: cto, agentName: "CTO", model: "m-plan", inputTokens: 100, outputTokens: 50, createdAt: t0 + 4_000 });
    // Linked call.
    await ctx.db.insert("tokenUsage", { projectId, taskId, agentId: fe, agentName: "Frontend", model: "m-code", inputTokens: 1000, outputTokens: 400, estimatedCost: 0.02, executionId: fe2, subtaskKey: "fe-1", createdAt: t0 + 30_000 });
    // Legacy call for QA: matched by agent + window.
    await ctx.db.insert("tokenUsage", { projectId, taskId, agentId: qa, agentName: "QA", model: "m-code", inputTokens: 200, outputTokens: 20, createdAt: t0 + 50_000 });
    await ctx.db.insert("delegations", { taskId, projectId, fromAgentId: cto, toAgentId: fe, decision: "APPROVE", reason: "UI work", capability: "frontend", createdAt: t0 + 5_500 });
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "qa.passed", subtaskKey: "qa-1", sequence: 2, createdAt: t0 + 56_000 });
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "orchestrator.plan", sequence: 1, createdAt: t0 + 5_000 });
    const runningTask = await ctx.db.insert("tasks", { projectId, title: "Still going", command: "x", status: "running", startedAt: t0 + 100_000 });
    const hiddenTask = await ctx.db.insert("tasks", { projectId: ownedId, title: "Hidden", command: "x", status: "done" });
    return { taskId, runningTask, hiddenTask, projectId, ownedId, fe1, fe2, qa1, t0 };
  });
  return { t, ...ids };
}

describe("runs.list", () => {
  test("summarises visible runs with tokens, roles, errors and progress", async () => {
    const { t, taskId, runningTask } = await seed();
    const { runs } = await t.query(api.runs.list, {});
    expect(runs.map((r) => r.title)).not.toContain("Hidden");
    const run = runs.find((r) => r.taskId === taskId)!;
    expect(run).toMatchObject({
      projectName: "Shedi",
      status: "done",
      durationMs: 60_000,
      inputTokens: 1300,
      outputTokens: 470,
      estimatedCost: 0.02,
      errorCount: 1,
      subtasksDone: 2,
      subtasksTotal: 2,
    });
    expect(run.roles).toEqual(["frontend", "qa"]);
    const running = runs.find((r) => r.taskId === runningTask)!;
    expect(running.durationMs).toBeNull();
    expect(running.endedAt).toBeNull();
  });

  test("filters by project and refuses an owned project", async () => {
    const { t, projectId, ownedId } = await seed();
    const { runs, projectName } = await t.query(api.runs.list, { projectId, limit: 1 });
    expect(runs).toHaveLength(1);
    expect(projectName).toBe("Shedi");
    await expect(t.query(api.runs.list, { projectId: ownedId })).rejects.toThrow(/Unauthorized/);
  });
});

describe("runs.get", () => {
  test("orders steps from instruction to final, with attribution", async () => {
    const { t, taskId, fe1, fe2, qa1 } = await seed();
    const run = (await t.query(api.runs.get, { taskId }))!;
    expect(run.steps.map((s) => s.type)).toEqual(["received", "plan", "execution", "execution", "execution", "verdict", "final"]);
    const [received, plan, a1, a2, q] = run.steps;
    expect(received.input).toBe("Build a pricing page");
    expect(plan).toMatchObject({ role: "cto", durationMs: 5_000 });
    expect(plan.tokens).toMatchObject({ inputTokens: 100, approximate: true });
    expect(a1).toMatchObject({ id: fe1, status: "failed", error: "boom", attempt: 1, role: "frontend", durationMs: 10_000 });
    expect(a1.output).toBeUndefined();
    expect(a2).toMatchObject({ id: fe2, output: "done UI", input: "Make the page" });
    expect(a2.tokens).toMatchObject({ inputTokens: 1000, outputTokens: 400, approximate: false, models: ["m-code"] });
    expect(q).toMatchObject({ id: qa1, role: "qa", dependencies: ["fe-1"] });
    expect(q.handedOffFrom).toEqual([{ key: "fe-1", role: "frontend" }]);
    expect(q.tokens).toMatchObject({ inputTokens: 200, approximate: true });

    expect(run.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dependency", from: "fe-1", to: "qa-1" }),
        expect.objectContaining({ type: "delegation", fromRole: "cto", toRole: "frontend", reason: "UI work" }),
      ])
    );
    expect(run.handoffs).toEqual(
      expect.arrayContaining([
        { from: "cto", to: "frontend", count: 2 },
        { from: "frontend", to: "qa", count: 1 },
      ])
    );
    expect(run.totals).toMatchObject({ durationMs: 60_000, inputTokens: 1300, outputTokens: 470, calls: 3, estimatedCost: 0.02 });
    expect(run.totals.byModel["m-code"]).toMatchObject({ inputTokens: 1200, calls: 2 });
    expect(run.totals.unattributed).toBeNull();
    expect(run.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  test("returns null for a missing task and throws for another owner's", async () => {
    const { t, taskId, hiddenTask } = await seed();
    await t.run(async (ctx) => ctx.db.delete(taskId));
    expect(await t.query(api.runs.get, { taskId })).toBeNull();
    await expect(t.query(api.runs.get, { taskId: hiddenTask })).rejects.toThrow(/Unauthorized/);
  });
});

describe("runs: approval wait and estimated tokens", () => {
  test("approval steps belong to the user and are marked as waiting; estimated usage is flagged", async () => {
    const { t, taskId, projectId, t0 } = await seed();
    await t.run(async (ctx) => {
      const fe = (await ctx.db.query("agents").collect()).find((a) => a.role === "frontend")!;
      await ctx.db.insert("approvals", {
        taskId, projectId, kind: "apply_changes", summary: "Apply changes to 2 file(s)",
        requestedByAgentId: fe._id, status: "approved", resolvedAt: t0 + 200_000,
      } as never);
      await ctx.db.insert("tokenUsage", {
        projectId, taskId, agentName: "CTO", model: "nous", inputTokens: 40, outputTokens: 10, estimated: true, createdAt: t0 + 3_000,
      });
    });
    const run = await t.query(api.runs.get, { taskId });
    const approval = run!.steps.find((s) => s.type === "approval")!;
    expect(approval.role).toBe("you");
    expect(approval.waiting).toBe(true);
    expect(approval.agentName).toBe("requested by frontend");
    expect(run!.totals.estimated).toBe(true);
    const { runs } = await t.query(api.runs.list, {});
    expect(runs.find((r) => r.taskId === taskId)!.tokensEstimated).toBe(true);
  });
});

describe("runs: auto approvals are not the user's", () => {
  test("an approval granted by the permission mode (decidedBy auto) is labelled auto, not you, and never waited", async () => {
    const { t, taskId, projectId, t0 } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("approvals", {
        taskId, projectId, kind: "apply_changes", summary: "Apply changes to 1 file(s)",
        status: "approved", decidedBy: "auto", resolvedAt: t0 + 1_000,
      } as never);
    });
    const run = await t.query(api.runs.get, { taskId });
    const approval = run!.steps.find((s) => s.type === "approval")!;
    expect(approval.role).toBe("auto");
    expect(approval.decidedBy).toBe("auto");
    expect(approval.waiting).toBe(false);
  });
});
