/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { INBOX_FAILED_WINDOW_MS } from "./inbox";

/**
 * Live test 4 (item 11b): sidebar Needs you = 1, bell = 0, Inbox = 17 at
 * the same moment, and a rejected approval stayed in Needs you ~10 min.
 * Every surface now reads one definition (shell.collectNeedsYou).
 */

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle" });
    const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle" });
    const projectId = await ctx.db.insert("projects", { name: "Live", workspacePath: "/tmp/l", agentIds: [cto, fe] });
    const otherId = await ctx.db.insert("projects", { name: "Demo", workspacePath: "/tmp/d" });
    const now = Date.now();
    // Pending apply-changes approval on an open task: needs you.
    const applyTask = await ctx.db.insert("tasks", { projectId, title: "Add slugify", command: "x", status: "needs_approval", updatedAt: now });
    const applyApproval = await ctx.db.insert("approvals", { taskId: applyTask, projectId, kind: "apply_changes", summary: "Apply changes to 2 file(s)", status: "pending", requestedByAgentId: fe });
    // Rejected approval, task still parked in needs_approval until a worker resumes it: NOT needs you.
    const rejectedTask = await ctx.db.insert("tasks", { projectId, title: "JSDoc comments", command: "x", status: "needs_approval", updatedAt: now - 10 });
    await ctx.db.insert("approvals", { taskId: rejectedTask, projectId, kind: "apply_changes", summary: "Apply JSDoc", status: "rejected", resolvedAt: now - 5 });
    // Agent question in another project: needs you.
    const askTask = await ctx.db.insert("tasks", { projectId: otherId, title: "Tone", command: "x", status: "waiting_input", pendingQuestion: "Formal or casual?", updatedAt: now - 20, assignedAgentIds: [cto] });
    // Leftover pending approval on a cancelled task: not actionable.
    const deadTask = await ctx.db.insert("tasks", { projectId, title: "Old", command: "x", status: "cancelled", updatedAt: now - 30 });
    await ctx.db.insert("approvals", { taskId: deadTask, projectId, kind: "git_push", summary: "Push old", status: "pending" });
    // Failed tasks: one recent, one ancient. Information only.
    const recentFail = await ctx.db.insert("tasks", { projectId: otherId, title: "Recent fail", command: "x", status: "failed", updatedAt: now - 1000 });
    await ctx.db.insert("tasks", { projectId: otherId, title: "Ancient fail", command: "x", status: "failed", updatedAt: now - INBOX_FAILED_WINDOW_MS - 60_000 });
    return { projectId, otherId, applyTask, applyApproval, rejectedTask, askTask, recentFail };
  });
  return { t, ...ids };
}

