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
import { isPersonalConversation } from "./lib/conversationShape";

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

/**
 * What a deep link's `:threadId` (`/project/:projectId/:threadId`) names in
 * this project: a task, a conversation, or nothing. The id is free text from
 * the address bar, so it is normalised first. A row from another project
 * comes back with `projectId: null` (the caller learns nothing about it);
 * the web decides the view in `threadLinkView` (lib/threadTree.ts).
 */
export const resolveLink = query({
  args: { projectId: v.id("projects"), threadId: v.string() },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const own = (projectId: string | undefined) => (projectId === args.projectId ? args.projectId : null);
    const taskId = ctx.db.normalizeId("tasks", args.threadId);
    const task = taskId ? await ctx.db.get(taskId) : null;
    if (task) return { kind: "task" as const, projectId: own(task.projectId), personal: false, taskChat: false, status: own(task.projectId) ? task.status : null };
    const conversationId = ctx.db.normalizeId("conversations", args.threadId);
    const conversation = conversationId ? await ctx.db.get(conversationId) : null;
    if (!conversation) return null;
    const projectId = own(conversation.projectId);
    return {
      kind: "conversation" as const,
      projectId,
      personal: projectId ? isPersonalConversation(conversation) : false,
      taskChat: projectId ? Boolean(conversation.taskId) : false,
      status: projectId ? conversation.status : null,
    };
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
