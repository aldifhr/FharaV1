/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resolveWorkspaceTarget } from "./permissionBroker";

/**
 * Regression tests for the core audit fixes (core.md H4, H5, H6, H7, M1–M5,
 * M8, M10). Each block names the finding it covers.
 */

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);

async function seed(
  opts: { ownerId?: string; workspacePath?: string; status?: "running" | "needs_approval" | "queued"; workerId?: string; planVersion?: number } = {}
) {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: opts.workspacePath ?? "/srv/ws/app",
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
    });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "T",
      command: "do it",
      status: opts.status ?? "running",
      ...(opts.workerId ? { workerId: opts.workerId, leaseExpiresAt: Date.now() + 60_000 } : {}),
      planVersion: opts.planVersion ?? 1,
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

describe("H4 permission broker", () => {
  test("worker path is allowed to evaluate an OWNED project (no identity)", async () => {
    const { t, projectId, taskId } = await seed({ ownerId: "user-1" });
    const verdict = await t.query(internal.orchestration.checkPermission, {
      taskId,
      projectId,
      kind: "apply_changes",
      targetPath: "/srv/ws/app/src/a.ts",
    });
    expect(verdict.decision).toBe("ask");
  });

  test("public query still denies an owned project to an anonymous caller", async () => {
    const { t, projectId, taskId } = await seed({ ownerId: "user-1" });
    const verdict = await t.query(api.permissionBroker.decidePermission, {
      taskId,
      projectId,
      kind: "apply_changes",
      targetPath: "/srv/ws/app/src/a.ts",
    });
    expect(verdict.decision).toBe("deny");
  });

  test("relative and backslash paths resolve against the workspace", () => {
    expect(resolveWorkspaceTarget("/srv/ws/app", "src/a.ts")).toEqual({ escapes: false, relative: "src/a.ts" });
    expect(resolveWorkspaceTarget("/srv/ws/app", "./src/../b.ts")).toEqual({ escapes: false, relative: "b.ts" });
    expect(resolveWorkspaceTarget("/srv/ws/app", "../etc/passwd").escapes).toBe(true);
    expect(resolveWorkspaceTarget("/srv/ws/app", "/srv/ws/app2/x").escapes).toBe(true);
    expect(resolveWorkspaceTarget("C:\\Work\\App", "c:/work/app/src/a.ts")).toEqual({ escapes: false, relative: "src/a.ts" });
    // Relative project root: the worker resolves it under WORKSPACE_ROOT.
    expect(resolveWorkspaceTarget("projects/app", "/home/me/ws/projects/app/src/a.ts")).toEqual({
      escapes: false,
      relative: "src/a.ts",
    });
    expect(
      resolveWorkspaceTarget("projects/app", "/home/me/ws/projects/app/src/a.ts", "/home/me/ws/projects/app")
    ).toEqual({ escapes: false, relative: "src/a.ts" });
  });

  test("every file in a batch is checked, not just the first", async () => {
    const { t, projectId, taskId } = await seed();
    const verdict = await t.query(internal.orchestration.checkPermission, {
      taskId,
      projectId,
      kind: "apply_changes",
      targetPath: "/srv/ws/app/src/a.ts",
      targetPaths: ["src/b.ts", "/etc/passwd"],
    });
    expect(verdict.decision).toBe("deny");
  });
});

