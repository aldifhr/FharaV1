/**
 * Settings → Archive: closed chat threads.
 *
 * A thread is archived when it is closed: "New chat" in a personal chat
 * closes the previous one, and clearing a project chat closes its thread.
 * Closed personal threads keep their messages, so they can be restored
 * (made the agent's active personal chat again) or deleted for good.
 * Closed project threads with messages left (pinned ones survive a clear)
 * are listed too.
 */
import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertConversationAccess, assertRegistryWriteAccess } from "./lib/authz";
import { deleteConversationCascade } from "./lib/conversationCascade";
import { recordAudit } from "./lib/recordAudit";
import { isPersonalConversation } from "./lib/conversationShape";

const SCAN_LIMIT = 300;

export const list = query({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const rows = (await ctx.db.query("conversations").order("desc").take(SCAN_LIMIT)).filter(
      (row) => row.status === "closed"
    );
    const out = [];
    for (const row of rows) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
        .take(201);
      if (messages.length === 0) continue;
      const last = messages.reduce((a, b) => (b._creationTime > a._creationTime ? b : a));
      const agent = row.agentId ? await ctx.db.get(row.agentId) : null;
      const project = row.projectId ? await ctx.db.get(row.projectId) : null;
      out.push({
        _id: row._id,
        kind: isPersonalConversation(row) ? ("personal" as const) : ("project" as const),
        title: row.title ?? null,
        agentName: agent?.name ?? null,
        agentRole: agent?.role ?? null,
        projectName: project?.name ?? null,
        messageCount: messages.length > 200 ? "200+" : String(messages.length),
        preview: last.content.replace(/\s+/g, " ").trim().slice(0, 140),
        closedAt: row.updatedAt ?? row.lastMessageAt ?? row.createdAt,
        createdAt: row.createdAt,
      });
    }
    return out.sort((a, b) => b.closedAt - a.closedAt);
  },
});

async function loadClosed(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<Doc<"conversations">> {
  await assertRegistryWriteAccess(ctx);
  const row = await ctx.db.get(conversationId);
  if (!row) throw new Error("Thread not found");
  await assertConversationAccess(ctx, row);
  if (row.status !== "closed") throw new Error("Thread is not archived");
  return row;
}

/**
 * Restore: the thread becomes active again. The thread it replaces (the
 * agent's current personal chat, or the project's current thread) is
 * closed, so it lands in the archive instead.
 */
export const restore = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const row = await loadClosed(ctx, args.conversationId);
    const now = Date.now();
    let current: Doc<"conversations">[] = [];
    if (isPersonalConversation(row) && row.agentId) {
      current = (
        await ctx.db
          .query("conversations")
          .withIndex("by_agent_kind_status", (q) =>
            q.eq("agentId", row.agentId).eq("kind", "personal").eq("status", "active")
          )
          .collect()
      ).filter((other) => (other.ownerId ?? null) === (row.ownerId ?? null));
    } else if (row.projectId) {
      current = (
        await ctx.db
          .query("conversations")
          .withIndex("by_project_and_status", (q) => q.eq("projectId", row.projectId).eq("status", "active"))
          .collect()
      ).filter((other) => !isPersonalConversation(other));
    }
    for (const other of current) {
      await ctx.db.patch(other._id, { status: "closed", updatedAt: now });
    }
    await ctx.db.patch(row._id, { status: "active", updatedAt: now });
    await recordAudit(ctx, {
      action: "conversation.restore",
      target: row.title ?? String(row._id),
      ...(row.projectId ? { projectId: row.projectId } : {}),
    });
    return row._id;
  },
});

/** Delete an archived thread and its messages, participants and summaries. */
export const remove = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const row = await loadClosed(ctx, args.conversationId);
    let deletedMessages = 0;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
      .take(2000);
    for (const message of messages) {
      await ctx.db.delete(message._id);
      deletedMessages += 1;
    }
    // A very long thread is deleted in batches: the caller runs it again.
    if (messages.length === 2000) return { deletedMessages, more: true };
    // The rest of the conversation (participants, summaries, agent events,
    // snapshots, bound scheduled tasks, thread row) goes with it.
    await deleteConversationCascade(ctx, row);
    await recordAudit(ctx, {
      action: "conversation.delete",
      target: row.title ?? String(row._id),
      details: { deletedMessages },
      ...(row.projectId ? { projectId: row.projectId } : {}),
    });
    return { deletedMessages, more: false };
  },
});
