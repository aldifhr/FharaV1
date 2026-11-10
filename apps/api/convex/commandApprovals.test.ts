/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup(permissionMode: "supervised" | "auto_edits" | "full_access" = "supervised") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p" });
    const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: 1 });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Run tests",
      command: "run tests",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
      permissionMode,
      conversationId,
    });
    return { projectId, taskId, conversationId };
  });
  const request = (command: string, args: string[]) =>
    t.mutation(internal.commandApprovals.request, { projectId: ids.projectId, taskId: ids.taskId, command, args, workspaceRoot: "/ws/p", workerId: "w1", subtaskKey: "s1" });
  return { t, ...ids, request };
}

describe("commandApprovals.request", () => {
  test("supervised asks and keeps the task running with its lease", async () => {
    const { t, taskId, request } = await setup();
    const res = await request("npm", ["run", "test"]);
    expect(res.status).toBe("pending");
    expect(res.offerAlways).toBe(true);
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe("w1");
  });
  test("full access approves ordinary commands but still asks for push", async () => {
    const { request } = await setup("full_access");
    expect((await request("git", ["status"])).status).toBe("auto");
    const push = await request("git", ["push"]);
    expect(push.status).toBe("pending");
    expect(push.offerAlways).toBe(false);
  });
  test("auto-accept edits still asks for commands", async () => {
    const { request } = await setup("auto_edits");
    expect((await request("npm", ["run", "test"])).status).toBe("pending");
  });
  test("a displaced worker is refused", async () => {
    const { t, projectId, taskId } = await setup();
    await expect(
      t.mutation(internal.commandApprovals.request, { projectId, taskId, command: "git", args: ["status"], workerId: "other" })
    ).rejects.toThrow(/Lease lost/);
  });
});

describe("commandApprovals.respond", () => {
  test("always stores a project rule; the next matching command auto-approves", async () => {
    const { t, projectId, request } = await setup();
    const first = await request("npm", ["test"]);
    const res = await t.mutation(api.commandApprovals.respond, { approvalId: first.approvalId as any, decision: "always" });
    expect(res.decision).toBe("always");
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.commandAllowRules?.map((r) => r.prefix)).toEqual(["npm run test"]);
    const row = await t.query(internal.commandApprovals.get, { approvalId: first.approvalId as any });
    expect(row).toMatchObject({ status: "approved", decision: "always" });
    expect((await request("npm", ["run", "test"])).status).toBe("auto");
    // Removable in Manage project.
    await t.mutation(api.commandApprovals.removeRule, { projectId, prefix: "npm test" });
    expect((await request("npm", ["run", "test"])).status).toBe("pending");
  });
  test("always is downgraded to allow when the card did not offer it", async () => {
    const { t, projectId, request } = await setup();
    const push = await request("git", ["push"]);
    const res = await t.mutation(api.commandApprovals.respond, { approvalId: push.approvalId as any, decision: "always" });
    expect(res.decision).toBe("allow");
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.commandAllowRules ?? []).toEqual([]);
  });
  test("deny records the note; the legacy reject maps to deny", async () => {
    const { t, request } = await setup();
    const a = await request("npm", ["run", "build"]);
    await t.mutation(api.commandApprovals.respond, { approvalId: a.approvalId as any, decision: "deny", note: "jangan dulu" });
    expect(await t.query(internal.commandApprovals.get, { approvalId: a.approvalId as any })).toMatchObject({ status: "rejected", decision: "deny", note: "jangan dulu" });
    const b = await request("npm", ["run", "typecheck"]);
    await t.mutation(api.approvals.reject, { approvalId: b.approvalId as any });
    expect(await t.query(internal.commandApprovals.get, { approvalId: b.approvalId as any })).toMatchObject({ status: "rejected", decision: "deny" });
  });
});