describe("M1 approvals match plan version and files", () => {
  async function withApproval(status: "approved" | "rejected", planVersion: number, filePaths: string[]) {
    const ctx = await seed({ planVersion: 2 });
    await ctx.t.run(async (db) => {
      await db.db.insert("approvals", {
        taskId: ctx.taskId,
        projectId: ctx.projectId,
        kind: "apply_changes",
        summary: "s",
        status,
        planVersion,
        payload: { filePaths, planVersion },
        resolvedAt: Date.now(),
      });
    });
    return ctx;
  }
  const check = (ctx: Awaited<ReturnType<typeof seed>>, files: string[]) =>
    ctx.t.query(internal.orchestration.checkPermission, {
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      kind: "apply_changes",
      targetPath: "",
      targetPaths: files,
    });

  test("an approval covers its own version and files", async () => {
    const ctx = await withApproval("approved", 2, ["src/a.ts", "src/b.ts"]);
    expect((await check(ctx, ["/srv/ws/app/src/a.ts", "src/b.ts"])).decision).toBe("allow");
  });
  test("an approval does not cover new files", async () => {
    const ctx = await withApproval("approved", 2, ["src/a.ts"]);
    expect((await check(ctx, ["src/a.ts", "src/new.ts"])).decision).toBe("ask");
  });
  test("an approval of an older plan version does not grant", async () => {
    const ctx = await withApproval("approved", 1, ["src/a.ts"]);
    expect((await check(ctx, ["src/a.ts"])).decision).toBe("ask");
  });
  test("an old rejection (older version) asks again instead of denying forever", async () => {
    const ctx = await withApproval("rejected", 1, ["src/a.ts"]);
    expect((await check(ctx, ["src/a.ts"])).decision).toBe("ask");
  });
  test("a current rejection still denies", async () => {
    const ctx = await withApproval("rejected", 2, ["src/a.ts"]);
    expect((await check(ctx, ["src/a.ts"])).decision).toBe("deny");
  });
});

describe("M2/M3 lease fencing", () => {
  test("a cleared workerId does not let a worker write", async () => {
    const { t, projectId, taskId } = await seed({ status: "queued" });
    await expect(
      t.mutation(internal.orchestration.startExecution, {
        taskId,
        projectId,
        subtaskKey: "a",
        agentName: "x",
        capability: "c",
        workerId: "w-old",
        attempt: 1,
      })
    ).rejects.toThrow(/Lease lost/);
  });

  test("savePlan / requestApproval refuse a displaced worker; owner proceeds", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w2" });
    const plan = {
      taskId,
      projectId,
      version: 1,
      strategy: "s",
      createdBy: "orchestrator" as const,
      goal: "g",
      payload: { subtasks: [{ key: "a" }] },
      subtasks: [{ key: "a", title: "a", description: "", kind: "analysis" as const, capability: "c", dependencies: [], order: 0 }],
    };
    await expect(t.mutation(internal.orchestration.savePlan, { ...plan, workerId: "w1" })).rejects.toThrow(/Lease lost/);
    expect(await t.mutation(internal.orchestration.savePlan, { ...plan, workerId: "w2" })).toBe(1);
    await expect(
      t.mutation(internal.orchestration.requestApproval, {
        taskId,
        projectId,
        kind: "apply_changes",
        summary: "x",
        workerId: "w1",
      })
    ).rejects.toThrow(/Lease lost/);
  });

  test("updateExecution from a displaced worker is refused as a value", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w2" });
    const executionId = await t.mutation(internal.orchestration.startExecution, {
      taskId,
      projectId,
      subtaskKey: "a",
      agentName: "x",
      capability: "c",
      workerId: "w2",
      attempt: 1,
    });
    const res = await t.mutation(internal.orchestration.updateExecution, {
      executionId,
      status: "failed",
      workerId: "w1",
    });
    expect(res.applied).toBe(false);
    const row = await t.run(async (ctx) => await ctx.db.get(executionId));
    expect(row?.status).toBe("running");
  });
});

