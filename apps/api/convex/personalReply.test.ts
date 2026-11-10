/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_CHAT_REPLY_STALE_MS } from "./lib/chat/replyLifecycle";

/**
 * Plan 039 PC3: the personal reply path (QA scenarios 2, 3, 8, 12-safety).
 * The LLM is scripted; every call's system prompt and messages are kept so
 * the tests can check what each agent saw.
 */

type Call = { system: string; msgs: { role: string; content: string }[] };
const calls: Call[] = [];
let script: Array<string | ((call: Call) => string)> = [];
const classifyCalls: unknown[] = [];

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m", provider: "openai-compatible" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async (
    system: string,
    msgs: { role: string; content: string }[],
    _config: unknown,
    onChunk?: (c: { content: string; reasoning: string }) => void
  ) => {
    const call = { system, msgs: msgs.map((m) => ({ ...m })) };
    calls.push(call);
    const next = script.length > 1 ? script.shift()! : script[0] ?? "ok";
    const content = typeof next === "function" ? next(call) : next;
    onChunk?.({ content, reasoning: "" });
    return { content, reasoning: "", reasoningDurationMs: 0 };
  },
}));
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async (...a: unknown[]) => {
    classifyCalls.push(a);
    return { intent: "ask", subtype: "research", requiresWorkspace: false, requiresExecution: false, confidence: 1, reasoning: "t" };
  },
  chooseAskResponder: async () => null,
}));
const snapshotReads: string[] = [];
vi.mock("./lib/chat/repoSnapshot", () => ({
  readRepoSnapshot: async (p: string) => {
    snapshotReads.push(p);
    return "apps/\npackages/";
  },
}));

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "Ada", role: "CTO", status: "idle", isEnabled: true });
    const qaId = await ctx.db.insert("agents", { name: "Quinn", role: "QA", status: "idle", isEnabled: true });
    const secId = await ctx.db.insert("agents", { name: "Sec", role: "Security", status: "idle", isEnabled: true });
    // A real project with a workspace and a live worker exists: a personal
    // chat must still never touch it.
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/repo", agentIds: [ctoId, qaId, secId] });
    await ctx.db.insert("workers", {
      workerId: "w1",
      capacity: 1,
      activeTasks: 0,
      status: "online",
      lastHeartbeatAt: Date.now(),
      capabilities: ["repoTools"],
    });
    return { ctoId, qaId, secId, projectId };
  });
  return { t, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function say(s: Setup, conversationId: Id<"conversations">, content: string) {
  const { messageId } = await s.t.mutation(api.messages.sendInConversation, { conversationId, content });
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  const replies = await s.t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as Id<"messages">)).collect()
  );
  const user = await s.t.run((ctx) => ctx.db.get(messageId as Id<"messages">));
  return { replies, user, messageId: messageId as Id<"messages"> };
}