describe("one definition of 'needs you'", () => {
  test("sidebar, Overview, Inbox and project badges agree; the bell is the project's slice", async () => {
    const { t, projectId, otherId, applyApproval, askTask, rejectedTask, recentFail } = await seed();
    const needs = await t.query(api.shell.needsYou, {});
    expect(needs.total).toBe(2);
    expect(needs.items.map((i) => i.approvalId ?? i.taskId).sort()).toEqual([String(applyApproval), String(askTask)].sort());
    expect(needs.items.some((i) => i.taskId === rejectedTask)).toBe(false);

    const overview = await t.query(api.overview.get, {});
    expect(overview.needsYou.total).toBe(needs.total);
    // Failed tasks are listed apart and never counted.
    expect(overview.attentionTasks.map((x) => x.status)).toEqual(["failed", "failed"]);

    const inbox = await t.query(api.inbox.list, {});
    expect(inbox.waitingCount).toBe(needs.total);
    expect(inbox.approvals.map((a) => a._id)).toEqual([applyApproval]);
    expect(inbox.questions.map((q) => q.taskId)).toEqual([askTask]);
    expect(inbox.tasks.some((x) => x._id === rejectedTask)).toBe(false);
    expect(inbox.failed.map((x) => x._id)).toEqual([recentFail]);

    const bellLive = await t.query(api.shell.needsYou, { projectId });
    const bellDemo = await t.query(api.shell.needsYou, { projectId: otherId });
    expect(bellLive.items.map((i) => i.approvalId)).toEqual([applyApproval]);
    expect(bellDemo.items.map((i) => i.taskId)).toEqual([askTask]);
    expect(bellLive.total + bellDemo.total).toBe(needs.total);

    const counts = await t.query(api.shell.projectCounts, {});
    expect(counts[projectId as string]?.needsYou).toBe(1);
    expect(counts[otherId as string]?.needsYou).toBe(1);
  });

  test("rejecting an approval removes it from Needs you, the bell and Inbox at once", async () => {
    const { t, projectId, applyApproval, applyTask } = await seed();
    await t.mutation(api.approvals.reject, { approvalId: applyApproval });
    // The task is still needs_approval (the worker resumes it later)…
    const task = await t.run(async (ctx) => ctx.db.get(applyTask));
    expect(task?.status).toBe("needs_approval");
    // …but nothing lists it as waiting on the user any more.
    const needs = await t.query(api.shell.needsYou, {});
    expect(needs.items.some((i) => i.taskId === applyTask || i.approvalId === applyApproval)).toBe(false);
    expect((await t.query(api.shell.needsYou, { projectId })).total).toBe(0);
    const inbox = await t.query(api.inbox.list, {});
    expect(inbox.waitingCount).toBe(needs.total);
    expect(inbox.tasks.some((x) => x._id === applyTask)).toBe(false);
    expect((await t.query(api.overview.get, {})).needsYou.total).toBe(needs.total);
  });

  test("a legacy direct thread (removed 2026-11-12) is never a question, idle or asking", async () => {
    const { t, projectId, otherId } = await seed();
    const { idle, asking, fe } = await t.run(async (ctx) => {
      const fe = (await ctx.db.query("agents").collect()).find((a) => a.role === "frontend")!._id;
      const direct = { role: "frontend", agentId: fe, engine: "opencode-acp", status: "idle", lastSeq: 2, deliveredSeq: 2 } as const;
      const idle = await ctx.db.insert("tasks", { projectId, title: "Blurry header logo", command: "", status: "waiting_input", mode: "direct", direct, assignedAgentIds: [fe], updatedAt: Date.now() });
      const asking = await ctx.db.insert("tasks", { projectId: otherId, title: "Direct ask", command: "", status: "waiting_input", mode: "direct", direct, pendingQuestion: "Which logo file?", assignedAgentIds: [fe], updatedAt: Date.now() });
      return { idle, asking, fe };
    });
    const needs = await t.query(api.shell.needsYou, {});
    expect(needs.items.some((i) => i.taskId === idle)).toBe(false);
    expect(needs.items.some((i) => i.taskId === asking)).toBe(false);
    expect((await t.query(api.shell.needsYou, { projectId })).items.some((i) => i.taskId === idle)).toBe(false);
    const inbox = await t.query(api.inbox.list, {});
    expect(inbox.waitingCount).toBe(needs.total);
    expect(inbox.questions.some((q) => q.taskId === idle)).toBe(false);
    expect((await t.query(api.overview.get, {})).needsYou.total).toBe(needs.total);
    const counts = await t.query(api.shell.projectCounts, {});
    expect(counts[projectId as string]?.needsYou).toBe(1);
    const tray = await t.query(api.shell.decisionsForProject, { projectId });
    expect(tray!.questions.some((q) => q.taskId === idle)).toBe(false);
    const team = await t.query(api.shell.teamStatus, { projectId });
    expect(team[fe as string]?.status).not.toBe("needs_you");
  });

  test("a legacy needs_approval task with no approval rows still needs the user", async () => {
    const { t, otherId } = await seed();
    const legacy = await t.run(async (ctx) =>
      ctx.db.insert("tasks", { projectId: otherId, title: "Legacy draft", command: "x", status: "needs_approval", updatedAt: Date.now() })
    );
    const needs = await t.query(api.shell.needsYou, {});
    expect(needs.items.find((i) => i.taskId === legacy)?.kind).toBe("review");
    expect((await t.query(api.inbox.list, {})).waitingCount).toBe(needs.total);
  });
});
