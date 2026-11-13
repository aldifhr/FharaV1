import { query, mutation, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { declineWaitingCommands } from "./commandApprovals";
import { ensureChatConversation } from "./conversations";
import { insertChatUserMessage } from "./chatContext";
import {
  assertConversationAccess,
  assertMessageAccess,
  assertProjectAccess,
  getAccessibleConversation,
  getVisibleTask,
} from "./lib/authz";
import { isPersonalConversation } from "./lib/conversationShape";
import { internal } from "./_generated/api";
import { permissionModeValidator } from "./lib/permissionModes";
import { invokedSkillsField } from "./lib/invokedSkillsSchema";
import { assertInvokedSkills } from "./lib/chat/invokedSkills";
import { projectTeamIds } from "./lib/projectTeam";
import { syncConversationThread } from "./lib/threadIndex";
import { pageSize, turnPreview, TURN_OUTLINE_SCAN_MAX } from "./lib/historyPaging";

export const listByProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    // Newest N, returned oldest-first: `.order("asc").take(n)` returned the
    // OLDEST n rows, so chats past the cap stopped showing new replies.
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 500, 1), 1000));
    return newest.reverse();
  },
});

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    // Newest 500, returned oldest-first (see listByProject).
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(500);
    return newest.reverse();
  },
});

/** Pin/unpin one message. Pins are project-scoped; the header chip count
 *  reads listPinned for the active conversation (or the project). */
export const togglePin = mutation({
  args: { messageId: v.id("messages"), pinned: v.boolean() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    await assertMessageAccess(ctx, message);
    await ctx.db.patch(message._id, { pinned: args.pinned });
    return true;
  },
});

/** Pinned messages for one project (optionally scoped to a conversation),
 *  newest first, for the header pin chip. */
export const listPinned = query({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(1000);
    return rows
      .filter(
        (row) =>
          row.pinned === true &&
          (!args.conversationId || row.conversationId === args.conversationId)
      )
      .slice(0, 100);
  },
});

/**
 * Scoped retrieval of a conversation's context summaries: latest first,
 * bounded by a `beforeCreationTime` cursor. The index `by_conversation`
 * keeps reads indexed — no `.collect()` + JS filter — and the cursor
 * supports incremental backward loading.
 */
export const getContextSummaries = internalQuery({
  args: {
    projectId: v.id("projects"),
    conversationId: v.id("conversations"),
    cursor: v.optional(v.number()), // last seen lastCompactAt
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const base = ctx.db
      .query("contextSummaries")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId));
    let q = base;
    if (args.cursor !== undefined) {
      q = q.filter((q) => q.lt(q.field("lastCompactAt"), args.cursor!));
    }
    return await q.order("desc").take(args.limit ?? 10);
  },
});

export const getLatestContextSummary = internalQuery({
  args: {
    projectId: v.id("projects"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db
      .query("contextSummaries")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

export const insertContextSummary = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    projectId: v.id("projects"),
    summary: v.string(),
    lastCompactAt: v.number(),
    summaryCharCount: v.number(),
    messageCountBefore: v.number(),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db.insert("contextSummaries", args);
  },
});

export const getConversationHistoryForCompaction = internalQuery({
  args: {
    projectId: v.id("projects"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);
    const eligible = rows
      .filter((m) => !m.taskId && m.conversationId === args.conversationId)
      .reverse()
      .map((m) => ({ authorType: m.authorType, content: m.content }));
    return eligible;
  },
});

export const claimNextMessage = internalMutation({
  args: {
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? 60000;
    const candidates = await ctx.db
      .query("messages")
      .withIndex("by_queue", (q) => q.eq("queueStatus", "pending"))
      .order("asc")
      .take(25);
    // Empty candidate set on a fresh deploy (no queueStatus rows yet) is
    // normal: claim returns null and the worker keeps polling.
    if (candidates.length === 0) return null;
    // Claim ordering: projectId order (deterministic; the caller can
    // assert `projectId` ascending), and within a project, oldest first.
    candidates.sort((a, b) => {
      const pa = a.projectId ?? "";
      const pb = b.projectId ?? "";
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a._creationTime - b._creationTime;
    });
    const candidate = candidates.find(
      (c) => c.queueStatus === "pending" && (c.leaseExpiresAt === undefined || c.leaseExpiresAt < now)
    );
    if (!candidate) return null;
    await ctx.db.patch(candidate._id, {
      queueStatus: "claimed",
      leasedBy: args.workerId,
      leaseExpiresAt: now + leaseMs,
      attempts: (candidate.attempts ?? 0) + 1,
      error: undefined,
    });
    return await ctx.db.get(candidate._id);
  },
});

export const completeMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    workerId: v.string(),
  },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg) return { applied: false as const };
    // Only the claiming worker may complete; stale leases are reclaimed
    // first by recoverStaleMessages.
    if (msg.queueStatus !== "claimed" || msg.leasedBy !== args.workerId) {
      return { applied: false as const };
    }
    await ctx.db.patch(msg._id, {
      queueStatus: "done",
      leasedBy: undefined,
      leaseExpiresAt: undefined,
    });
    return { applied: true as const };
  },
});

