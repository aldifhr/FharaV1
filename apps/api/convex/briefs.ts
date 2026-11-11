import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertTaskAccess, getVisibleTask } from "./lib/authz";
import {
  addOpenQuestion,
  applyBriefPatch,
  removeOpenQuestion,
  type BriefPatch,
  type TaskBrief,
} from "./lib/brief";

/**
 * Task brief (plan L3, lib/brief.ts). Partial upsert semantics from
 * openagents briefs.py (Apache-2.0, see THIRD_PARTY_NOTICES.md): an absent
 * key is untouched, an explicit null clears it. No task event on edit.
 */

type Ctx = QueryCtx | MutationCtx;

const nullableText = v.optional(v.union(v.string(), v.null()));
export const briefPatchArgs = {
  objective: nullableText,
  owner: nullableText,
  latestResult: nullableText,
  nextStep: nullableText,
  openQuestions: v.optional(v.union(v.array(v.string()), v.null())),
};

function toBrief(row: Doc<"taskBriefs"> | null): TaskBrief | null {
  if (!row) return null;
  return {
    ...(row.objective ? { objective: row.objective } : {}),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.latestResult ? { latestResult: row.latestResult } : {}),
    ...(row.nextStep ? { nextStep: row.nextStep } : {}),
    openQuestions: row.openQuestions,
    ...(row.decisions?.length ? { decisions: row.decisions } : {}),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

async function loadRow(ctx: Ctx, taskId: Id<"tasks">) {
  return await ctx.db
    .query("taskBriefs")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .first();
}

/** Upsert a patch onto a task's brief. Shared by the user and worker paths. */
export async function writeBrief(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  patch: BriefPatch,
  updatedBy: "user" | "worker"
): Promise<TaskBrief> {
  const row = await loadRow(ctx, task._id);
  // A brand-new brief starts from the task's own request as its objective,
  // unless the patch sets one.
  const base: TaskBrief = toBrief(row) ?? {
    openQuestions: [],
    ...((task.command || task.title).trim() ? { objective: (task.command || task.title).trim().slice(0, 4000) } : {}),
  };
  const next = applyBriefPatch(base, patch);
  const now = Date.now();
  const fields = {
    objective: next.objective,
    owner: next.owner,
    latestResult: next.latestResult,
    nextStep: next.nextStep,
    openQuestions: next.openQuestions,
    decisions: next.decisions,
    updatedAt: now,
    updatedBy,
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("taskBriefs", { taskId: task._id, projectId: task.projectId, ...fields });
  return { ...next, updatedAt: now, updatedBy };
}

/** Add or resolve one open question (escalations / answers). No-op on a missing task. */
export async function touchBriefQuestion(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  op: { add?: string; resolve?: string }
): Promise<void> {
  const row = await loadRow(ctx, task._id);
  const current = row?.openQuestions ?? [];
  let next = current;
  if (op.resolve) next = removeOpenQuestion(next, op.resolve);
  if (op.add) next = addOpenQuestion(next, op.add);
  if (next.length === current.length && next.every((q, i) => q === current[i])) return;
  await writeBrief(ctx, task, { openQuestions: next }, "worker");
}

/** The task page: the brief (null when none was written yet). */
export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    return toBrief(await loadRow(ctx, args.taskId));
  },
});

/** The user's inline edit on the task page. */
export const update = mutation({
  args: { taskId: v.id("tasks"), ...briefPatchArgs },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    const { taskId: _taskId, ...patch } = args;
    return await writeBrief(ctx, task, patch, "user");
  },
});

/** Worker read (token-gated wrapper in worker.ts). */
export const getForWorker = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => toBrief(await loadRow(ctx, args.taskId)),
});

/** Worker write (token-gated wrapper in worker.ts). */
export const updateFromWorker = internalMutation({
  args: { taskId: v.id("tasks"), ...briefPatchArgs },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const { taskId: _taskId, ...patch } = args;
    return await writeBrief(ctx, task, patch, "worker");
  },
});
