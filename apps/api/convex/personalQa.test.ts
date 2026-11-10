/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

/**
 * Plan 039 PC6: end-to-end QA checks across the personal chat lifecycle
 * (create, talk, attach, task, new chat) that the per-phase suites leave
 * between them. QA scenario map: personal-chat audit §12.1.
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

describe("personal chat lifecycle (PC6)", () => {
  test("D1 across the lifecycle: no message in the chat ever carries a project, and the project timeline never shows one", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ["before attach"];
    await say(s, conv, "hello before");
    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    script = ["after attach"];
    await say(s, conv, "hello after");
    await say(s, conv, "/task add a readiness probe");
    const rows = await s.t.query(api.messages.listByConversation, { conversationId: conv });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((m) => m.projectId === undefined)).toBe(true);
    const projectTimeline = await s.t.query(api.messages.listByProject, { projectId: s.projectId });
    const ids = new Set(rows.map((m) => String(m._id)));
    expect(projectTimeline.some((m) => ids.has(String(m._id)))).toBe(false);
    expect(projectTimeline.some((m) => m.conversationId === conv)).toBe(false);
  });

  test("New chat: the old one closes (send and attach refused, history kept), the list points at the fresh one", async () => {
    const s = await setup();
    const first = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.qaId });
    script = ["qa answer"];
    await say(s, first, "check the login page");
    const second = await s.t.mutation(api.conversations.startNewPersonal, { agentId: s.qaId });
    expect(second).not.toBe(first);
    await expect(s.t.mutation(api.messages.sendInConversation, { conversationId: first, content: "again" })).rejects.toThrow(/closed/);
    await expect(s.t.mutation(api.conversations.attachProject, { conversationId: first, projectId: s.otherId })).rejects.toThrow(/closed/);
    expect((await s.t.query(api.messages.listByConversation, { conversationId: first })).map((m) => m.content)).toContain("check the login page");
    expect(await s.t.query(api.messages.listByConversation, { conversationId: second })).toEqual([]);
    expect(await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.qaId })).toBe(second);
    const list = await s.t.query(api.conversations.listPersonal, {});
    expect(list.find((r) => r.agent._id === s.qaId)?.conversationId).toBe(second);
  });

  test("header and list data for the UI: kind, attached project name, label inputs", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    const before = await s.t.query(api.conversations.get, { conversationId: conv });
    expect(before).toMatchObject({ kind: "personal", project: null, projectAttachedAt: null, status: "active" });
    expect(before?.agent).toMatchObject({ agentId: s.ctoId, name: "Ada" });
    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    const after = await s.t.query(api.conversations.get, { conversationId: conv });
    expect(after).toMatchObject({ kind: "personal", project: { _id: s.projectId, name: "Fhara" } });
    const list = await s.t.query(api.conversations.listPersonal, {});
    expect(list.find((r) => r.agent._id === s.ctoId)?.projectName).toBe("Fhara");
    expect(list.find((r) => r.agent._id === s.qaId)?.conversationId).toBeNull();
  });

  test("a task can't borrow a personal chat attached to another project", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    await s.t.mutation(api.conversations.attachProject, { conversationId: conv, projectId: s.projectId });
    await expect(
      s.t.mutation(api.tasks.createFromCommand, { projectId: s.otherId, command: "do it", conversationId: conv })
    ).rejects.toThrow(/does not belong to this project/);
    expect(await s.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
  });
});