export const failMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    workerId: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg) return { applied: false as const };
    if (msg.queueStatus !== "claimed" || msg.leasedBy !== args.workerId) {
      return { applied: false as const };
    }
    const attempts = msg.attempts ?? 0;
    const next = attempts >= 3 ? "failed" : "pending";
    await ctx.db.patch(msg._id, {
      queueStatus: next as "failed" | "pending",
      leasedBy: undefined,
      leaseExpiresAt: undefined,
      error: args.error,
    });
    return { applied: true as const, next };
  },
});

export const retryMessage = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg) return { applied: false as const };
    if (msg.queueStatus !== "failed") return { applied: false as const };
    await ctx.db.patch(msg._id, {
      queueStatus: "pending",
      leasedBy: undefined,
      leaseExpiresAt: undefined,
      error: undefined,
    });
    return { applied: true as const };
  },
});

export const cancelMessage = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg) return { applied: false as const };
    if (msg.queueStatus === "done" || msg.queueStatus === "cancelled") {
      return { applied: false as const };
    }
    await ctx.db.patch(msg._id, {
      queueStatus: "cancelled",
      leasedBy: undefined,
      leaseExpiresAt: undefined,
    });
    return { applied: true as const };
  },
});

export const recoverStaleMessages = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("messages")
      .withIndex("by_queue", (q) => q.eq("queueStatus", "claimed"))
      .collect();
    let requeued = 0;
    let failed = 0;
    for (const m of stale) {
      if (m.leaseExpiresAt !== undefined && m.leaseExpiresAt < now) {
        const attempts = m.attempts ?? 0;
        if (attempts >= 3) {
          await ctx.db.patch(m._id, {
            queueStatus: "failed",
            leasedBy: undefined,
            leaseExpiresAt: undefined,
            error: "stale lease exceeded retry bound",
          });
          failed++;
        } else {
          await ctx.db.patch(m._id, {
            queueStatus: "pending",
            leasedBy: undefined,
            leaseExpiresAt: undefined,
          });
          requeued++;
        }
      }
    }
    return { requeued, failed };
  },
});

/** Longest client message id accepted (a UUID is 36). */
export const CLIENT_ID_MAX = 100;

export function normalizeClientId(raw: string | undefined): string | undefined {
  const id = raw?.trim();
  if (!id) return undefined;
  if (id.length > CLIENT_ID_MAX) throw new Error("clientId is too long");
  return id;
}

/**
 * Send a chat message. One mutation (t3code idea #2, idea only): the access
 * check, conversation, user row, "user replied instead" decline and the
 * reply schedule commit together, which also lets the web draw the bubble
 * optimistically. `clientId` makes it idempotent: a retried or
 * double-submitted send with the same id returns the existing row and
 * schedules nothing.
 */
