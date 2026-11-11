/**
 * GOAT G5: hidden-ref checkpoints of a task worktree (audit/goat-plan-2026-11-11.md, idea #1a).
 *
 * - `record` (worker action, token-gated): one row per capture the worker
 *   made with tools/gitCheckpoint.ts, after each subtask and after apply.
 * - `forTask` (query): the task's checkpoints, oldest first, for a run view.
 * - `diff` (action): the patch and file list between checkpoint N and M
 *   (or N and the HEAD it was captured on), read from git through
 *   worktreeNode.checkpointDiff with the Paradev A1 safe args and byte
 *   budget (lib/diffPatch.ts). Backend only: no UI renders it yet.
 * - `refsDeleted` (internal): the sweep deleted the refs (lib/checkpointRefs.ts).
 *
 * Not a worker.ts entry: that file is at its line budget.
 */
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertServiceToken, getVisibleTask } from "./lib/authz";
import { CHECKPOINT_FILES_LIMIT, checkpointRecordFields } from "./lib/checkpointValidators";
import type { ChangesetFile } from "./lib/changeset";

/** Checkpoints read per task (bounded; one per subtask plus one per apply). */
const CHECKPOINT_LIMIT = 500;

export const recordInternal = internalMutation({
  args: checkpointRecordFields,
  handler: async (ctx, args): Promise<Id<"checkpoints"> | null> => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    // Idempotent per (task, n): a retried report returns the first row.
    const existing = await ctx.db
      .query("checkpoints")
      .withIndex("by_task_n", (q) => q.eq("taskId", args.taskId).eq("n", args.n))
      .first();
    if (existing) return existing._id;
    const files = args.files.slice(0, CHECKPOINT_FILES_LIMIT);
    return await ctx.db.insert("checkpoints", {
      ...args,
      files,
      ...(args.filesTruncated || args.files.length > files.length ? { filesTruncated: true } : {}),
      projectId: task.projectId,
      createdAt: Date.now(),
    });
  },
});

export const record = action({
  args: { workerToken: v.string(), workerId: v.optional(v.string()), ...checkpointRecordFields },
  handler: async (ctx, args): Promise<Id<"checkpoints"> | null> => {
    assertServiceToken(args.workerToken);
    const { workerToken: _token, workerId: _worker, ...row } = args;
    return await ctx.runMutation(internal.checkpoints.recordInternal, row);
  },
});

export type CheckpointView = Omit<Doc<"checkpoints">, "_creationTime">;

export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<CheckpointView[] | null> => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const rows = await ctx.db
      .query("checkpoints")
      .withIndex("by_task_n", (q) => q.eq("taskId", task._id))
      .take(CHECKPOINT_LIMIT);
    return rows.map(({ _creationTime: _c, ...row }) => row);
  },
});

/** The sweep (or a discard / PR release) deleted this task's checkpoint refs. */
export const refsDeleted = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("checkpoints")
      .withIndex("by_task_n", (q) => q.eq("taskId", args.taskId))
      .take(CHECKPOINT_LIMIT);
    for (const row of rows) if (row.refDeletedAt === undefined) await ctx.db.patch(row._id, { refDeletedAt: now });
    return rows.length;
  },
});

export type CheckpointDiffContext =
  | { status: "not-found" }
  | { status: "refs-gone" }
  | { status: "ok"; repoPath: string; worktreePath?: string; fromSha: string; toSha: string; from: number; to: number };

/** Visibility (the caller's identity rides along from the action) and the two commits. `from` 0 = the HEAD `to` was captured on. */
export const diffContext = internalQuery({
  args: { taskId: v.id("tasks"), from: v.number(), to: v.number() },
  handler: async (ctx, args): Promise<CheckpointDiffContext> => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { status: "not-found" };
    const project = await ctx.db.get(task.projectId);
    const byN = async (n: number) =>
      await ctx.db
        .query("checkpoints")
        .withIndex("by_task_n", (q) => q.eq("taskId", task._id).eq("n", n))
        .first();
    const to = await byN(args.to);
    const from = args.from === 0 ? null : await byN(args.from);
    if (!project || !to || (args.from !== 0 && !from)) return { status: "not-found" };
    if (to.refDeletedAt !== undefined || from?.refDeletedAt !== undefined) return { status: "refs-gone" };
    const fromSha = from ? from.commitSha : to.headSha;
    if (!fromSha) return { status: "not-found" };
    return {
      status: "ok",
      repoPath: project.workspacePath,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
      fromSha,
      toSha: to.commitSha,
      from: args.from,
      to: args.to,
    };
  },
});

export type CheckpointDiffResult =
  | { status: "not-found" }
  | { status: "refs-gone" }
  | { status: "ok"; from: number; to: number; patch: string; truncated: boolean; files: ChangesetFile[] };

export const diff = action({
  args: { taskId: v.id("tasks"), from: v.number(), to: v.number() },
  handler: async (ctx, args): Promise<CheckpointDiffResult> => {
    if (!Number.isInteger(args.from) || !Number.isInteger(args.to) || args.from < 0 || args.to < 1) {
      return { status: "not-found" };
    }
    const context: CheckpointDiffContext = await ctx.runQuery(internal.checkpoints.diffContext, args);
    if (context.status !== "ok") return context;
    const result = (await ctx.runAction(internal.worktreeNode.checkpointDiff, {
      repoPath: context.repoPath,
      ...(context.worktreePath ? { worktreePath: context.worktreePath } : {}),
      fromSha: context.fromSha,
      toSha: context.toSha,
    })) as { ok: boolean; patch: string; truncated: boolean; files: ChangesetFile[] };
    // The commits are unreachable once the refs went (gc) or the repo moved.
    if (!result.ok) return { status: "refs-gone" };
    return { status: "ok", from: context.from, to: context.to, patch: result.patch, truncated: result.truncated, files: result.files };
  },
});