describe("M4/M5 plan versions and replans", () => {
  const sub = (key: string) => ({ key, title: key, description: "", kind: "analysis" as const, capability: "c", dependencies: [], order: 0 });

  test("upsertDynamicSubtasks from an older plan version inserts nothing", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w" });
    await t.mutation(internal.orchestration.savePlan, {
      workerId: "w", taskId, projectId, version: 2, strategy: "s", createdBy: "orchestrator", goal: "g",
      payload: { subtasks: [sub("a")] }, subtasks: [sub("a")],
    });
    const res = await t.mutation(internal.orchestration.upsertDynamicSubtasks, {
      workerId: "w", taskId, projectId, version: 1, payload: { subtasks: [sub("late")] }, subtasks: [sub("late")],
    });
    expect(res.inserted).toEqual([]);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect()
    );
    expect(rows.map((r) => r.key)).toEqual(["a"]);
  });

  test("existing rows keep the reviewRound patch", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w" });
    await t.mutation(internal.orchestration.savePlan, {
      workerId: "w", taskId, projectId, version: 1, strategy: "s", createdBy: "orchestrator", goal: "g",
      payload: { subtasks: [sub("review")] }, subtasks: [{ ...sub("review"), reviewRound: 1 }],
    });
    await t.mutation(internal.orchestration.upsertDynamicSubtasks, {
      workerId: "w", taskId, projectId, version: 1, payload: { subtasks: [] }, subtasks: [{ ...sub("review"), reviewRound: 2 }],
    });
    const row = await t.run(async (ctx) =>
      ctx.db.query("subtasks").withIndex("by_task_and_key", (q) => q.eq("taskId", taskId).eq("key", "review")).unique()
    );
    expect(row?.reviewRound).toBe(2);
  });

  test("a replan keeps completed rows completed and drops removed keys", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w" });
    const base = { workerId: "w", taskId, projectId, strategy: "s", createdBy: "orchestrator" as const, goal: "g" };
    await t.mutation(internal.orchestration.savePlan, {
      ...base, version: 1, payload: { subtasks: [sub("a"), sub("b"), sub("c")] }, subtasks: [sub("a"), sub("b"), sub("c")],
    });
    const before = await t.run(async (ctx) => {
      const rows = await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect();
      const a = rows.find((r) => r.key === "a")!;
      await ctx.db.patch(a._id, { status: "completed", output: "done" });
      const b = rows.find((r) => r.key === "b")!;
      await ctx.db.patch(b._id, { status: "failed" });
      return a._id;
    });
    await t.mutation(internal.orchestration.savePlan, {
      ...base, version: 2, payload: { subtasks: [sub("a"), sub("b"), sub("d")] }, subtasks: [sub("a"), sub("b"), sub("d")],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect()
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Object.keys(byKey).sort()).toEqual(["a", "b", "d"]);
    expect(byKey.a.status).toBe("completed");
    expect(byKey.a.output).toBe("done");
    expect(byKey.a._id).toBe(before);
    expect(byKey.b.status).toBe("pending");
    expect(byKey.d.status).toBe("pending");
  });
});

describe("H7 recovery trusts the lease", () => {
  test("a task with a valid lease and no heartbeat row is not reclaimed", async () => {
    const { t, taskId } = await seed({ workerId: "fresh-worker" });
    const res = await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    expect(res.recoveredTasks).toBe(0);
    const task = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task?.status).toBe("running");
  });

  test("an expired lease is still recovered", async () => {
    const { t, taskId } = await seed();
    await t.run(async (ctx) => ctx.db.patch(taskId, { workerId: "w", leaseExpiresAt: Date.now() - 1000 }));
    const res = await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    expect(res.recoveredTasks).toBe(1);
  });
});

describe("H6 refreshAgentStatus", () => {
  test("agent goes idle once its last running execution completes", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w" });
    const agentId = await t.run(async (ctx) =>
      ctx.db.insert("agents", { name: "A", role: "backend", status: "idle", isEnabled: true })
    );
    const executionId = await t.mutation(internal.orchestration.startExecution, {
      taskId, projectId, subtaskKey: "a", agentId, agentName: "A", capability: "c", workerId: "w", attempt: 1,
    });
    expect((await t.run(async (ctx) => ctx.db.get(agentId)))?.status).toBe("working");
    await t.mutation(internal.orchestration.updateExecution, { executionId, status: "completed", workerId: "w" });
    expect((await t.run(async (ctx) => ctx.db.get(agentId)))?.status).toBe("idle");
  });
});

