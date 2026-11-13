/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Regression lane (regress-tests): context isolation per conversation type.
 *
 * What reaches a chat prompt is `chatContext.getContext` (project chat) or
 * `chatContext.getPersonalContext` (personal chat): history + the latest
 * context summary. Invariants pinned here:
 *
 *  - history and summaries come ONLY from the conversation being answered:
 *    never another project conversation, a personal chat, a task thread, or
 *    a conversation of another project;
 *  - history is anchored to the message being answered (nothing newer);
 *  - a busy sibling conversation cannot push this conversation's history out
 *    of the window (it is read by conversation, not by project);
 *  - task-thread input (steer / answers) is delivered only to its own task.
 */

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function world() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const otherProjectId = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
    const agentId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const convA = await ctx.db.insert("conversations", { projectId, kind: "project", status: "active", createdAt: 1 });
    const convB = await ctx.db.insert("conversations", { projectId, kind: "project", status: "active", createdAt: 2 });
    const convQ = await ctx.db.insert("conversations", { projectId: otherProjectId, kind: "project", status: "active", createdAt: 3 });
    const personalX = await ctx.db.insert("conversations", { kind: "personal", agentId, status: "active", createdAt: 4 });
    const personalY = await ctx.db.insert("conversations", { kind: "personal", agentId, status: "active", createdAt: 5 });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T1", command: "do t1", status: "running" });
    const otherTaskId = await ctx.db.insert("tasks", { projectId, title: "T2", command: "do t2", status: "running" });
    return { projectId, otherProjectId, agentId, convA, convB, convQ, personalX, personalY, taskId, otherTaskId };
  });
  await t.mutation(api.projects.updateTeam, { projectId: ids.projectId, agentIds: [ids.agentId] });
  return { t, ...ids };
}

type MessageFields = {
  projectId?: Id<"projects">;
  conversationId?: Id<"conversations">;
  taskId?: Id<"tasks">;
  authorType?: "user" | "agent";
};

function say(t: T, content: string, fields: MessageFields): Promise<Id<"messages">> {
  return t.run((ctx) =>
    ctx.db.insert("messages", { authorType: fields.authorType ?? "user", content, ...fields } as never)
  ) as Promise<Id<"messages">>;
}

function summarize(t: T, conversationId: Id<"conversations">, projectId: Id<"projects"> | undefined, summary: string, at: number) {
  return t.run((ctx) =>
    ctx.db.insert("contextSummaries", {
      conversationId,
      ...(projectId ? { projectId } : {}),
      summary,
      lastCompactAt: at,
      summaryCharCount: summary.length,
      messageCountBefore: 1,
    } as never)
  );
}

const texts = (history: Array<{ content: string }>) => history.map((m) => m.content);

describe("project chat: history and summary come only from the answered conversation", () => {
  test("other conversations, personal chats and task threads never enter the prompt", async () => {
    const w = await world();
    await say(w.t, "A1 user", { projectId: w.projectId, conversationId: w.convA });
    await say(w.t, "B1 secret from conversation B", { projectId: w.projectId, conversationId: w.convB });
    await say(w.t, "T1 thread reply", { projectId: w.projectId, taskId: w.taskId });
    await say(w.t, "X1 personal secret", { conversationId: w.personalX });
    await say(w.t, "Q1 other project", { projectId: w.otherProjectId, conversationId: w.convQ });
    await say(w.t, "A2 agent", { projectId: w.projectId, conversationId: w.convA, authorType: "agent" });
    await summarize(w.t, w.convA, w.projectId, "summary of A", 10);
    await summarize(w.t, w.convB, w.projectId, "summary of B (newer)", 20);
    await summarize(w.t, w.personalX, undefined, "summary of personal X (newest)", 30);

    const ctx = await w.t.query(internal.chatContext.getContext, { projectId: w.projectId, conversationId: w.convA });
    expect(texts(ctx.history)).toEqual(["A1 user", "A2 agent"]);
    expect(ctx.contextSummary).toBe("summary of A");
  });

  test("history is anchored to the message being answered", async () => {
    const w = await world();
    await say(w.t, "first", { projectId: w.projectId, conversationId: w.convA });
    const anchor = await say(w.t, "the question being answered", { projectId: w.projectId, conversationId: w.convA });
    await say(w.t, "a newer message sent while the reply was queued", { projectId: w.projectId, conversationId: w.convA });

    const ctx = await w.t.query(internal.chatContext.getContext, {
      projectId: w.projectId,
      conversationId: w.convA,
      userMessageId: anchor,
    });
    expect(texts(ctx.history)).toEqual(["first", "the question being answered"]);
  });

  test("a busy sibling conversation cannot push this conversation's history out of the window", async () => {
    const w = await world();
    await say(w.t, "A old but still recent for A", { projectId: w.projectId, conversationId: w.convA });
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert("messages", { projectId: w.projectId, conversationId: w.convB, authorType: "user", content: `B${i}` });
      }
    });
    const ctx = await w.t.query(internal.chatContext.getContext, { projectId: w.projectId, conversationId: w.convA });
    expect(texts(ctx.history)).toEqual(["A old but still recent for A"]);
  });

  test("a conversation of another project yields no history and no summary", async () => {
    const w = await world();
    await say(w.t, "Q secret", { projectId: w.otherProjectId, conversationId: w.convQ });
    await summarize(w.t, w.convQ, w.otherProjectId, "summary of Q", 10);
    const ctx = await w.t.query(internal.chatContext.getContext, { projectId: w.projectId, conversationId: w.convQ });
    expect(ctx.history).toEqual([]);
    expect(ctx.contextSummary).toBeUndefined();
  });

  test("the no-conversation fallback never reads personal chats or task threads", async () => {
    const w = await world();
    await say(w.t, "legacy project line", { projectId: w.projectId });
    await say(w.t, "T1 thread reply", { projectId: w.projectId, taskId: w.taskId });
    await say(w.t, "X1 personal secret", { conversationId: w.personalX });
    const ctx = await w.t.query(internal.chatContext.getContext, { projectId: w.projectId });
    expect(texts(ctx.history)).toEqual(["legacy project line"]);
    expect(ctx.contextSummary).toBeUndefined();
  });
});

