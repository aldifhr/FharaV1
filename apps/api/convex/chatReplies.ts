import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { assertProjectAccess, assertMessageAccess } from "./lib/authz";
import {
  CHAT_SWEEP_BATCH,
  REPLY_INTERRUPTED_TEXT,
  canClaimReply,
  isChatUserMessage,
  chatReplyStaleMs,
  type ReplyStatus,
} from "./lib/chat/replyLifecycle";
import { loadSettingValues } from "./appSettings";
import { insertChatUserMessage } from "./chatContext";
import { settingFrom } from "./lib/appSettings";
import { replyStopRequested as stopRequested } from "./lib/chat/replyStop";

/**
 * Chat reply lifecycle (t3code idea #1: durable effect with lease, settle and
 * sweeper; idea only). See lib/chat/replyLifecycle.ts for the rules.
 */

function newRunId(): string {
  return `reply_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Atomic "already replied?" check + claim. Two replyToChat runs scheduled for
 * the same message (double send, scheduler retry) race here; Convex
 * serializes the mutation, so exactly one gets `claimed: true` and the other
 * returns before it creates a single bubble.
 */
export const claimReply = internalMutation({
  args: { userMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.userMessageId);
    if (!message || message.authorType !== "user") return { claimed: false as const };
    const hasReply =
      message.replyStatus === undefined
        ? (await ctx.db
            .query("messages")
            .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", args.userMessageId))
            .first()) !== null
        : false;
    if (!canClaimReply({ replyStatus: message.replyStatus as ReplyStatus | undefined, hasReply })) {
      return { claimed: false as const };
    }
    const runId = newRunId();
    await ctx.db.patch(message._id, {
      replyStatus: "replying",
      replyRunId: runId,
      replyLeaseExpiresAt: Date.now() + chatReplyStaleMs(settingFrom(await loadSettingValues(ctx), "CHAT_REPLY_STALE_MS")),
      error: undefined,
    });
    return { claimed: true as const, runId };
  },
});

/** Mark still-streaming bubbles of one user message as interrupted. */
async function interruptBubbles(ctx: MutationCtx, userMessageId: Id<"messages">): Promise<number> {
  const replies = await ctx.db
    .query("messages")
    .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", userMessageId))
    .take(50);
  let n = 0;
  for (const reply of replies) {
    if (reply.streaming === true) {
      await ctx.db.patch(reply._id, { streaming: false, interrupted: true });
      n += 1;
    }
  }
  return n;
}

/**
 * Settle the claim when the run finishes or throws. Only the run that holds
 * the claim may settle it; a late settle after the sweeper already failed
 * the message is ignored.
 */
export const settleReply = internalMutation({
  args: {
    userMessageId: v.id("messages"),
    runId: v.string(),
    outcome: v.union(v.literal("answered"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.userMessageId);
    if (!message || message.replyRunId !== args.runId || message.replyStatus !== "replying") {
      return { applied: false as const };
    }
    if (args.outcome === "failed") await interruptBubbles(ctx, message._id);
    await ctx.db.patch(message._id, {
      replyStatus: args.outcome,
      replyLeaseExpiresAt: undefined,
      ...(args.outcome === "failed" ? { error: args.error ?? REPLY_INTERRUPTED_TEXT } : { error: undefined }),
    });
    return { applied: true as const };
  },
});

/**
 * Cron sweep (every 2 min). A reply action killed by the 10-minute Node
 * limit, a deploy or an OOM never runs its catch, so:
 * 1. bubbles still `streaming` past CHAT_REPLY_STALE_MS → interrupted;
 * 2. user messages still `replying` past their lease → failed;
 * 3. legacy chat rows parked as queueStatus "pending" (never claimed by
 *    anyone) leave the worker queue, so the "N pending" pickup line stops
 *    counting them.
 * Each step is a bounded batch; the next run continues.
 */
export const sweepStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleMs = chatReplyStaleMs(settingFrom(await loadSettingValues(ctx), "CHAT_REPLY_STALE_MS"));
    let interrupted = 0;
    let failed = 0;
    let dequeued = 0;

    const streaming = await ctx.db
      .query("messages")
      .withIndex("by_streaming", (q) => q.eq("streaming", true))
      .take(CHAT_SWEEP_BATCH);
    for (const bubble of streaming) {
      if (bubble._creationTime > now - staleMs) continue;
      await ctx.db.patch(bubble._id, { streaming: false, interrupted: true });
      interrupted += 1;
    }

    const replying = await ctx.db
      .query("messages")
      .withIndex("by_reply_status", (q) => q.eq("replyStatus", "replying"))
      .take(CHAT_SWEEP_BATCH);
    for (const message of replying) {
      const expiresAt = message.replyLeaseExpiresAt ?? message._creationTime + staleMs;
      if (expiresAt > now) continue;
      await interruptBubbles(ctx, message._id);
      await ctx.db.patch(message._id, {
        replyStatus: "failed",
        replyLeaseExpiresAt: undefined,
        error: REPLY_INTERRUPTED_TEXT,
      });
      failed += 1;
    }

    const legacy = await ctx.db
      .query("messages")
      .withIndex("by_queue", (q) => q.eq("queueStatus", "pending"))
      .take(CHAT_SWEEP_BATCH);
    for (const message of legacy) {
      if (!isChatUserMessage(message)) continue;
      const replied =
        (await ctx.db
          .query("messages")
          .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", message._id))
          .first()) !== null;
      await ctx.db.patch(message._id, {
        queueStatus: undefined,
        attempts: undefined,
        ...(replied && message.replyStatus === undefined ? { replyStatus: "answered" as const } : {}),
      });
      dequeued += 1;
    }
    return { interrupted, failed, dequeued };
  },
});


/**
 * "Reply interrupted — Retry": drop the dead bubbles of this message and run
 * the reply again with the routing it was sent with. Allowed only for a
 * failed reply (or a legacy message whose bubble was interrupted).
 */
export const retryReply = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    await assertMessageAccess(ctx, message);
    if (message.authorType !== "user") throw new Error("Only a user message can be retried");
    const replies = await ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", message._id))
      .take(50);
    const interruptedReplies = replies.filter((r) => r.interrupted === true);
    const retryable =
      message.replyStatus === "failed" || (message.replyStatus === undefined && interruptedReplies.length > 0);
    if (!retryable) return { retried: false as const };
    for (const reply of interruptedReplies) await ctx.db.delete(reply._id);
    await ctx.db.patch(message._id, {
      replyStatus: "pending",
      replyRunId: undefined,
      replyLeaseExpiresAt: undefined,
      error: undefined,
    });
    // The reply derives its scope from the conversation (plan 039): a
    // personal message has no projectId to pass.
    await ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
      ...(message.projectId ? { projectId: message.projectId } : {}),
      ...(message.conversationId ? { conversationId: message.conversationId } : {}),
      userMessageId: message._id,
      ...(message.replyOptions?.preferredAgentIds ? { preferredAgentIds: message.replyOptions.preferredAgentIds } : {}),
      ...(message.replyOptions?.permissionMode ? { permissionMode: message.replyOptions.permissionMode } : {}),
    });
    return { retried: true as const };
  },
});

/**
 * Continue button on a cut reply (lib/chat/continueReply.ts): posts a
 * "Continue" user message quoting the reply, and the reply run appends the
 * rest to that same message. Only for a reply that still carries `cutOff`.
 */
export const continueReply = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const reply = await ctx.db.get(args.messageId);
    if (!reply) throw new Error("Message not found");
    await assertMessageAccess(ctx, reply);
    if (reply.authorType !== "agent" || !reply.cutOff || reply.streaming || !reply.conversationId) {
      return { continued: false as const };
    }
    const userMessageId = await insertChatUserMessage(ctx, {
      ...(reply.projectId ? { projectId: reply.projectId } : {}),
      conversationId: reply.conversationId,
      content: "Continue",
      quotedMessageId: reply._id,
    });
    await ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
      ...(reply.projectId ? { projectId: reply.projectId } : {}),
      conversationId: reply.conversationId,
      userMessageId,
    });
    return { continued: true as const, userMessageId };
  },
});

/**
 * Composer Stop (lib/chat/replyStop.ts): stop the reply to one user message
 * while it is pending or streaming. Settles the message as "stopped" (the
 * run's later settle is a no-op), keeps streamed text in its bubble marked
 * `stopped`, and drops bubbles that had nothing yet. The running action sees
 * the flag on its next poll and aborts its LLM call; until then every write it
 * tries is refused (chatContext guards).
 */
export const stopReply = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    await assertMessageAccess(ctx, message);
    if (message.authorType !== "user") throw new Error("Only a reply to your message can be stopped");
    const replies = await ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", message._id))
      .take(50);
    const live = replies.filter((r) => r.streaming === true);
    const inFlight = message.replyStatus === "pending" || message.replyStatus === "replying" || live.length > 0;
    if (!inFlight || message.replyStatus === "stopped") return { stopped: false as const };
    for (const reply of live) {
      if (!reply.content.trim() && !reply.card) await ctx.db.delete(reply._id);
      else await ctx.db.patch(reply._id, { streaming: false, stopped: true });
    }
    await ctx.db.patch(message._id, { replyStatus: "stopped", replyLeaseExpiresAt: undefined, error: undefined });
    return { stopped: true as const };
  },
});

/** Polled by a running reply (lib/chat/replyRun.ts): should the run holding `runId` stop? */
export const replyStopRequested = internalQuery({
  args: { userMessageId: v.id("messages"), runId: v.string() },
  handler: async (ctx, args) => stopRequested(await ctx.db.get(args.userMessageId), args.runId),
});
