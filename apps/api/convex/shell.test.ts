/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { runningWord } from "./shell";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle" });
    const qa = await ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle" });
    const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle" });
    const be = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle" });
    const projectId = await ctx.db.insert("projects", { name: "Shedi", workspacePath: "/tmp/s", agentIds: [cto, qa, fe, be] });
    const otherId = await ctx.db.insert("projects", { name: "Iqbola", workspacePath: "/tmp/i" });
    const ownedId = await ctx.db.insert("projects", { name: "Secret", workspacePath: "/tmp/x", ownerId: "someone-else" });
    const now = Date.now();
    const pushTask = await ctx.db.insert("tasks", { projectId, title: "Build pricing A", command: "x", status: "needs_approval", updatedAt: now, assignedAgentIds: [fe] });
    const approvalId = await ctx.db.insert("approvals", { taskId: pushTask, projectId, kind: "git_push", summary: "Push pricing A to shedi v1", status: "pending", requestedByAgentId: fe });
    const askTask = await ctx.db.insert("tasks", { projectId, title: "Refund email", command: "x", status: "waiting_input", pendingQuestion: "Which tone?", assignedAgentIds: [cto], updatedAt: now - 1000 });
    const lonelyApproval = await ctx.db.insert("tasks", { projectId: otherId, title: "Ledger fix", command: "x", status: "needs_approval", updatedAt: now - 2000 });
    const secretTask = await ctx.db.insert("tasks", { projectId: ownedId, title: "Hidden", command: "x", status: "waiting_input", pendingQuestion: "?" });
    await ctx.db.insert("approvals", { taskId: secretTask, projectId: ownedId, kind: "git_push", summary: "Hidden push", status: "pending" });
    const runTask = await ctx.db.insert("tasks", { projectId, title: "QA pass", command: "x", status: "running" });
    const qaSub = await ctx.db.insert("subtasks", { taskId: runTask, projectId, key: "qa-1", title: "QA", description: "", kind: "qa", capability: "qa", dependencies: [], order: 1, status: "running", attempts: 1 });
    await ctx.db.insert("executions", { taskId: runTask, projectId, subtaskId: qaSub, subtaskKey: "qa-1", agentId: qa, agentName: "QA", capability: "qa", workerId: "w1", status: "running", attempt: 1, createdAt: now });
    const otherRun = await ctx.db.insert("tasks", { projectId: otherId, title: "Ledger API", command: "x", status: "running" });
    await ctx.db.insert("executions", { taskId: otherRun, projectId: otherId, agentId: be, agentName: "Backend", capability: "code", workerId: "w1", status: "running", attempt: 1, createdAt: now });
    await ctx.db.insert("workers", { workerId: "w1", capacity: 3, activeTasks: 2, status: "online", lastHeartbeatAt: now });
    await ctx.db.insert("workers", { workerId: "stale", capacity: 4, activeTasks: 4, status: "online", lastHeartbeatAt: now - 10 * 60_000 });
    await ctx.db.insert("tokenUsage", { projectId, agentName: "CTO", model: "claude-sonnet", inputTokens: 1000, outputTokens: 500, createdAt: now - 1000 });
    await ctx.db.insert("tokenUsage", { projectId, agentName: "CTO", model: "gpt-x", inputTokens: 10, outputTokens: 10, createdAt: now - 1000 });
    await ctx.db.insert("tokenUsage", { projectId, agentName: "CTO", model: "claude-sonnet", inputTokens: 99999, outputTokens: 0, createdAt: now - 30 * 86_400_000 });
    await ctx.db.insert("tokenUsage", { projectId: ownedId, agentName: "CTO", model: "claude-sonnet", inputTokens: 77777, outputTokens: 0, createdAt: now - 1000 });
    return { cto, qa, fe, be, projectId, otherId, pushTask, approvalId, askTask, lonelyApproval, now };
  });
  return { t, ...ids };
}

describe("shell.needsYou", () => {
  test("merges approvals, questions and approval-less tasks; hides other owners", async () => {
    const { t, approvalId, askTask, lonelyApproval, pushTask } = await seed();
    const { items, total } = await t.query(api.shell.needsYou, {});
    expect(total).toBe(3);
    const push = items.find((i) => i.approvalId === approvalId)!;
    expect(push).toMatchObject({ kind: "push", title: "Push pricing A to shedi v1", agentRole: "frontend", projectName: "Shedi" });
    const question = items.find((i) => i.taskId === askTask)!;
    expect(question).toMatchObject({ kind: "question", title: "Which tone?", agentRole: "cto" });
    // A needs_approval task already covered by its approval is not doubled.
    expect(items.filter((i) => i.taskId === pushTask)).toHaveLength(1);
    expect(items.find((i) => i.taskId === lonelyApproval)?.kind).toBe("review");
    expect(items.some((i) => i.title.includes("Hidden"))).toBe(false);
  });
});

