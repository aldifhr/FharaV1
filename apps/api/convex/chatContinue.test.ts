/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * Interrupted replies and "continue" (live test 2026-11-11): a reply cut
 * mid-stream keeps its text as the message (marked cut off, no separate
 * error bubble), and "continue" / the Continue button streams the rest into
 * that same message from where it stopped.
 */

type Call = { system: string; history: { role: string; content: string }[] };
const llm = vi.hoisted(() => ({
  calls: [] as Array<{ system: string; history: { role: string; content: string }[] }>,
  replies: [] as Array<() => unknown>,
}));

vi.mock("./lib/chat/llm", async () => {
  const { ChatStreamError } = await import("./lib/chat/streamLimits");
  (globalThis as any).__ChatStreamError = ChatStreamError;
  return {
    getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
    resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
    completeWithAgent: async (system: string, history: Call["history"], _config: unknown, onChunk?: (c: { content: string; reasoning: string }) => void) => {
      llm.calls.push({ system, history });
      const next = llm.replies.shift();
      const out: any = next ? next() : { content: "ok", reasoning: "", reasoningDurationMs: 0 };
      onChunk?.({ content: out.content, reasoning: "" });
      return out;
    },
  };
});
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({
    intent: "ask",
    subtype: "explanation",
    requiresWorkspace: false,
    requiresExecution: false,
    confidence: 1,
    reasoning: "test",
  }),
  chooseAskResponder: async () => null,
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "" }));

const modules = import.meta.glob("./**/*.ts");

const PARTIAL = "Priority colors: Low = gray, Medium = amber. Each is always";
const cutStream = () => () => {
  const ChatStreamError = (globalThis as any).__ChatStreamError;
  throw new ChatStreamError("idle", "Reply stopped: the model went silent for 180s", { content: PARTIAL, reasoning: "" });
};
const answer = (content: string, extra: Record<string, unknown> = {}) => () => ({ content, reasoning: "", reasoningDurationMs: 0, ...extra });

async function setup() {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    return ctx.db.insert("projects", { name: "Task Management", workspacePath: "/tmp/p", agentIds: [ctoId] });
  });
  return { t, projectId };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const agentMessages = (t: T, conversationId: any) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect()).filter(
      (m) => m.authorType === "agent"
    )
  );

async function send(t: T, projectId: any, content: string) {
  const sent = await t.mutation(api.messages.send, { projectId, content });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return sent;
}

beforeEach(() => {
  llm.calls.length = 0;
  llm.replies.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

vi.setConfig({ testTimeout: 30_000 });

describe("cut replies", () => {
  test("a reply cut mid-stream keeps its text, marked interrupted, with no error bubble", async () => {
    const { t, projectId } = await setup();
    llm.replies.push(cutStream());
    const { conversationId, messageId } = await send(t, projectId, "apa itu design system?");
    const replies = await agentMessages(t, conversationId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      content: PARTIAL,
      streaming: false,
      cutOff: { kind: "interrupted", reason: "Reply stopped: the model went silent for 180s" },
    });
    expect(replies[0].content).not.toContain("couldn't reply");
    const user: any = await t.run((ctx) => ctx.db.get(messageId as any));
    expect(user.replyStatus).toBe("answered");
  });

  test("\"continue\" streams the rest into the same message from where it stopped", async () => {
    const { t, projectId } = await setup();
    llm.replies.push(cutStream());
    const { conversationId } = await send(t, projectId, "apa itu design system?");
    llm.replies.push(answer(" paired with an icon and a label."));
    await send(t, projectId, "continue");

    const replies = await agentMessages(t, conversationId);
    expect(replies.map((r) => r.content)).toEqual([`${PARTIAL} paired with an icon and a label.`]);
    expect(replies[0].content).toBe(`${PARTIAL} paired with an icon and a label.`);
    expect(replies[0].cutOff).toBeUndefined();
    expect(replies[0].streaming).toBe(false);

    const call = llm.calls.at(-1)!;
    const roles = call.history.map((m) => m.role);
    expect(roles.slice(-2)).toEqual(["assistant", "user"]);
    expect(call.history.at(-2)!.content).toBe(PARTIAL);
    expect(call.history.at(-1)!.content).toContain("from exactly where it stopped");
    expect(call.history.at(-3)).toMatchObject({ role: "user", content: "apa itu design system?" });
    expect(call.history.some((m) => m.content === "continue")).toBe(false);
  });

  test("the Continue button resumes the cut reply, and a cut continuation can be continued again", async () => {
    const { t, projectId } = await setup();
    llm.replies.push(cutStream());
    const { conversationId } = await send(t, projectId, "apa itu design system?");
    const [cut] = await agentMessages(t, conversationId);

    llm.replies.push(answer(" paired with an icon", { truncated: true }));
    const res = await t.mutation(api.chatReplies.continueReply, { messageId: cut._id });
    expect(res.continued).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let [reply] = await agentMessages(t, conversationId);
    expect(reply.content).toBe(`${PARTIAL} paired with an icon`);
    expect(reply.cutOff).toEqual({ kind: "truncated", reason: "Reply stopped: the model reached its output limit" });

    llm.replies.push(answer(" and a label."));
    await t.mutation(api.chatReplies.continueReply, { messageId: cut._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const all = await agentMessages(t, conversationId);
    expect(all).toHaveLength(1);
    [reply] = all;
    expect(reply.content).toBe(`${PARTIAL} paired with an icon and a label.`);
    expect(reply.cutOff).toBeUndefined();
    // A finished reply cannot be "continued" again.
    expect((await t.mutation(api.chatReplies.continueReply, { messageId: cut._id })).continued).toBe(false);
  });

  test("a reply that ends at the output limit is kept and marked truncated", async () => {
    const { t, projectId } = await setup();
    llm.replies.push(answer("| Feature | Deferred |\n| Kanban", { truncated: true }));
    const { conversationId } = await send(t, projectId, "apa itu design system?");
    const [reply] = await agentMessages(t, conversationId);
    expect(reply.content).toBe("| Feature | Deferred |\n| Kanban");
    expect(reply.cutOff).toMatchObject({ kind: "truncated" });
  });

  test("\"continue\" after a finished reply is an ordinary message", async () => {
    const { t, projectId } = await setup();
    llm.replies.push(answer("Selesai."));
    const { conversationId } = await send(t, projectId, "apa itu design system?");
    llm.replies.push(answer("Lanjut ke mana?"));
    await send(t, projectId, "continue");
    const replies = await agentMessages(t, conversationId);
    expect(replies.map((r) => r.content)).toEqual(["Selesai.", "Lanjut ke mana?"]);
  });
});
