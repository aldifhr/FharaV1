import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { SHADOW_MAX_NOTES_PER_TASK, shadowBudgetLeft } from "./opinion";

/**
 * Shadow Agent budget, counted from the task's own shadow rows: notes
 * written and tokens spent (estimated in + out).
 */
export async function shadowUsage(ctx: MutationCtx, taskId: Id<"tasks">): Promise<{ notes: number; tokens: number; reviews: number }> {
  const rows = await ctx.db
    .query("reviewOpinions")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  let notes = 0;
  let tokens = 0;
  let reviews = 0;
  for (const row of rows) {
    if (row.mode !== "shadow") continue;
    reviews += 1;
    notes += row.notes?.length ?? 0;
    tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  }
  return { notes, tokens, reviews };
}

/**
 * Called inside orchestration.updateSubtask when a subtask newly completes.
 * When the task has the shadow agent on and budget left, records a
 * "running" shadow row and schedules the read-only review. Never throws
 * into the caller's transition and never touches the task or subtask.
 */
export async function scheduleShadowReview(ctx: MutationCtx, taskId: Id<"tasks">, subtaskKey: string): Promise<Id<"reviewOpinions"> | null> {
  const task = await ctx.db.get(taskId);
  if (!task?.shadowAgent) return null;
  const existing = await ctx.db
    .query("reviewOpinions")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  if (existing.some((row) => row.mode === "shadow" && row.subtaskKey === subtaskKey)) return null;
  const usage = await shadowUsage(ctx, taskId);
  // A review that could still add notes needs room for at least one; also
  // bound the number of reviews so empty reviews cannot spend forever.
  const budget = shadowBudgetLeft(usage);
  const now = Date.now();
  if (!budget.ok || usage.reviews >= SHADOW_MAX_NOTES_PER_TASK * 2) {
    if (!existing.some((row) => row.mode === "shadow" && row.status === "skipped")) {
      // One "skipped" row tells the UI the shadow stopped on its budget.
      await ctx.db.insert("reviewOpinions", {
        projectId: task.projectId,
        taskId,
        subtaskKey,
        mode: "shadow",
        target: "subtask",
        status: "skipped",
        reason: budget.reason === "tokens" ? "Shadow token cap reached" : "Shadow note limit reached",
        createdAt: now,
        completedAt: now,
      });
    }
    return null;
  }
  const opinionId = await ctx.db.insert("reviewOpinions", {
    projectId: task.projectId,
    taskId,
    subtaskKey,
    mode: "shadow",
    target: "subtask",
    status: "running",
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.reviewerNode.runReview, { opinionId });
  return opinionId;
}
