/**
 * Line comments on a task's changes, sent back as a review round (Paradev A3).
 *
 * The user anchors a comment to a line range of a file in the task's diff
 * (proposed files before Accept, or the committed branch). Comments start
 * as drafts; `sendRound` sends every draft at once, as one queued fix task
 * on the owner's branch and worktree (like a PR reaction's fix task, but
 * marked `reviewFix`).
 * Sent comments keep their round. A branch comment whose `anchorSha` is no
 * longer the branch HEAD reads as outdated.
 */
import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getVisibleTask } from "./lib/authz";
import { appendTaskEvent } from "./lib/taskEvents";
import { taskCardConversationId } from "./lib/conversationScope";
import { diffCommentSide, diffCommentSource } from "./lib/diffCommentSchema";
import { TERMINAL_TASK, buildReviewRoundPrompt, reviewFixTitle, sortLineComments } from "./lib/prFeedback";
import { fixInFlight, syncPrNotifications } from "./prFeedback";
import { newestPush } from "./changes";
import { isLegacyDirect } from "./lib/legacyDirect";
import { syncTaskThread } from "./lib/threadIndex";

const MAX_BODY = 4_000;
const MAX_PATH = 1_000;
const MAX_DRAFTS = 100;
const LIST_LIMIT = 500;

export type SendRoundResult =
  | { sent: true; round: number; count: number; roundTaskId: Id<"tasks">; mode: "fix_task" }
  | { sent: false; reason: "no_drafts" | "fix_running" | "worktree_gone" | "task_running" | "thread_closed" };

function cleanBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Comment is empty");
  if (trimmed.length > MAX_BODY) throw new Error(`Comment is too long (max ${MAX_BODY} characters)`);
  return trimmed;
}

function checkRange(startLine: number, endLine: number) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("Line range must be whole numbers with 1 <= startLine <= endLine");
  }
}

async function loadTask(ctx: MutationCtx, taskId: Id<"tasks">): Promise<Doc<"tasks">> {
  const task = await getVisibleTask(ctx, taskId);
  if (!task) throw new Error("Task not found");
  return task;
}

async function loadDraft(ctx: MutationCtx, commentId: Id<"diffComments">): Promise<Doc<"diffComments">> {
  const comment = await ctx.db.get(commentId);
  if (!comment || comment.status === "deleted") throw new Error("Comment not found");
  await loadTask(ctx, comment.taskId);
  if (comment.status !== "draft") throw new Error("A sent comment cannot change");
  return comment;
}

/** The task's comments (drafts and sent), in diff order, each with `outdated`. */
export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    const take = (status: "draft" | "sent") =>
      ctx.db
        .query("diffComments")
        .withIndex("by_task_and_status", (q) => q.eq("taskId", task._id).eq("status", status))
        .take(LIST_LIMIT);
    const rows = [...(await take("draft")), ...(await take("sent"))];
    const push = await newestPush(ctx, task._id);
    const head = push ? (push.headSha ?? push.commitSha) : undefined;
    return sortLineComments(rows).map((row) => ({
      ...row,
      outdated: row.anchorSha !== undefined && head !== undefined && row.anchorSha !== head,
    }));
  },
});

