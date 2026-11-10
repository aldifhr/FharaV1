/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { taskCardConversationId } from "./lib/conversationScope";

/**
 * Plan 039 PC4: attaching a project to a personal chat (QA scenarios 6, 7,
 * 9, 10) and what the next turn gets from it.
 */

type Call = { system: string; msgs: { role: string; content: string }[] };
const calls: Call[] = [];
let script: string[] = [];

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m", provider: "openai-compatible" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async (
    system: string,
    msgs: { role: string; content: string }[],
    _config: unknown,
    onChunk?: (c: { content: string; reasoning: string }) => void
  ) => {
    calls.push({ system, msgs: msgs.map((m) => ({ ...m })) });
    const content = script.length > 1 ? script.shift()! : script[0] ?? "ok";
    onChunk?.({ content, reasoning: "" });
    return { content, reasoning: "", reasoningDurationMs: 0 };
  },
}));
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({ intent: "ask", subtype: "research", requiresWorkspace: false, requiresExecution: false, confidence: 1, reasoning: "t" }),
  chooseAskResponder: async () => null,
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "apps/\npackages/" }));

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const ctoId = await ctx.db.insert("agents", { name: "Ada", role: "CTO", status: "idle", isEnabled: true });
    const qaId = await ctx.db.insert("agents", { name: "Quinn", role: "QA", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", { name: "Fhara", workspacePath: "/repo", agentIds: [ctoId] });
    const otherId = await ctx.db.insert("projects", { name: "Other", workspacePath: "/other", agentIds: [ctoId, qaId] });
    await ctx.db.insert("memories", {
      scope: "project",
      projectId,
      title: "Stack",
      content: "PROJECT-MEMORY: we deploy on Fridays only",
      pinned: true,
      source: "user",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workers", {
      workerId: "w1",
      capacity: 1,
      activeTasks: 0,
      status: "online",
      lastHeartbeatAt: now,
      capabilities: ["repoTools"],
    });
    return { ctoId, qaId, projectId, otherId };
  });
  return { t, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function say(s: Setup, conversationId: Id<"conversations">, content: string) {
  const { messageId } = await s.t.mutation(api.messages.sendInConversation, { conversationId, content });
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  return s.t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as Id<"messages">)).collect()
  );
}