describe("personal chat: one conversation, one agent", () => {
  test("another personal chat with the same agent, project chat and task threads stay out", async () => {
    const w = await world();
    await say(w.t, "X1", { conversationId: w.personalX });
    await say(w.t, "Y1 other personal chat", { conversationId: w.personalY });
    await say(w.t, "A1 project chat", { projectId: w.projectId, conversationId: w.convA });
    await say(w.t, "T1 thread", { projectId: w.projectId, taskId: w.taskId });
    const anchor = await say(w.t, "X2 answered", { conversationId: w.personalX });
    await say(w.t, "X3 newer", { conversationId: w.personalX });
    await summarize(w.t, w.personalX, undefined, "summary of X", 10);
    await summarize(w.t, w.personalY, undefined, "summary of Y (newer)", 20);
    await summarize(w.t, w.convA, w.projectId, "summary of A (newest)", 30);

    const ctx = await w.t.query(internal.chatContext.getPersonalContext, { conversationId: w.personalX, userMessageId: anchor });
    expect(texts(ctx.history)).toEqual(["X1", "X2 answered"]);
    expect(ctx.contextSummary).toBe("summary of X");
    expect(ctx.activeTask).toBeNull();
  });

  test("a project conversation id is not answered as a personal chat", async () => {
    const w = await world();
    await say(w.t, "A1 project chat", { projectId: w.projectId, conversationId: w.convA });
    const ctx = await w.t.query(internal.chatContext.getPersonalContext, { conversationId: w.convA });
    expect(ctx.history).toEqual([]);
    expect(ctx.agents).toEqual([]);
  });
});

describe("task threads and agent-to-agent hand-offs", () => {
  test("a steer for one task is delivered only to that task", async () => {
    const w = await world();
    await w.t.mutation(api.tasks.steerTask, { taskId: w.taskId, instruction: "use the blue button" });
    const own = await w.t.query(internal.orchestration.listPendingTaskInputs, { taskId: w.taskId });
    const other = await w.t.query(internal.orchestration.listPendingTaskInputs, { taskId: w.otherTaskId });
    expect(own.map((row) => row.text)).toEqual(["use the blue button"]);
    expect(other).toEqual([]);
  });

  test("compaction reads only the conversation it summarizes", async () => {
    const w = await world();
    await say(w.t, "A1", { projectId: w.projectId, conversationId: w.convA });
    await say(w.t, "B1 secret", { projectId: w.projectId, conversationId: w.convB });
    await say(w.t, "T1 thread", { projectId: w.projectId, taskId: w.taskId, conversationId: w.convA });
    await say(w.t, "A2", { projectId: w.projectId, conversationId: w.convA, authorType: "agent" });
    const rows = await w.t.query(internal.messages.getConversationHistoryForCompaction, {
      projectId: w.projectId,
      conversationId: w.convA,
    });
    expect(texts(rows)).toEqual(["A1", "A2"]);
  });

  test("the task's shared context (delegation hand-offs) is read by task id only", async () => {
    const w = await world();
    const base = { objective: "o", status: "running" as const, decisions: [], artifacts: [], outstandingIssues: [] };
    await w.t.mutation(internal.orchestration.upsertTaskContext, { ...base, taskId: w.taskId, projectId: w.projectId, originalRequest: "T1 secret request" });
    await w.t.mutation(internal.orchestration.upsertTaskContext, { ...base, taskId: w.otherTaskId, projectId: w.projectId, originalRequest: "T2 request" });
    const other = await w.t.query(internal.orchestration.getTaskContext, { taskId: w.otherTaskId });
    expect(other?.originalRequest).toBe("T2 request");
    expect(JSON.stringify(other)).not.toContain("T1 secret");
  });
});