export const addDraft = mutation({
  args: {
    taskId: v.id("tasks"),
    path: v.string(),
    oldPath: v.optional(v.string()),
    side: diffCommentSide,
    startLine: v.number(),
    endLine: v.number(),
    body: v.string(),
    source: diffCommentSource,
    anchorSha: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"diffComments">> => {
    const task = await loadTask(ctx, args.taskId);
    const path = args.path.trim();
    if (!path || path.length > MAX_PATH) throw new Error("A file path is required");
    checkRange(args.startLine, args.endLine);
    const drafts = await ctx.db
      .query("diffComments")
      .withIndex("by_task_and_status", (q) => q.eq("taskId", task._id).eq("status", "draft"))
      .take(MAX_DRAFTS);
    if (drafts.length >= MAX_DRAFTS) throw new Error(`At most ${MAX_DRAFTS} draft comments per task; send a round first`);
    const now = Date.now();
    return await ctx.db.insert("diffComments", {
      taskId: task._id,
      projectId: task.projectId,
      path,
      ...(args.oldPath?.trim() ? { oldPath: args.oldPath.trim() } : {}),
      side: args.side,
      startLine: args.startLine,
      endLine: args.endLine,
      body: cleanBody(args.body),
      source: args.source,
      ...(args.source === "branch" && args.anchorSha ? { anchorSha: args.anchorSha } : {}),
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const editDraft = mutation({
  args: {
    commentId: v.id("diffComments"),
    body: v.optional(v.string()),
    startLine: v.optional(v.number()),
    endLine: v.optional(v.number()),
    side: v.optional(diffCommentSide),
  },
  handler: async (ctx, args) => {
    const comment = await loadDraft(ctx, args.commentId);
    const startLine = args.startLine ?? comment.startLine;
    const endLine = args.endLine ?? comment.endLine;
    checkRange(startLine, endLine);
    await ctx.db.patch(comment._id, {
      ...(args.body !== undefined ? { body: cleanBody(args.body) } : {}),
      ...(args.side ? { side: args.side } : {}),
      startLine,
      endLine,
      updatedAt: Date.now(),
    });
  },
});

/** Drafts only; the row stays as `deleted` so a sent round's ids never dangle. */
export const deleteDraft = mutation({
  args: { commentId: v.id("diffComments") },
  handler: async (ctx, args) => {
    const comment = await loadDraft(ctx, args.commentId);
    await ctx.db.patch(comment._id, { status: "deleted", updatedAt: Date.now() });
  },
});

/** Insert the queued fix task for an orchestrated round (same branch AND worktree as the owner). */
async function insertReviewFixTask(ctx: MutationCtx, owner: Doc<"tasks">, round: number, drafts: Doc<"diffComments">[]) {
  const now = Date.now();
  const title = reviewFixTitle(round, owner.title);
  const fixTaskId = await ctx.db.insert("tasks", {
    projectId: owner.projectId,
    title,
    command: buildReviewRoundPrompt({ round, comments: drafts, ownerTitle: owner.title, branchName: owner.branchName }),
    status: "queued",
    parentTaskId: owner._id,
    reviewFix: { ownerTaskId: owner._id, round, commentIds: drafts.map((d) => d._id) },
    branchName: owner.branchName,
    worktreePath: owner.worktreePath,
    ...(owner.conversationId ? { conversationId: owner.conversationId } : {}),
    ...(owner.assignedAgentIds ? { assignedAgentIds: owner.assignedAgentIds } : {}),
    ...(owner.permissionMode ? { permissionMode: owner.permissionMode } : {}),
    ...(owner.sprint !== undefined ? { sprint: owner.sprint } : {}),
    updatedAt: now,
  });
  await syncTaskThread(ctx, fixTaskId); // Paradev B1 thread list
  const cardConversationId = await taskCardConversationId(ctx, owner.conversationId);
  await ctx.db.insert("messages", {
    projectId: owner.projectId,
    taskId: fixTaskId,
    ...(cardConversationId ? { conversationId: cardConversationId } : {}),
    authorType: "agent",
    content: `${title}. Fhara will commit the changes on ${owner.branchName}; you approve the push.`,
  });
  return fixTaskId;
}

/**
 * Send every draft on the task as one review round. Refused (nothing
 * written) while a fix already runs on the branch, after the worktree was
 * released, while the task itself still runs, or on a closed thread.
 */
export const sendRound = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<SendRoundResult> => {
    const task = await loadTask(ctx, args.taskId);
    const drafts = sortLineComments(
      await ctx.db
        .query("diffComments")
        .withIndex("by_task_and_status", (q) => q.eq("taskId", task._id).eq("status", "draft"))
        .take(MAX_DRAFTS)
    );
    if (drafts.length === 0) return { sent: false, reason: "no_drafts" };
    const round = (task.reviewRounds ?? 0) + 1;
    // legacy: direct threads removed 2026-11-12; an old one is read-only.
    if (isLegacyDirect(task)) return { sent: false, reason: "thread_closed" };
    if (await fixInFlight(ctx, task._id)) return { sent: false, reason: "fix_running" };
    if (!task.branchName || !task.worktreePath) return { sent: false, reason: "worktree_gone" };
    if (!TERMINAL_TASK.has(task.status)) return { sent: false, reason: "task_running" };
    const roundTaskId = await insertReviewFixTask(ctx, task, round, drafts);
    const now = Date.now();
    for (const draft of drafts) await ctx.db.patch(draft._id, { status: "sent", round, roundTaskId, updatedAt: now });
    await ctx.db.patch(task._id, { reviewRounds: round, updatedAt: now });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "review.round_sent",
      payload: { round, comments: drafts.length, fixTaskId: roundTaskId },
      level: "info",
    });
    await syncPrNotifications(ctx, task._id);
    return { sent: true, round, count: drafts.length, roundTaskId, mode: "fix_task" };
  },
});
