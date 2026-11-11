/**
 * GOAT G12b: task drafts an MCP caller saved (lib/mcpWriteSchema.ts).
 *
 * A draft is a task nobody started: the user starts it here (an ordinary
 * queued task, as Create task makes) or dismisses it. Every function is
 * user-facing and checks project access; the MCP side writes drafts
 * through mcpWrite.taskCreate only.
 */
import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./lib/authz";
import type { PermissionMode } from "./lib/permissionModes";
import { appendTaskEvent } from "./lib/taskEvents";
import { syncTaskThread } from "./lib/threadIndex";

const LIST_MAX = 50;

/** Insert a queued task the way Create task does (task row, thread index, the user's ask as the first thread message). */
export async function insertQueuedTask(
  ctx: MutationCtx,
  input: {
    project: Doc<"projects">;
    title: string;
    command: string;
    permissionMode: PermissionMode;
    conversationId?: Id<"conversations">;
    source: string;
  }
): Promise<Id<"tasks">> {
  const now = Date.now();
  const taskId = await ctx.db.insert("tasks", {
    projectId: input.project._id,
    title: input.title,
    command: input.command,
    status: "queued",
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    permissionMode: input.permissionMode,
    ...(input.project.shadowAgentDefault ? { shadowAgent: true } : {}),
    updatedAt: now,
  });
  await syncTaskThread(ctx, taskId, { seen: true });
  await ctx.db.insert("messages", { projectId: input.project._id, taskId, authorType: "user", content: input.command });
  await appendTaskEvent(ctx, {
    taskId,
    projectId: input.project._id,
    type: "task.created",
    payload: { source: input.source, permissionMode: input.permissionMode },
    level: "info",
  });
  return taskId;
}

/** Open drafts of one project, newest first. */
export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("taskDrafts")
      .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId).eq("status", "draft"))
      .order("desc")
      .take(LIST_MAX);
  },
});

/** The user starts a draft: one queued task; starting it again returns that task. */
export const start = mutation({
  args: { draftId: v.id("taskDrafts") },
  handler: async (ctx, args): Promise<Id<"tasks">> => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) throw new Error("Draft not found");
    const project = await assertProjectAccess(ctx, draft.projectId);
    if (draft.status === "started" && draft.taskId) return draft.taskId;
    if (draft.status !== "draft") throw new Error("This draft was dismissed");
    const taskId = await insertQueuedTask(ctx, {
      project,
      title: draft.title,
      command: draft.command,
      permissionMode: draft.permissionMode,
      ...(draft.conversationId ? { conversationId: draft.conversationId } : {}),
      source: "mcp_draft",
    });
    await ctx.db.patch(draft._id, { status: "started", taskId, updatedAt: Date.now() });
    return taskId;
  },
});

export const dismiss = mutation({
  args: { draftId: v.id("taskDrafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) throw new Error("Draft not found");
    await assertProjectAccess(ctx, draft.projectId);
    if (draft.status !== "draft") return { applied: false as const };
    await ctx.db.patch(draft._id, { status: "dismissed", updatedAt: Date.now() });
    return { applied: true as const };
  },
});