beforeEach(() => {
  calls.length = 0;
  script = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("attachProject", () => {
  test("QA 6 + 7: attaches once, keeps every message, schedules nothing, writes an audit row", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ["first answer"];
    await say(s, conv, "first question");
    const before = await s.t.query(api.messages.listByConversation, { conversationId: conv });
    const scheduledBefore = (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;

    const res = await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    expect(res).toEqual({ attached: true, projectId: s.projectId });

    const after = await s.t.query(api.messages.listByConversation, { conversationId: conv });
    expect(after.map((m) => [m._id, m.content, m.replyStatus])).toEqual(before.map((m) => [m._id, m.content, m.replyStatus]));
    expect(after.every((m) => m.projectId === undefined)).toBe(true);
    expect((await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length).toBe(scheduledBefore);

    const row = await s.t.run((ctx) => ctx.db.get(conv));
    expect(row).toMatchObject({ _id: conv, kind: "personal", projectId: s.projectId });
    expect(row?.projectAttachedAt).toBeGreaterThan(0);
    const header = await s.t.query(api.conversations.get, { conversationId: conv });
    expect(header?.project).toEqual({ _id: s.projectId, name: "Fhara" });
    const audit = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "conversation.attach_project" && a.projectId === s.projectId)).toBe(true);
    const parts = await s.t.run((ctx) =>
      ctx.db.query("conversationParticipants").withIndex("by_conversation", (q) => q.eq("conversationId", conv)).collect()
    );
    expect(parts.map((p) => p.projectId)).toEqual([s.projectId]);

    // Same project again: no-op. Another project: refused (D3).
    expect(await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId })).toEqual({
      attached: false,
      projectId: s.projectId,
    });
    await expect(s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.otherId })).rejects.toThrow(
      /already attached to Fhara/
    );
    // Still personal: project chat never picks it up.
    const active = await s.t.query(api.conversations.getActive, { projectId: s.projectId });
    expect(active?.conversation._id ?? null).not.toBe(conv);
  });

  test("QA 10: missing project, non-member agent, project chats and owned projects are refused", async () => {
    const s = await setup();
    const qaConv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.qaId });
    await expect(s.t.mutation(api.conversations.attachProject, { conversationId: qaConv, projectId: s.projectId })).rejects.toThrow(
      /Add Quinn to this project's team first/
    );
    const gone = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", { name: "Gone", workspacePath: "/gone" });
      await ctx.db.delete(id);
      return id;
    });
    await expect(s.t.mutation(api.conversations.attachProject, { conversationId: qaConv, projectId: gone })).rejects.toThrow(
      /Project not found/
    );
    const project = await s.t.mutation(api.messages.send, { projectId: s.projectId, content: "hi team" });
    await expect(
      s.t.mutation(api.conversations.attachProject, { conversationId: project.conversationId as Id<"conversations">, projectId: s.otherId })
    ).rejects.toThrow(/Only a personal chat/);
    const owned = await s.t.run((ctx) =>
      ctx.db.insert("projects", { name: "Owned", workspacePath: "/owned", ownerId: "someone-else", agentIds: [s.qaId] })
    );
    await expect(s.t.mutation(api.conversations.attachProject, { conversationId: qaConv, projectId: owned })).rejects.toThrow(
      /Unauthorized/
    );
    expect((await s.t.run((ctx) => ctx.db.get(qaConv)))?.projectId).toBeUndefined();
  });

  test("QA 9: after attach the next turn gets project memory, the snapshot and repo tools on that project", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ["before"];
    await say(s, conv, "hello");
    expect(calls[0].system).not.toContain("PROJECT-MEMORY");
    expect(calls[0].system).not.toContain("## Repo tools");
    expect(calls[0].system).toContain("## Personal chat");
    expect(calls[0].system).not.toContain("Grounding rule");

    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    calls.length = 0;
    script = ['{"tool":"read_file","arguments":{"path":"package.json"}}', "It has build and test scripts."];
    const replies = await say(s, conv, "what scripts does package.json have?");
    expect(calls[0].system).toContain('attached to project "Fhara"');
    expect(calls[0].system).toContain("PROJECT-MEMORY");
    expect(calls[0].system).toContain("## Repo tools");
    // Attached: the repo grounding rule is back, personal mode is off.
    expect(calls[0].system).toContain("Grounding rule");
    expect(calls[0].system).not.toContain("## Personal chat");
    expect(calls[0].system).toContain("apps/");
    // The call went to the worker queue (rows are deleted after each call;
    // no worker answers here, so it is recorded as an unclaimed read).
    expect(replies).toHaveLength(1);
    expect(replies[0].toolSteps?.map((step) => step.tool)).toContain("read_file");
    expect(replies[0].reasoning ?? "").toMatch(/worker tidak merespons/);
    // The reply itself still carries no project (D1); its snapshot does.
    expect(replies[0].projectId).toBeUndefined();
    const snaps = await s.t.run((ctx) => ctx.db.query("contextSnapshots").collect());
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.every((x) => x.projectId === s.projectId && x.conversationId === conv)).toBe(true);
  });

  test("QA 9 / D5: /task after attach creates a task in that project from this chat", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    const replies = await say(s, conv, "/task add a health check endpoint");
    const tasks = await s.t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ projectId: s.projectId, conversationId: conv });
    const card = replies.find((r) => r.card?.kind === "assignment");
    expect(card?.taskId).toBe(tasks[0]._id);
    expect(card?.projectId).toBeUndefined();
    expect(calls).toHaveLength(0);
    // Stage cards of that task stay out of the personal chat (D1).
    expect((await s.t.run((ctx) => taskCardConversationId(ctx, conv))) ?? null).toBeNull();
    const projectConv = (await s.t.mutation(api.messages.send, { projectId: s.projectId, content: "x" })).conversationId as Id<"conversations">;
    expect(await s.t.run((ctx) => taskCardConversationId(ctx, projectConv))).toBe(projectConv);
  });

  test("CTO reply to a work request after attach offers Create task; never before", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ["Here is a plan."];
    const loose = await say(s, conv, "add a dark mode toggle to the settings page");
    expect(loose[0].taskOffer).toBeUndefined();
    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    const attached = await say(s, conv, "add a dark mode toggle to the settings page");
    expect(attached[0].taskOffer).toBeDefined();
    expect(await s.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
  });

  test("project delete detaches the chat; the next turn has no project again", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    await s.t.mutation(api.projects.remove, { projectId: s.projectId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = await s.t.run((ctx) => ctx.db.get(conv));
    expect(row?.projectId).toBeUndefined();
    calls.length = 0;
    script = ["no project now"];
    await say(s, conv, "still there?");
    expect(calls[0].system).toContain("No project, repository or workspace is attached");
  });
});
