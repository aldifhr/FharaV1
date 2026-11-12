/**
 * Per-project thread list (Paradev B1 / threadbear T7): tasks and
 * project conversations, newest activity first, read from
 * `threadIndex` (written only by lib/threadIndex.ts). Backend for the
 * sidebar Threads section (B2) and rename everywhere (B3). Nothing here
 * starts a task.
 */
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertProjectAccess, assertTaskAccess, getAccessibleConversation } from "./lib/authz";
import { normaliseTitle, syncConversationThread, syncTaskThread } from "./lib/threadIndex";

const LIST_DEFAULT = 100;
const LIST_MAX = 300;
const BACKFILL_BATCH = 100;

export const list = query({
  args: {
    projectId: v.id("projects"),
    limit: v.optional(v.number()),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? LIST_DEFAULT)), LIST_MAX);
    const rows = await ctx.db
      .query("threadIndex")
      .withIndex("by_project_and_activity", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(limit);
    return rows
      .filter((row) => args.includeArchived || row.archivedAt === undefined)
      .map((row) => ({
        id: row._id,
        kind: row.kind === "direct" ? ("task" as const) : row.kind, // legacy direct rows list as plain tasks
        taskId: row.taskId ?? null,
        conversationId: row.conversationId ?? null,
        ownerTaskId: row.ownerTaskId ?? null,
        title: row.title,
        status: row.status,
        needsYou: row.needsYou,
        unread: row.lastActivityAt > (row.seenAt ?? 0),
        branchName: row.branchName ?? null,
        worktreeKey: row.worktreeKey ?? null,
        preview: row.preview ?? null,
        lastActivityAt: row.lastActivityAt,
        archived: row.archivedAt !== undefined,
      }));
  },
});

const threadRef = {
  taskId: v.optional(v.id("tasks")),
  conversationId: v.optional(v.id("conversations")),
};

/** Rename a task or a conversation. Empty or whitespace titles are refused. */
export const rename = mutation({
  args: { ...threadRef, title: v.string() },
  handler: async (ctx, args) => {
    const title = normaliseTitle(args.title);
    if (!title) throw new Error("Title cannot be empty");
    if (!!args.taskId === !!args.conversationId) throw new Error("Pass exactly one of taskId or conversationId");
    if (args.taskId) {
      await assertTaskAccess(ctx, args.taskId);
      await ctx.db.patch(args.taskId, { title, titleSetBy: "user", updatedAt: Date.now() });
      await syncTaskThread(ctx, args.taskId);
      return { title };
    }
    const { conversation } = await getAccessibleConversation(ctx, args.conversationId!);
    await ctx.db.patch(conversation._id, { title, updatedAt: Date.now() });
    await syncConversationThread(ctx, conversation._id);
    return { title };
  },
});

/** The viewer opened the thread: it stops counting as unread. */
export const markSeen = mutation({
  args: threadRef,
  handler: async (ctx, args) => {
    if (args.taskId) await assertTaskAccess(ctx, args.taskId);
    else if (args.conversationId) await getAccessibleConversation(ctx, args.conversationId);
    else throw new Error("Pass taskId or conversationId");
    const row = args.taskId
      ? await ctx.db.query("threadIndex").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).unique()
      : await ctx.db.query("threadIndex").withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId)).unique();
    if (row && (row.seenAt ?? 0) < row.lastActivityAt) await ctx.db.patch(row._id, { seenAt: row.lastActivityAt });
  },
});

/**
 * One-off, capped and idempotent: index existing tasks, then conversations,
 * BACKFILL_BATCH per run, rescheduling itself until both tables are done.
 * Rows it creates count as seen. Run once after deploy: `npx convex run threads:backfill`.
 */
export const backfill = internalMutation({
  args: {
    table: v.optional(v.union(v.literal("tasks"), v.literal("conversations"))),
    cursor: v.optional(v.union(v.string(), v.null())),
    written: v.optional(v.number()),
    once: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ done: boolean; written: number }> => {
    const table = args.table ?? "tasks";
    let written = args.written ?? 0;
    const page = await ctx.db.query(table).paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_BATCH });
    for (const doc of page.page) {
      const result =
        table === "tasks"
          ? await syncTaskThread(ctx, doc._id as never, { seen: true })
          : await syncConversationThread(ctx, doc._id as never, { seen: true });
      if (result !== "unchanged") written += 1;
    }
    const next = page.isDone
      ? table === "tasks"
        ? { table: "conversations" as const, cursor: null }
        : null
      : { table, cursor: page.continueCursor };
    if (next && !args.once) await ctx.scheduler.runAfter(0, internal.threads.backfill, { ...next, written });
    return { done: !next, written };
  },
});