beforeEach(() => {
  calls.length = 0;
  classifyCalls.length = 0;
  snapshotReads.length = 0;
  script = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("personal reply", () => {
  test("QA 2: the CTO answers alone; reply has no project; message settles answered", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ["Hi! What are we thinking about today?"];
    const { replies, user } = await say(s, conv, "I want to think through our hiring plan");
    expect(user?.replyStatus).toBe("answered");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ agentId: s.ctoId, conversationId: conv, streaming: false, content: "Hi! What are we thinking about today?" });
    expect(replies[0].projectId).toBeUndefined();
    expect(replies[0].taskOffer).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("personal one-to-one chat");
    expect(calls[0].system).toContain("No project, repository or workspace is attached");
    expect(calls[0].system).not.toContain("## Repo tools");
    // No intent classifier, no snapshot row, no workspace read.
    expect(classifyCalls).toHaveLength(0);
    expect(snapshotReads).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("contextSnapshots").collect())).toHaveLength(0);
  });

  test("QA 3: QA's history holds none of the CTO's messages", async () => {
    const s = await setup();
    const cto = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    const qa = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.qaId });
    script = ["cto answer"];
    await say(s, cto, "secret CTO topic: acquisition");
    calls.length = 0;
    script = ["qa answer"];
    await say(s, qa, "what should we test first?");
    expect(calls).toHaveLength(1);
    const seen = [calls[0].system, ...calls[0].msgs.map((m) => m.content)].join("\n");
    expect(seen).not.toContain("acquisition");
    expect(seen).not.toContain("cto answer");
    expect(calls[0].msgs.map((m) => m.content)).toContain("what should we test first?");
    const ctx = await s.t.query(internal.chatContext.getPersonalContext, { conversationId: qa });
    expect(ctx.history.map((h) => h.content)).toEqual(["what should we test first?", "qa answer"]);
    expect(ctx.agents.map((a) => a._id)).toEqual([s.qaId]);
  });

  test("CTO personal chat never pre-routes or hands off; @mentions stay plain text", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ["Here is my take on XSS in the login form."];
    const { replies } = await say(s, conv, "Is there an XSS or injection security risk in the login form? @Sec what do you think?");
    expect(replies).toHaveLength(1);
    expect(replies[0].agentId).toBe(s.ctoId);
    expect(replies[0].toolSteps ?? []).toEqual([]);
    expect(replies[0].handoffFromAgentId).toBeUndefined();
  });

  test("QA 8: a repo tool call makes no repoToolCalls row and reads no project path", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = ['{"tool":"read_file","arguments":{"path":"package.json"}}', "I can't read files here: attach a project to this chat first."];
    const { replies } = await say(s, conv, "read package.json and tell me the scripts");
    expect(await s.t.run((ctx) => ctx.db.query("repoToolCalls").collect())).toHaveLength(0);
    expect(snapshotReads).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0].content).not.toMatch(/"tool"\s*:/);
    expect(replies[0].checkedFiles).toBeUndefined();
    // Rows are deleted after each call, so also check no call was made.
    expect(replies[0].toolSteps ?? []).toEqual([]);
    expect(replies[0].reasoning ?? "").not.toMatch(/worker|Checked/);
  });

  test("QA 8: /task and 'kerjakan' are refused with the fixed sentence and create no task", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    const en = await say(s, conv, "/task build the login page");
    expect(en.replies).toHaveLength(1);
    expect(en.replies[0].content).toMatch(/personal chat with no project attached/);
    expect(en.replies[0].projectId).toBeUndefined();
    const id = await say(s, conv, "kerjakan perbaikan bug login");
    expect(id.replies[0].content).toMatch(/chat pribadi tanpa proyek/);
    const go = await say(s, conv, "gas");
    expect(go.replies).toHaveLength(1);
    expect(await s.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
    expect(calls.length).toBe(1); // only the bare "gas" reached the model
    const all = await s.t.query(api.messages.listByConversation, { conversationId: conv });
    expect(all.every((m) => m.projectId === undefined)).toBe(true);
    expect(all.some((m) => m.taskOffer)).toBe(false);
  });

  test("a disabled agent gets a plain note instead of a reply", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.qaId });
    await s.t.run((ctx) => ctx.db.patch(s.qaId, { isEnabled: false }));
    const { replies, user } = await say(s, conv, "hello?");
    expect(user?.replyStatus).toBe("answered");
    expect(replies[0].content).toMatch(/disabled or retired/);
    expect(calls).toHaveLength(0);
  });

  test("an LLM failure posts the error bubble; Retry runs the reply again", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    script = [() => { throw new Error("provider down"); }];
    const first = await say(s, conv, "ping");
    expect(first.replies.map((r) => r.content).join(" ")).toMatch(/couldn't reply \(provider down\)/);
    await s.t.run((ctx) => ctx.db.patch(first.messageId, { replyStatus: "failed" }));
    script = ["pong"];
    const res = await s.t.mutation(api.chatReplies.retryReply, { messageId: first.messageId });
    expect(res.retried).toBe(true);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const replies = await s.t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", first.messageId)).collect()
    );
    expect(replies.map((r) => r.content)).toContain("pong");
  });

  test("the stale sweep interrupts a dead personal bubble", async () => {
    const s = await setup();
    const conv = await s.t.mutation(api.conversations.getOrCreatePersonal, { agentId: s.ctoId });
    const bubble = await s.t.run((ctx) =>
      ctx.db.insert("messages", { conversationId: conv, agentId: s.ctoId, authorType: "agent", content: "", streaming: true })
    );
    vi.setSystemTime(Date.now() + DEFAULT_CHAT_REPLY_STALE_MS + 1_000);
    const res = await s.t.mutation(internal.chatReplies.sweepStale, {});
    expect(res.interrupted).toBe(1);
    expect((await s.t.run((ctx) => ctx.db.get(bubble)))?.interrupted).toBe(true);
  });
});