export const send = mutation({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    conversationId: v.optional(v.id("conversations")),
    /** Plan 020: permission mode for a task this message dispatches. */
    permissionMode: v.optional(permissionModeValidator),
    /** Chat "Reply": the earlier message this one quotes. */
    quotedMessageId: v.optional(v.id("messages")),
    /** Composer-generated id for dedupe + optimistic reconcile. */
    clientId: v.optional(v.string()),
    /** Paradev C3: "/<skill> [request]" — skills the reply inlines for this turn. */
    invokedSkills: invokedSkillsField,
  },
  handler: async (ctx, args): Promise<{ messageId: string; conversationId: string; deduped: boolean }> => {
    // Authorization (core H5): owned projects require their owner; open
    // projects stay open (local single-user mode). Without this anyone could
    // post into any project and trigger paid LLM replies there.
    await assertProjectAccess(ctx, args.projectId);
    if (!args.content.trim()) throw new Error("Message is required");
    const clientId = normalizeClientId(args.clientId);
    if (clientId) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_project_and_client_id", (q) => q.eq("projectId", args.projectId).eq("clientId", clientId))
        .first();
      if (existing) {
        return {
          messageId: existing._id as string,
          conversationId: (existing.conversationId ?? "") as string,
          deduped: true,
        };
      }
    }
    // Plan 007: resolve (or create) the project's active conversation and sync
    // the caller's participant selection into it before the reply runs, so
    // participation is persisted rather than recomputed per message.
    // Only skills the project's team carries (what the "/" menu lists).
    const project = await ctx.db.get(args.projectId);
    const teamAgents = args.invokedSkills?.length
      ? await Promise.all((await projectTeamIds(ctx, project)).map((id) => ctx.db.get(id)))
      : [];
    const invokedSkills = await assertInvokedSkills(ctx, args.invokedSkills, teamAgents);
    const conversationId = await ensureChatConversation(ctx, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      preferredAgentIds: args.preferredAgentIds,
    });
    const messageId = await insertChatUserMessage(ctx, {
      projectId: args.projectId,
      content: args.content,
      conversationId,
      ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId } : {}),
      ...(args.preferredAgentIds?.length ? { preferredAgentIds: args.preferredAgentIds } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(clientId ? { clientId } : {}),
      ...(invokedSkills.length ? { invokedSkills } : {}),
    });
    // A message typed while a command waits declines it ("user replied
    // instead"): the agent continues with these words rather than blocking.
    await declineWaitingCommands(ctx, { projectId: args.projectId, conversationId, text: args.content });
    await ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
      projectId: args.projectId,
      conversationId,
      userMessageId: messageId,
      preferredAgentIds: args.preferredAgentIds,
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    });
    return { messageId: messageId as string, conversationId: conversationId as string, deduped: false };
  },
});

/**
 * Thread reply: posts a plain user message to a task thread without going
 * through the LLM send pipeline. No `queueStatus` is set, so the worker
 * never claims it. When `alsoSendToChat` is set, a second copy lands in the
 * project chat (no taskId).
 */
export const insertThreadMessage = mutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    content: v.string(),
    alsoSendToChat: v.optional(v.boolean()),
    /** Thread "Reply": the earlier message in this task thread it quotes. */
    quotedMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) throw new Error("Message is required");
    if (content.length > 4000) throw new Error("Message is too long (max 4000 characters)");
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) throw new Error("Task not found");
    if (task.projectId !== args.projectId) throw new Error("Task does not belong to this project");
    if (args.quotedMessageId) {
      const quoted = await ctx.db.get(args.quotedMessageId);
      if (!quoted || quoted.projectId !== args.projectId) throw new Error("Quoted message not found");
    }
    const messageId = await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      authorType: "user",
      content,
      ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId } : {}),
    });
    if (args.alsoSendToChat) {
      await ctx.db.insert("messages", {
        projectId: args.projectId,
        authorType: "user",
        content,
      });
    }
    // A reply in the thread while this task's command waits declines it.
    await declineWaitingCommands(ctx, { projectId: args.projectId, taskId: args.taskId, text: content });
    return messageId;
  },
});

// ---------------------------------------------------------------------------
// Personal chat (plan 039, PC2).
// ---------------------------------------------------------------------------

/**
 * One conversation's messages, newest N returned oldest-first (same shape
 * as listByProject). Reads `by_conversation`, so personal messages (no
 * projectId, D1) are found without a project scan.
 */
export const listByConversation = query({
  args: { conversationId: v.id("conversations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];
    await assertConversationAccess(ctx, conversation);
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 500, 1), 1000));
    return newest.reverse();
  },
});

/**
 * Send in a personal conversation. The scope comes from the conversation
 * row only: the message is written WITHOUT projectId (D1), dedupe runs on
 * (conversationId, clientId), and the reply is scheduled with the
 * conversation id alone. Project chat keeps `send`.
 */
export const sendInConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    quotedMessageId: v.optional(v.id("messages")),
    clientId: v.optional(v.string()),
    /** Paradev C3: skills this chat's agent carries, inlined for this turn. */
    invokedSkills: invokedSkillsField,
  },
  handler: async (ctx, args): Promise<{ messageId: string; conversationId: string; deduped: boolean }> => {
    const { conversation } = await getAccessibleConversation(ctx, args.conversationId);
    if (!isPersonalConversation(conversation)) {
      throw new Error("Use the project chat for this conversation");
    }
    if (conversation.status !== "active") {
      throw new Error("This chat is closed. Start a new chat.");
    }
    if (!args.content.trim()) throw new Error("Message is required");
    const clientId = normalizeClientId(args.clientId);
    if (clientId) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_client_id", (q) =>
          q.eq("conversationId", conversation._id).eq("clientId", clientId)
        )
        .first();
      if (existing) {
        return { messageId: existing._id as string, conversationId: conversation._id as string, deduped: true };
      }
    }
    const personalAgent = args.invokedSkills?.length && conversation.agentId ? await ctx.db.get(conversation.agentId) : null;
    const invokedSkills = await assertInvokedSkills(ctx, args.invokedSkills, [personalAgent]);
    const messageId = await insertChatUserMessage(ctx, {
      content: args.content,
      conversationId: conversation._id,
      ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(invokedSkills.length ? { invokedSkills } : {}),
    });
    const now = Date.now();
    await ctx.db.patch(conversation._id, { lastMessageAt: now, updatedAt: now });
    await syncConversationThread(ctx, conversation._id); // throttled activity bump (Paradev B1)
    await ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
      conversationId: conversation._id,
      userMessageId: messageId,
    });
    return { messageId: messageId as string, conversationId: conversation._id as string, deduped: false };
  },
});