describe("M8 cancel cleans up", () => {
  test("cancel resolves pending approvals and cancels running executions", async () => {
    const { t, projectId, taskId } = await seed({ workerId: "w" });
    const executionId = await t.mutation(internal.orchestration.startExecution, {
      taskId, projectId, subtaskKey: "a", agentName: "A", capability: "c", workerId: "w", attempt: 1,
    });
    const approvalId = await t.run(async (ctx) =>
      ctx.db.insert("approvals", { taskId, projectId, kind: "apply_changes", summary: "s", status: "pending" })
    );
    expect(await t.mutation(api.tasks.cancel, { taskId })).toBe(true);
    const [approval, execution] = await t.run(async (ctx) => [await ctx.db.get(approvalId), await ctx.db.get(executionId)]);
    expect(approval?.status).toBe("cancelled");
    expect(execution?.status).toBe("cancelled");
  });

  test("retry supersedes an old rejection", async () => {
    const { t, projectId, taskId } = await seed({ status: "queued" });
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { status: "rejected" });
      await ctx.db.insert("approvals", { taskId, projectId, kind: "apply_changes", summary: "s", status: "rejected" });
    });
    await t.mutation(api.tasks.retry, { taskId });
    const approvals = await t.run(async (ctx) =>
      ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect()
    );
    expect(approvals.map((a) => a.status)).toEqual(["cancelled"]);
  });
});

describe("H5 authorization on owned projects", () => {
  test("anonymous callers cannot read or change an owned project's integrations/team", async () => {
    const { t, projectId } = await seed({ ownerId: "user-1" });
    const agentId = await t.run(async (ctx) =>
      ctx.db.insert("agents", { name: "A", role: "backend", status: "idle", isEnabled: true })
    );
    await expect(t.query(api.integrations.listByProject, { projectId })).rejects.toThrow(/Unauthorized/);
    await expect(t.mutation(api.roleRegistry.assignToProject, { projectId, agentId })).rejects.toThrow(/Unauthorized/);
    await expect(t.mutation(api.agents.create, { name: "X", role: "backend" })).rejects.toThrow(/Unauthorized/);
    await expect(
      t.action(api.messages.send, { projectId, content: "hi" })
    ).rejects.toThrow(/Unauthorized/);
    // The owner is allowed.
    const owner = t.withIdentity({ subject: "user-1" });
    expect(await owner.query(api.integrations.listByProject, { projectId })).toEqual([]);
  });

  test("global feeds hide owned projects from anonymous callers", async () => {
    const { t, projectId } = await seed({ ownerId: "user-1" });
    const overview = await t.query(api.overview.get, {});
    expect(overview.projects.map((p) => p._id)).not.toContain(projectId);
    expect(overview.taskCounts.total).toBe(0);
    expect(await t.query(api.tasks.activeTaskProjectIds, {})).toEqual([]);
    const owner = t.withIdentity({ subject: "user-1" });
    expect(await owner.query(api.tasks.activeTaskProjectIds, {})).toEqual([projectId]);
  });

  test("local mode (no owner) keeps working without identity", async () => {
    const { t, projectId } = await seed();
    expect(await t.query(api.integrations.listByProject, { projectId })).toEqual([]);
    expect(await t.query(api.tasks.activeTaskProjectIds, {})).toEqual([projectId]);
    await t.mutation(api.agents.create, { name: "X", role: "backend" });
  });
});

describe("M10 retired roles and revoked capabilities", () => {
  test("sync retires ui-ux / mixed-case roles and strips CTO code-review", async () => {
    const t = makeT();
    const ids = await t.run(async (ctx) => ({
      uiux: await ctx.db.insert("agents", { name: "UX", role: "UI/UX", status: "idle", isEnabled: true }),
      lead: await ctx.db.insert("agents", { name: "Lead", role: "Lead", status: "idle", isEnabled: true }),
      cto: await ctx.db.insert("agents", {
        name: "CTO", role: "cto", status: "idle", isEnabled: true,
        capabilities: ["architecture", "code-review", "my-custom"],
      }),
    }));
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const [uiux, lead, cto] = await t.run(async (ctx) => [
      await ctx.db.get(ids.uiux), await ctx.db.get(ids.lead), await ctx.db.get(ids.cto),
    ]);
    expect(uiux?.isEnabled).toBe(false);
    expect(lead?.isEnabled).toBe(false);
    expect(cto?.capabilities).not.toContain("code-review");
    expect(cto?.capabilities).toContain("my-custom");
    expect(cto?.capabilities).toContain("security-audit");
  });
});
