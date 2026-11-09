/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/** Plan 020: the backend re-checks the task's permission mode. */
const modules = import.meta.glob("./**/*.ts");

async function setup(permissionMode?: "supervised" | "auto_edits" | "full_access") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Do work",
      command: "do it",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
      ...(permissionMode ? { permissionMode } : {}),
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

const request = (projectId: any, taskId: any, kind: "apply_changes" | "git_push" = "apply_changes") => ({
  taskId,
  projectId,
  workerId: "w1",
  kind,
  summary: "Apply verification fix (1 file(s)): src/a.ts",
  payload: { filePaths: ["src/a.ts"] },
  subtaskKey: "verify_fix_1",
  planVersion: 1,
});

describe("orchestration.autoApprove", () => {
  test("auto-accept edits: records an approved row (decidedBy auto) without pausing the task", async () => {
    const { t, projectId, taskId } = await setup("auto_edits");
    const result = await t.mutation(internal.orchestration.autoApprove, request(projectId, taskId));
    expect(result.autoApproved).toBe(true);
    const state = await t.run(async (ctx) => ({
      task: await ctx.db.get(taskId),
      approvals: await ctx.db.query("approvals").collect(),
      events: await ctx.db.query("taskEvents").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
    expect(state.task?.status).toBe("running");
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({ status: "approved", decidedBy: "auto", kind: "apply_changes" });
    expect(state.events.map((e) => e.type)).toContain("approval.auto_approved");
    expect(state.events.map((e) => e.type)).not.toContain("approval.requested");
    expect(state.audit.some((a) => a.action === "approval.auto_approve" && a.decision === "allowed")).toBe(true);
    // The broker now allows the apply: the recorded row covers the file.
    const verdict = await t.query(internal.orchestration.checkPermission, {
      taskId,
      projectId,
      kind: "apply_changes",
      targetPath: "src/a.ts",
      planVersion: 1,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("supervised and pre-020 tasks: nothing is written", async () => {
    for (const mode of ["supervised", undefined] as const) {
      const { t, projectId, taskId } = await setup(mode);
      const result = await t.mutation(internal.orchestration.autoApprove, request(projectId, taskId));
      expect(result.autoApproved).toBe(false);
      const approvals = await t.run(async (ctx) => await ctx.db.query("approvals").collect());
      expect(approvals).toHaveLength(0);
    }
  });

  test("push still asks in full access", async () => {
    const { t, projectId, taskId } = await setup("full_access");
    const result = await t.mutation(internal.orchestration.autoApprove, request(projectId, taskId, "git_push"));
    expect(result.autoApproved).toBe(false);
    const approvals = await t.run(async (ctx) => await ctx.db.query("approvals").collect());
    expect(approvals).toHaveLength(0);
  });
});

describe("tasks.createFromCommand permission mode", () => {
  test("uses the composer's mode, else the project default, else supervised", async () => {
    const { t, projectId } = await setup();
    const plain = await t.mutation(api.tasks.createFromCommand, { projectId, command: "first" });
    const picked = await t.mutation(api.tasks.createFromCommand, { projectId, command: "second", permissionMode: "full_access" });
    await t.run(async (ctx) => ctx.db.patch(projectId, { defaultPermissionMode: "auto_edits" }));
    const defaulted = await t.mutation(api.tasks.createFromCommand, { projectId, command: "third" });
    const modes = await t.run(async (ctx) =>
      Promise.all([plain, picked, defaulted].map(async (id) => (await ctx.db.get(id))?.permissionMode))
    );
    expect(modes).toEqual(["supervised", "full_access", "auto_edits"]);
  });
});
