/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { canClaimReply } from "./lib/chat/replyLifecycle";

/**
 * Composer Stop (chatReplies.stopReply + lib/chat/replyStop.ts): the reply
 * settles as "stopped", its bubbles freeze, the running action aborts its
 * LLM call on the next poll and ends quietly, and nothing it tries to write
 * afterwards lands.
 */

const hooks: { onCall?: () => Promise<void>; sawSignal: boolean; calls: number } = { sawSignal: false, calls: 0 };

vi.mock("./lib/chat/llm", async () => {
  const { ChatStoppedError } = await import("./lib/chat/replyStop");
  return {
    getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
    resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
    // Streams a first chunk, lets the test press Stop, then hangs until the
    // reply's stop signal aborts it (the real client rejects the same way).
    completeWithAgent: async (_s: string, _m: unknown, _c: unknown, onChunk?: (c: { content: string; reasoning: string }) => void, opts?: { signal?: AbortSignal }) => {
      hooks.calls += 1;
      hooks.sawSignal = Boolean(opts?.signal);
      onChunk?.({ content: "Partial answer", reasoning: "" });
      await hooks.onCall?.();
      const signal = opts?.signal;
      if (!signal) return { content: "Full answer.", reasoning: "", reasoningDurationMs: 0 };
      return await new Promise((_, reject) => {
        if (signal.aborted) reject(new ChatStoppedError());
        signal.addEventListener("abort", () => reject(new ChatStoppedError()), { once: true });
      });
    },
  };
});
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({ intent: "ask", subtype: "explanation", requiresWorkspace: false, requiresExecution: false, confidence: 1, reasoning: "test" }),
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "" }));

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [ctoId] });
    const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: Date.now(), lastMessageAt: Date.now() });
    return { ctoId, projectId, conversationId };
  });
  return { t, ...ids };
}
type T = Awaited<ReturnType<typeof setup>>["t"];
const get = (t: T, id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
const repliesTo = (t: T, id: any) =>
  t.run((ctx) => ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", id)).collect()) as Promise<any[]>;

async function replying(t: T, projectId: any, conversationId: any) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "halo", replyStatus: "replying", replyRunId: "run1" } as any);
    const said = await ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "Half a sen", replyToMessageId: userId, streaming: true } as any);
    const empty = await ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "", replyToMessageId: userId, streaming: true } as any);
    return { userId, said, empty };
  });
}

describe("stopReply", () => {
  test("settles the message as stopped, keeps streamed text, drops empty bubbles", async () => {
    const { t, projectId, conversationId } = await setup();
    const { userId, said, empty } = await replying(t, projectId, conversationId);
    expect(await t.mutation(api.chatReplies.stopReply, { messageId: userId })).toEqual({ stopped: true });
    const user = await get(t, userId);
    expect(user.replyStatus).toBe("stopped");
    expect(user.error).toBeUndefined();
    const bubble = await get(t, said);
    expect(bubble).toMatchObject({ streaming: false, stopped: true, content: "Half a sen" });
    expect(bubble.interrupted).toBeUndefined();
    expect(await get(t, empty)).toBeNull();
    // A second press does nothing.
    expect(await t.mutation(api.chatReplies.stopReply, { messageId: userId })).toEqual({ stopped: false });
  });

  test("a pending reply (not claimed yet) is stopped before it starts", async () => {
    const { t, projectId, conversationId } = await setup();
    const userId = await t.run((ctx) => ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "x", replyStatus: "pending" } as any));
    expect((await t.mutation(api.chatReplies.stopReply, { messageId: userId })).stopped).toBe(true);
    expect((await t.mutation(internal.chatReplies.claimReply, { userMessageId: userId })).claimed).toBe(false);
    expect(canClaimReply({ replyStatus: "stopped", hasReply: false })).toBe(false);
  });

  test("nothing to stop: answered, failed, or an agent message", async () => {
    const { t, projectId, conversationId } = await setup();
    for (const replyStatus of ["answered", "failed"]) {
      const id = await t.run((ctx) => ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "x", replyStatus } as any));
      expect((await t.mutation(api.chatReplies.stopReply, { messageId: id })).stopped).toBe(false);
    }
    const agentId = await t.run((ctx) => ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "x" } as any));
    await expect(t.mutation(api.chatReplies.stopReply, { messageId: agentId })).rejects.toThrow(/Only a reply/);
  });

  test("a late run writes nothing after Stop: no new bubble, patch, tool step, or failed settle", async () => {
    const { t, projectId, conversationId } = await setup();
    const { userId, said } = await replying(t, projectId, conversationId);
    await t.mutation(api.chatReplies.stopReply, { messageId: userId });
    await t.mutation(internal.chatContext.updateStreamingAgentMessage, { messageId: said, content: "Half a sentence and more", streaming: true, taskOffer: { kind: "write" } });
    await t.mutation(internal.chatContext.appendToolStep, { messageId: said, step: { tool: "read", ok: true, at: 1 } });
    const bubble = await get(t, said);
    expect(bubble).toMatchObject({ content: "Half a sen", streaming: false });
    expect(bubble.taskOffer).toBeUndefined();
    expect(bubble.toolSteps).toBeUndefined();
    expect(await t.mutation(internal.chatContext.insertAgentMessage, { projectId, conversationId, content: "late", replyToMessageId: userId })).toBeNull();
    expect(await t.mutation(internal.chatContext.insertSystemLine, { projectId, conversationId, content: "Sent to Backend", replyToMessageId: userId })).toBeNull();
    await expect(t.mutation(internal.chatContext.createStreamingAgentMessage, { projectId, conversationId, replyToMessageId: userId })).rejects.toThrow(/stopped/);
    expect((await t.mutation(internal.chatReplies.settleReply, { userMessageId: userId, runId: "run1", outcome: "failed", error: "x" })).applied).toBe(false);
    expect((await get(t, userId)).replyStatus).toBe("stopped");
    expect((await repliesTo(t, userId)).length).toBe(1);
    expect(await t.query(internal.chatReplies.replyStopRequested, { userMessageId: userId, runId: "run1" })).toBe(true);
  });
});

describe("replyToChat with Stop", () => {
  test("the running reply aborts its LLM call and ends quietly as stopped", async () => {
    const { t, projectId } = await setup();
    const { messageId, conversationId } = await t.mutation(api.messages.send, { projectId, content: "apa itu convex?" });
    hooks.calls = 0;
    hooks.onCall = async () => {
      hooks.onCall = undefined;
      expect(await t.query(internal.chatReplies.replyStopRequested, { userMessageId: messageId as any, runId: (await get(t, messageId)).replyRunId })).toBe(false);
      await t.mutation(api.chatReplies.stopReply, { messageId: messageId as any });
    };
    const startedAt = Date.now();
    // Resolves (no throw): a stopped reply is not a failure.
    await t.action(internal.chat.replyToChat, { projectId, conversationId: conversationId as any, userMessageId: messageId as any });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(hooks.sawSignal).toBe(true);
    const user = await get(t, messageId);
    expect(user.replyStatus).toBe("stopped");
    expect(user.error).toBeUndefined();
    // No failure bubble and no answer after the stop.
    const replies = await repliesTo(t, messageId);
    expect(replies.every((r) => r.streaming !== true)).toBe(true);
    expect(replies.some((r) => /Full answer|couldn't|could not/i.test(r.content))).toBe(false);
  });
});
