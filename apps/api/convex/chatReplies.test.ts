/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  DEFAULT_CHAT_REPLY_STALE_MS,
  MIN_CHAT_REPLY_STALE_MS,
  canClaimReply,
  chatReplyStaleMs,
  isChatUserMessage,
  replyFailureText,
} from "./lib/chat/replyLifecycle";

/**
 * Durable chat replies (t3code idea #1): the user message carries its reply
 * lifecycle, a run claims it atomically, settles it answered/failed, and the
 * cron sweep settles runs that died without running their catch.
 */

const llm = { fail: false, calls: 0 };

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
  // Throws outside the reply's own try/catch, like a crash mid-run.
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => {
    if (llm.fail) throw new Error("upstream 502\nstack…");
    return global;
  },
  completeWithAgent: async () => {
    llm.calls += 1;
    return { content: "Jawabannya di sini.", reasoning: "", reasoningDurationMs: 0 };
  },
}));
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({
    intent: "ask",
    subtype: "explanation",
    requiresWorkspace: false,
    requiresExecution: false,
    confidence: 1,
    reasoning: "test",
  }),
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "" }));

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [ctoId] });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      status: "active",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });
    return { ctoId, projectId, conversationId };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

async function userMessage(t: T, projectId: any, conversationId: any, extra: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "halo", replyStatus: "pending", ...extra } as any)
  );
}

const get = (t: T, id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;

beforeEach(() => {
  llm.fail = false;
  llm.calls = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.CHAT_REPLY_STALE_MS;
});

describe("replyLifecycle helpers", () => {
  test("stale threshold defaults above the 10-minute Node action cap and clamps low values", () => {
    expect(chatReplyStaleMs(undefined)).toBe(DEFAULT_CHAT_REPLY_STALE_MS);
    expect(chatReplyStaleMs("")).toBe(DEFAULT_CHAT_REPLY_STALE_MS);
    expect(chatReplyStaleMs("abc")).toBe(DEFAULT_CHAT_REPLY_STALE_MS);
    expect(chatReplyStaleMs("60000")).toBe(MIN_CHAT_REPLY_STALE_MS);
    expect(chatReplyStaleMs(String(30 * 60_000))).toBe(30 * 60_000);
    expect(MIN_CHAT_REPLY_STALE_MS).toBeGreaterThan(10 * 60_000);
  });

  test("claim rules", () => {
    expect(canClaimReply({ replyStatus: "pending", hasReply: false })).toBe(true);
    expect(canClaimReply({ replyStatus: "replying", hasReply: false })).toBe(false);
    expect(canClaimReply({ replyStatus: "answered", hasReply: false })).toBe(false);
    expect(canClaimReply({ replyStatus: "failed", hasReply: false })).toBe(false);
    expect(canClaimReply({ replyStatus: undefined, hasReply: false })).toBe(true);
    expect(canClaimReply({ replyStatus: undefined, hasReply: true })).toBe(false);
  });

  test("failure text is one line, never empty", () => {
    expect(replyFailureText(new Error("boom\nat x"))).toBe("boom");
    expect(replyFailureText(undefined)).toMatch(/stopped/);
    expect(isChatUserMessage({ authorType: "user", conversationId: "c" })).toBe(true);
    expect(isChatUserMessage({ authorType: "user", conversationId: "c", taskId: "t" })).toBe(false);
    expect(isChatUserMessage({ authorType: "agent", conversationId: "c" })).toBe(false);
  });
});

describe("claimReply / settleReply", () => {
  test("only one run claims a message (double schedule cannot double-reply)", async () => {
    const { t, projectId, conversationId } = await setup();
    const id = await userMessage(t, projectId, conversationId);
    const first = await t.mutation(internal.chatReplies.claimReply, { userMessageId: id });
    const second = await t.mutation(internal.chatReplies.claimReply, { userMessageId: id });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect((await get(t, id)).replyStatus).toBe("replying");
  });

  test("legacy message that already has a reply cannot be claimed", async () => {
    const { t, projectId, conversationId } = await setup();
    const id = await userMessage(t, projectId, conversationId, { replyStatus: undefined });
    await t.run((ctx) => ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "x", replyToMessageId: id }));
    expect((await t.mutation(internal.chatReplies.claimReply, { userMessageId: id })).claimed).toBe(false);
  });

  test("settle failed interrupts live bubbles; a stale run id is ignored", async () => {
    const { t, projectId, conversationId } = await setup();
    const id = await userMessage(t, projectId, conversationId);
    const claim: any = await t.mutation(internal.chatReplies.claimReply, { userMessageId: id });
    const bubble = await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "par", replyToMessageId: id, streaming: true })
    );
    expect((await t.mutation(internal.chatReplies.settleReply, { userMessageId: id, runId: "other", outcome: "answered" })).applied).toBe(false);
    await t.mutation(internal.chatReplies.settleReply, { userMessageId: id, runId: claim.runId, outcome: "failed", error: "x" });
    const msg = await get(t, id);
    expect(msg.replyStatus).toBe("failed");
    expect(msg.error).toBe("x");
    const b = await get(t, bubble);
    expect(b.streaming).toBe(false);
    expect(b.interrupted).toBe(true);
  });
});

