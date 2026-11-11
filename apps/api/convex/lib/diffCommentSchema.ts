/**
 * Schema pieces for line comments on a task's changes (Paradev A3), kept
 * out of schema.ts so that file stays within its line budget.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/** file:line evidence on a Reviewer opinion or shadow note. */
export const reviewEvidenceValidator = v.object({
  file: v.string(),
  line: v.optional(v.number()),
  note: v.optional(v.string()),
});

export const diffCommentSide = v.union(v.literal("additions"), v.literal("deletions"), v.literal("mixed"));
export const diffCommentSource = v.union(v.literal("proposed"), v.literal("branch"));
export const diffCommentStatus = v.union(v.literal("draft"), v.literal("sent"), v.literal("deleted"));

/** One row per line comment on a task's changes. */
export const diffCommentsTable = defineTable({
  taskId: v.id("tasks"),
  projectId: v.id("projects"),
  path: v.string(),
  oldPath: v.optional(v.string()),
  side: diffCommentSide,
  startLine: v.number(),
  endLine: v.number(),
  body: v.string(),
  source: diffCommentSource,
  // Branch HEAD when written; unset for proposed changes.
  anchorSha: v.optional(v.string()),
  status: diffCommentStatus,
  round: v.optional(v.number()),
  // The fix task (orchestrated) or the thread itself (direct).
  roundTaskId: v.optional(v.id("tasks")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_task_and_status", ["taskId", "status"])
  .index("by_project", ["projectId"]);

/**
 * On a task made from a review round: the owner, the round and the comments
 * it carries. Separate from `prFix`, which needs a prReactions row.
 */
export const reviewFixValidator = v.object({
  ownerTaskId: v.id("tasks"),
  round: v.number(),
  commentIds: v.array(v.id("diffComments")),
});
