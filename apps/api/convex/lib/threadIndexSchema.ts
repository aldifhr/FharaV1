/**
 * Schema pieces for the per-project thread list (Paradev P-B / threadbear T7),
 * kept out of schema.ts so that file stays within its line budget.
 *
 * One row per thread a project's sidebar lists: a task or a project
 * conversation. Written only by
 * lib/threadIndex.ts, which patches a row only when a shown field changes.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

// legacy: direct threads removed 2026-11-12; "direct" stays for old rows only.
export const threadKind = v.union(v.literal("task"), v.literal("direct"), v.literal("conversation"));

/** Who set a task's title: a user rename is never overwritten by the system. */
export const titleSetByValidator = v.optional(v.union(v.literal("system"), v.literal("user")));

export const threadIndexTable = defineTable({
  projectId: v.id("projects"),
  kind: threadKind,
  taskId: v.optional(v.id("tasks")),
  conversationId: v.optional(v.id("conversations")),
  // Fix and review-round tasks point at the task whose PR they fix.
  ownerTaskId: v.optional(v.id("tasks")),
  title: v.string(),
  // The row's word: running, needs you, done, idle, failed, …
  status: v.string(),
  needsYou: v.boolean(),
  branchName: v.optional(v.string()),
  // Normalised worktree path (or branch), for grouping owner + fix tasks.
  worktreeKey: v.optional(v.string()),
  preview: v.optional(v.string()),
  lastActivityAt: v.number(),
  // Unread = lastActivityAt > seenAt (threads.markSeen).
  seenAt: v.optional(v.number()),
  archivedAt: v.optional(v.number()),
  updatedMs: v.number(),
})
  .index("by_project_and_activity", ["projectId", "lastActivityAt"])
  .index("by_task", ["taskId"])
  .index("by_conversation", ["conversationId"])
  .index("by_activity", ["lastActivityAt"]);