describe("plan 041: always allow this exact command", () => {
  test("only the identical argv auto-approves, recorded as decidedBy auto with an audit row", async () => {
    const { t, projectId, request } = await setup();
    const first = await request("npx", ["vitest", "run", "tests/a.test.ts"]);
    expect(first.offerAlways).toBe(true);
    const res = await t.mutation(api.commandApprovals.respond, { approvalId: first.approvalId as any, decision: "always_exact" });
    expect(res.decision).toBe("always_exact");
    // The waiter consumed the one-time signal, so later requests go through the policy.
    await t.mutation(internal.commandApprovals.ack, { approvalId: first.approvalId as any, workerId: "w1" });
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.commandAllowExact?.map((e) => [e.command, ...e.args])).toEqual([["npx", "vitest", "run", "tests/a.test.ts"]]);
    expect(project?.commandAllowRules ?? []).toEqual([]);

    const same = await request("npx", ["vitest", "run", "tests/a.test.ts"]);
    expect(same.status).toBe("auto");
    expect(same.approvalId).not.toBe(first.approvalId);
    const row = await t.run((ctx) => ctx.db.get(same.approvalId));
    expect(row).toMatchObject({ status: "approved", decidedBy: "auto", kind: "run_command" });
    const audits = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audits.some((a: any) => a.action === "approval.auto_approve" && a.details?.exact === true && a.actor === "command-exact")).toBe(true);
    expect(audits.some((a: any) => a.action === "command_exact.add")).toBe(true);

    // One extra or one changed argument asks again.
    expect((await request("npx", ["vitest", "run", "tests/a.test.ts", "--update"])).status).toBe("pending");
    expect((await request("npx", ["vitest", "run", "tests/b.test.ts"])).status).toBe("pending");
    expect((await request("npx", ["vitest", "run"])).status).toBe("pending");
  });

  test("a removed entry asks again", async () => {
    const { t, projectId, request } = await setup();
    const first = await request("node", ["scripts/check.mjs"]);
    await t.mutation(api.commandApprovals.respond, { approvalId: first.approvalId as any, decision: "always_exact" });
    await t.mutation(internal.commandApprovals.ack, { approvalId: first.approvalId as any, workerId: "w1" });
    expect((await request("node", ["scripts/check.mjs"])).status).toBe("auto");
    expect(await t.mutation(api.commandApprovals.removeExactRule, { projectId, command: "node", args: ["scripts/check.mjs"] })).toEqual({ removed: true });
    expect((await request("node", ["scripts/check.mjs"])).status).toBe("pending");
  });

  test("push-like commands never offer it, are downgraded, and never match a stored entry", async () => {
    const { t, projectId, request } = await setup();
    const push = await request("git", ["push", "origin", "main"]);
    expect(push.offerAlways).toBe(false);
    const res = await t.mutation(api.commandApprovals.respond, { approvalId: push.approvalId as any, decision: "always_exact" });
    expect(res.decision).toBe("allow");
    expect((await t.run((ctx) => ctx.db.get(projectId)))?.commandAllowExact ?? []).toEqual([]);
    // Even an entry written straight into the project does not auto-approve push / merge.
    await t.run((ctx) =>
      ctx.db.patch(projectId, {
        commandAllowExact: [
          { command: "git", args: ["push", "origin", "main"], createdAt: 1, createdBy: "x" },
          { command: "gh", args: ["pr", "merge", "7"], createdAt: 1, createdBy: "x" },
        ],
      })
    );
    await t.mutation(internal.commandApprovals.ack, { approvalId: push.approvalId as any, workerId: "w1" });
    expect((await request("git", ["push", "origin", "main"])).status).toBe("pending");
    expect((await request("gh", ["pr", "merge", "7"])).status).toBe("pending");
  });
});

describe("decline on chat reply + cancel", () => {
  test("a chat message declines the waiting command with 'user replied instead'", async () => {
    const { t, projectId, conversationId, request } = await setup();
    const a = await request("npm", ["run", "test"]);
    const res = await t.mutation(internal.commandApprovals.declineWaiting, { projectId, conversationId, text: "pakai vitest aja" });
    expect(res.declined).toBe(1);
    const row = await t.query(internal.commandApprovals.get, { approvalId: a.approvalId as any });
    expect(row?.status).toBe("rejected");
    expect(row?.note).toBe("user replied instead: pakai vitest aja");
  });
  test("cancel closes a pending wait idempotently", async () => {
    const { t, request } = await setup();
    const a = await request("npm", ["run", "test"]);
    expect(await t.mutation(internal.commandApprovals.cancel, { approvalId: a.approvalId as any, reason: "paused" })).toEqual({ applied: true });
    expect(await t.mutation(internal.commandApprovals.cancel, { approvalId: a.approvalId as any, reason: "paused" })).toEqual({ applied: false });
  });
});

describe("shell.decisionsForProject", () => {
  test("lists this project's pending approvals and the pickup state", async () => {
    const { t, projectId, request } = await setup();
    await request("npm", ["run", "test"]);
    const res = await t.query(api.shell.decisionsForProject, { projectId });
    expect(res?.approvals).toHaveLength(1);
    expect(res?.approvals[0]).toMatchObject({ kind: "run_command", offerAlways: true, taskTitle: "Run tests" });
    expect(res?.pickup.workerOnline).toBe(false);
  });
});