describe("replyToChat settles the user message", () => {
  test("answered after a successful reply (no longer stuck pending)", async () => {
    const { t, projectId } = await setup();
    const { messageId } = await t.mutation(api.messages.send, { projectId, content: "apa itu convex?" });
    expect((await get(t, messageId)).replyStatus).toBe("pending");
    expect((await get(t, messageId)).queueStatus).toBeUndefined();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const msg = await get(t, messageId);
    expect(msg.replyStatus).toBe("answered");
    expect(llm.calls).toBeGreaterThan(0);
  });

  test("a second scheduled run for the same message does nothing", async () => {
    const { t, projectId } = await setup();
    const { messageId, conversationId } = await t.mutation(api.messages.send, { projectId, content: "apa itu convex?" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const before = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as any)).collect()
    );
    await t.action(internal.chat.replyToChat, { projectId, conversationId: conversationId as any, userMessageId: messageId as any });
    const after = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as any)).collect()
    );
    expect(after.length).toBe(before.length);
  });

  test("failed when the run throws; Retry runs it again and answers", async () => {
    const { t, projectId } = await setup();
    llm.fail = true;
    const { messageId } = await t.mutation(api.messages.send, { projectId, content: "apa itu convex?" });
    await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
    const failed = await get(t, messageId);
    expect(failed.replyStatus).toBe("failed");
    expect(failed.error).toBeTruthy();
    expect(failed.error).not.toContain("\n");

    llm.fail = false;
    const res = await t.mutation(api.chatReplies.retryReply, { messageId: messageId as any });
    expect(res.retried).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await get(t, messageId)).replyStatus).toBe("answered");
  });
});

describe("sweepStale cron", () => {
  test("stale bubble → interrupted, dead claim → failed, fresh rows untouched", async () => {
    const { t, projectId, conversationId } = await setup();
    const staleUser = await userMessage(t, projectId, conversationId, {
      replyStatus: "replying",
      replyRunId: "r",
      replyLeaseExpiresAt: Date.now() - 1,
    });
    const staleBubble = await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "", replyToMessageId: staleUser, streaming: true })
    );
    const liveUser = await userMessage(t, projectId, conversationId, {
      replyStatus: "replying",
      replyRunId: "s",
      replyLeaseExpiresAt: Date.now() + 60_000,
    });
    // The stale bubble's creation time is "now"; jump past the threshold.
    vi.setSystemTime(Date.now() + DEFAULT_CHAT_REPLY_STALE_MS + 1_000);
    const liveBubble = await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "", replyToMessageId: liveUser, streaming: true })
    );
    await t.run((ctx) => ctx.db.patch(liveUser, { replyLeaseExpiresAt: Date.now() + 60_000 }));
    const res = await t.mutation(internal.chatReplies.sweepStale, {});
    expect(res.interrupted).toBe(1);
    expect(res.failed).toBe(1);
    expect((await get(t, staleUser)).replyStatus).toBe("failed");
    expect((await get(t, staleBubble)).interrupted).toBe(true);
    expect((await get(t, liveUser)).replyStatus).toBe("replying");
    expect((await get(t, liveBubble)).streaming).toBe(true);
  });

  test("legacy chat rows leave the worker queue; the pickup count ignores chat rows", async () => {
    const { t, projectId, conversationId } = await setup();
    const answered = await userMessage(t, projectId, conversationId, { replyStatus: undefined, queueStatus: "pending" });
    await t.run((ctx) => ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "x", replyToMessageId: answered }));
    await userMessage(t, projectId, conversationId, { replyStatus: undefined, queueStatus: "pending" });
    const queued = await t.run((ctx) => ctx.db.insert("messages", { projectId, authorType: "user", content: "q", queueStatus: "pending" }));

    const before = await t.query(api.shell.decisionsForProject, { projectId });
    expect(before!.pickup.pendingMessages).toBe(1);

    const res = await t.mutation(internal.chatReplies.sweepStale, {});
    expect(res.dequeued).toBe(2);
    expect((await get(t, answered)).replyStatus).toBe("answered");
    expect((await get(t, answered)).queueStatus).toBeUndefined();
    expect((await get(t, queued)).queueStatus).toBe("pending");
  });
});

describe("retryReply", () => {
  test("refuses a reply that did not fail", async () => {
    const { t, projectId, conversationId } = await setup();
    const id = await userMessage(t, projectId, conversationId, { replyStatus: "answered" });
    expect((await t.mutation(api.chatReplies.retryReply, { messageId: id })).retried).toBe(false);
  });

  test("drops interrupted bubbles and resets to pending", async () => {
    const { t, projectId, conversationId } = await setup();
    const id = await userMessage(t, projectId, conversationId, { replyStatus: "failed", error: "x" });
    const dead = await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "par", replyToMessageId: id, interrupted: true })
    );
    await t.mutation(api.chatReplies.retryReply, { messageId: id });
    expect(await get(t, dead)).toBeNull();
    const msg = await get(t, id);
    expect(msg.replyStatus).toBe("pending");
    expect(msg.error).toBeUndefined();
  });
});