describe("shell.teamStatus", () => {
  test("derives per-agent words from executions, approvals and questions", async () => {
    const { t, projectId, qa, fe, cto, be } = await seed();
    const status = await t.query(api.shell.teamStatus, { projectId });
    expect(status[qa as string]?.status).toBe("testing");
    expect(status[fe as string]?.status).toBe("waiting_on_you");
    expect(status[cto as string]?.status).toBe("needs_you");
    expect(status[be as string]).toMatchObject({ status: "elsewhere", projectName: "Iqbola" });
  });

  test("runningWord maps subtask kinds", () => {
    expect(runningWord("review", "code")).toBe("reviewing");
    expect(runningWord("qa", "x")).toBe("testing");
    expect(runningWord("code_change", "frontend")).toBe("working");
    expect(runningWord(undefined, "code", "review-2")).toBe("reviewing");
  });
});

describe("shell.needsYou task pushes", () => {
  test("lists ready and failed task pushes, not requested/pushed ones or other owners", async () => {
    const { t, projectId, otherId } = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const task = await ctx.db.insert("tasks", { projectId, title: "Dark mode", command: "x", status: "done" });
      const otherTask = await ctx.db.insert("tasks", { projectId: otherId, title: "Ledger push", command: "x", status: "done" });
      const hidden = await ctx.db.insert("projects", { name: "Nope", workspacePath: "/tmp/n", ownerId: "someone-else" });
      const hiddenTask = await ctx.db.insert("tasks", { projectId: hidden, title: "Hidden push task", command: "x", status: "done" });
      const base = { branchName: "fhara/t", commitSha: "a".repeat(40), commitMessage: "m", filesChanged: 3, attempts: 0, createdAt: now, updatedAt: now };
      const ready = await ctx.db.insert("taskPushes", { ...base, taskId: task, projectId, status: "ready" });
      const failed = await ctx.db.insert("taskPushes", { ...base, taskId: otherTask, projectId: otherId, status: "failed", error: "denied" });
      await ctx.db.insert("taskPushes", { ...base, taskId: task, projectId, status: "pushed" });
      await ctx.db.insert("taskPushes", { ...base, taskId: task, projectId, status: "requested", requestedAt: now });
      await ctx.db.insert("taskPushes", { ...base, taskId: hiddenTask, projectId: hidden, status: "ready" });
      return { ready, failed };
    });
    const { items, total } = await t.query(api.shell.needsYou, {});
    expect(total).toBe(5);
    expect(items.find((i) => i.key === `push:${ids.ready}`)).toMatchObject({ kind: "push", title: "Push Dark mode", note: "3 files ready" });
    expect(items.find((i) => i.key === `push:${ids.failed}`)).toMatchObject({ kind: "push", note: "push failed" });
    expect(items.some((i) => i.title.includes("Hidden"))).toBe(false);
    const counts = await t.query(api.shell.projectCounts, {});
    expect(counts[projectId as string].needsYou).toBe(3);
    // The failed push + the approval-less "Ledger fix" task: the badge now
    // uses the same definition as the Needs you list (live test 4).
    expect(counts[otherId as string].needsYou).toBe(2);
  });
});

describe("shell.projectCounts", () => {
  test("counts open tasks and needs-you per visible project", async () => {
    const { t, projectId, otherId } = await seed();
    const counts = await t.query(api.shell.projectCounts, {});
    expect(counts[projectId as string]).toEqual({ open: 3, needsYou: 2 });
    // "Ledger fix" (needs_approval, no approval rows) is in Needs you, so it counts here too.
    expect(counts[otherId as string]).toEqual({ open: 2, needsYou: 1 });
    expect(Object.keys(counts)).toHaveLength(2);
  });
});

describe("shell.usage", () => {
  test("sums this week's visible tokens and live worker slots", async () => {
    const { t, now } = await seed();
    const usage = await t.query(api.shell.usage, { since: now - 7 * 86_400_000 });
    expect(usage.totalTokens).toBe(1520);
    expect(usage.topModel).toBe("claude-sonnet");
    expect(usage.slots).toEqual({ busy: 2, total: 3, workers: 1 });
    expect(usage.budget).toBeNull();
  });

  test("clamps an ancient cursor to the last 8 days", async () => {
    const { t } = await seed();
    const usage = await t.query(api.shell.usage, { since: 0 });
    expect(usage.totalTokens).toBe(1520);
  });
});

describe("pins.listForProject", () => {
  test("returns only pinned messages of the project via the index", async () => {
    const { t, projectId, otherId } = await seed();
    const ids = await t.run(async (ctx) => {
      const a = await ctx.db.insert("messages", { projectId, authorType: "user", content: "pin me", pinned: true });
      await ctx.db.insert("messages", { projectId, authorType: "user", content: "not pinned" });
      await ctx.db.insert("messages", { projectId: otherId, authorType: "user", content: "other", pinned: true });
      return { a };
    });
    const pins = await t.query(api.pins.listForProject, { projectId });
    expect(pins.map((p) => p._id)).toEqual([ids.a]);
    await t.mutation(api.messages.togglePin, { messageId: ids.a, pinned: false });
    expect(await t.query(api.pins.listForProject, { projectId })).toHaveLength(0);
  });
});