// ---------------------------------------------------------------------------
// History paging (D12): cursor pages behind the newest window, and the turn
// outline. The cursor is the oldest `_creationTime` the client holds.
// ---------------------------------------------------------------------------

const historyScope = v.union(
  v.object({ kind: v.literal("task"), taskId: v.id("tasks") }),
  v.object({ kind: v.literal("conversation"), conversationId: v.id("conversations") }),
  v.object({ kind: v.literal("project"), projectId: v.id("projects") })
);
type HistoryScope = typeof historyScope.type;

/** The scope's message range on its index, or null when the caller may not see it (task gone). */
async function scopedMessages(ctx: QueryCtx, scope: HistoryScope) {
  if (scope.kind === "task") {
    if (!(await getVisibleTask(ctx, scope.taskId))) return null;
    return (range?: (q: any) => any) =>
      ctx.db.query("messages").withIndex("by_task", (q) => (range ? range(q.eq("taskId", scope.taskId)) : q.eq("taskId", scope.taskId)));
  }
  if (scope.kind === "conversation") {
    const conversation = await ctx.db.get(scope.conversationId);
    if (!conversation) return null;
    await assertConversationAccess(ctx, conversation);
    return (range?: (q: any) => any) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) =>
          range ? range(q.eq("conversationId", scope.conversationId)) : q.eq("conversationId", scope.conversationId)
        );
  }
  await assertProjectAccess(ctx, scope.projectId);
  return (range?: (q: any) => any) =>
    ctx.db.query("messages").withIndex("by_project", (q) => (range ? range(q.eq("projectId", scope.projectId)) : q.eq("projectId", scope.projectId)));
}

/**
 * One page of messages older than `before`, oldest first. With `floor`, the
 * page covers [floor, before) (an outline jump); `reachedFloor` is false when
 * more than one page lies in that range.
 */
export const pageEarlier = query({
  args: { scope: historyScope, before: v.number(), floor: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const scoped = await scopedMessages(ctx, args.scope);
    if (!scoped) return { rows: [], hasMore: false, reachedFloor: true };
    const size = pageSize(args.limit);
    const floor = args.floor;
    const taken = await scoped((q) =>
      floor === undefined ? q.lt("_creationTime", args.before) : q.gte("_creationTime", floor).lt("_creationTime", args.before)
    )
      .order("desc")
      .take(size + 1);
    const overflow = taken.length > size;
    const rows = taken.slice(0, size).reverse();
    if (floor === undefined) return { rows, hasMore: overflow, reachedFloor: true };
    if (overflow) return { rows, hasMore: true, reachedFloor: false };
    const below = await scoped((q) => q.lt("_creationTime", floor)).order("desc").first();
    return { rows, hasMore: below !== null, reachedFloor: true };
  },
});

/**
 * The thread's turns (user messages), oldest first, for the outline. Scans
 * the newest TURN_OUTLINE_SCAN_MAX rows; `truncated` says older turns exist
 * beyond the scan. Project scope lists the chat's turns, not task threads.
 */
export const turnOutline = query({
  args: { scope: historyScope },
  handler: async (ctx, args) => {
    const scoped = await scopedMessages(ctx, args.scope);
    if (!scoped) return { turns: [], truncated: false };
    const rows = await scoped().order("desc").take(TURN_OUTLINE_SCAN_MAX + 1);
    const truncated = rows.length > TURN_OUTLINE_SCAN_MAX;
    const turns = rows
      .slice(0, TURN_OUTLINE_SCAN_MAX)
      .filter((m) => m.authorType === "user" && (args.scope.kind !== "project" || !m.taskId))
      .reverse()
      .map((m, index) => ({ _id: m._id, _creationTime: m._creationTime, turn: index + 1, preview: turnPreview(m.content) }));
    return { turns, truncated };
  },
});
