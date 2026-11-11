/**
 * GOAT G6: restore from hidden-ref checkpoints and worktree snapshots
 * (audit/goat-plan-2026-11-11.md, idea #1b). Backend only.
 *
 * - `revertToCheckpoint` (action): the task worktree becomes identical to
 *   checkpoint N, HEAD rewound to the commit N was captured on. Refused
 *   once the branch was pushed (a push row, an upstream or a remote-tracking
 *   ref): the result is `{ status: "pushed", offer: "revert-commit" }`, and
 *   the same call with `mode: "revert-commit"` adds a commit on top whose
 *   tree is N's instead.
 * - `undoLastApply` (action): the same, to the checkpoint before the latest
 *   "apply" checkpoint.
 * - `snapshots` / `restoreSnapshot` (actions): the snapshots the worktree
 *   sweep took before removing the worktree (`refs/fhara/snapshots/<taskId>/<ms>`),
 *   and re-creating the worktree from one.
 * - Retention: snapshot refs are kept 7 days (SNAPSHOT_RETENTION_MS) and
 *   pruned by the 6-hourly "sweep stale task worktrees" cron; the G5
 *   checkpoint-ref deletions never touch them.
 *
 * Git runs in checkpointRestoreNode.ts. Not a worker.ts or orchestration.ts
 * entry: both are at their line budget.
 */
import { action, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { getVisibleTask } from "./lib/authz";
import { appendTaskEvent } from "./lib/taskEvents";
import type { SnapshotRestoreOutcome, WorktreeSnapshot } from "./lib/checkpointRestore";
import type { CheckpointGitResult } from "./checkpointRestoreNode";

const CHECKPOINT_LIMIT = 500;
/** A worker may be writing the worktree in these states. */
const ACTIVE_STATUSES = new Set<Doc<"tasks">["status"]>(["queued", "running"]);

const modeValidator = v.union(v.literal("restore"), v.literal("revert-commit"));
type Mode = "restore" | "revert-commit";

export type RestoreContext =
  | { status: "not-found" | "no-worktree" | "task-active" | "refs-gone" | "no-apply" | "no-earlier-checkpoint" }
  | {
      status: "ok";
      worktreePath: string;
      n: number;
      commitSha: string;
      headSha?: string;
      pushedInFhara: boolean;
    };

/** A push row of the task or of the PR owner it shares a worktree with, past `ready`. */
async function pushedInFhara(ctx: QueryCtx, task: Doc<"tasks">): Promise<boolean> {
  const ownerId = task.parentTaskId && (task.prFix || task.reviewFix) ? task.parentTaskId : task._id;
  const rows = [
    ...(await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(50)),
    ...(await ctx.db.query("taskPushes").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerId)).take(50)),
  ];
  return rows.some((row) => row.status === "pushing" || row.status === "pushed" || row.pushedAt !== undefined || !!row.prUrl);
}

export const restoreContext = internalQuery({
  args: { taskId: v.id("tasks"), n: v.optional(v.number()), undoApply: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<RestoreContext> => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { status: "not-found" };
    if (!task.worktreePath) return { status: "no-worktree" };
    if (ACTIVE_STATUSES.has(task.status)) return { status: "task-active" };
    const rows = await ctx.db
      .query("checkpoints")
      .withIndex("by_task_n", (q) => q.eq("taskId", task._id))
      .take(CHECKPOINT_LIMIT);
    let target: Doc<"checkpoints"> | undefined;
    if (args.undoApply) {
      const apply = rows.filter((row) => row.kind === "apply").at(-1);
      if (!apply) return { status: "no-apply" };
      target = rows.filter((row) => row.n < apply.n).at(-1);
      if (!target) return { status: "no-earlier-checkpoint" };
    } else {
      target = rows.find((row) => row.n === args.n);
      if (!target) return { status: "not-found" };
    }
    if (target.refDeletedAt !== undefined) return { status: "refs-gone" };
    return {
      status: "ok",
      worktreePath: task.worktreePath,
      n: target.n,
      commitSha: target.commitSha,
      ...(target.headSha ? { headSha: target.headSha } : {}),
      pushedInFhara: await pushedInFhara(ctx, task),
    };
  },
});

export const restored = internalMutation({
  args: { taskId: v.id("tasks"), type: v.string(), payload: v.any() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;
    await appendTaskEvent(ctx, { taskId: task._id, projectId: task.projectId, type: args.type, payload: args.payload, level: "info" });
  },
});

export type CheckpointRestoreResult = Exclude<RestoreContext, { status: "ok" }> | (CheckpointGitResult & { n?: number; mode?: Mode });

async function runRestore(
  ctx: ActionCtx,
  args: { taskId: Id<"tasks">; n?: number; undoApply?: boolean; mode?: Mode }
): Promise<CheckpointRestoreResult> {
  const context: RestoreContext = await ctx.runQuery(internal.checkpointRestore.restoreContext, {
    taskId: args.taskId,
    ...(args.n !== undefined ? { n: args.n } : {}),
    ...(args.undoApply ? { undoApply: true } : {}),
  });
  if (context.status !== "ok") return context;
  const mode = args.mode ?? "restore";
  const result: CheckpointGitResult = await ctx.runAction(internal.checkpointRestoreNode.restoreCheckpointGit, {
    worktreePath: context.worktreePath,
    commitSha: context.commitSha,
    ...(context.headSha ? { headSha: context.headSha } : {}),
    n: context.n,
    mode,
    pushedInFhara: context.pushedInFhara,
  });
  if (result.status === "ok") {
    await ctx.runMutation(internal.checkpointRestore.restored, {
      taskId: args.taskId,
      type: mode === "restore" ? "checkpoint.restored" : "checkpoint.revert_committed",
      payload: { n: context.n, undoApply: !!args.undoApply, ...result },
    });
  }
  return { ...result, n: context.n, mode };
}

export const revertToCheckpoint = action({
  args: { taskId: v.id("tasks"), n: v.number(), mode: v.optional(modeValidator) },
  handler: async (ctx, args): Promise<CheckpointRestoreResult> => {
    if (!Number.isInteger(args.n) || args.n < 1) return { status: "not-found" };
    return await runRestore(ctx, args);
  },
});

export const undoLastApply = action({
  args: { taskId: v.id("tasks"), mode: v.optional(modeValidator) },
  handler: async (ctx, args): Promise<CheckpointRestoreResult> => await runRestore(ctx, { ...args, undoApply: true }),
});

// --- Snapshots taken by the worktree sweep ---

export const snapshotTaken = internalMutation({
  args: { taskId: v.id("tasks"), ref: v.string(), commitSha: v.string(), headSha: v.string(), worktreePath: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;
    const { taskId, ...payload } = args;
    await appendTaskEvent(ctx, { taskId, projectId: task.projectId, type: "branch.worktree_snapshot", payload, level: "info" });
  },
});

/** Every project repo, for the sweep's snapshot retention (bounded). */
export const snapshotRepos = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const projects = await ctx.db.query("projects").take(500);
    return [...new Set(projects.map((project) => project.workspacePath).filter(Boolean))];
  },
});

export type SnapshotContext =
  | { status: "not-found" | "task-active" }
  | { status: "ok"; repoPath: string; worktreePath?: string; branchName?: string };

export const snapshotContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<SnapshotContext> => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { status: "not-found" };
    if (ACTIVE_STATUSES.has(task.status)) return { status: "task-active" };
    const project = await ctx.db.get(task.projectId);
    if (!project) return { status: "not-found" };
    return {
      status: "ok",
      repoPath: project.workspacePath,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
      ...(task.branchName ? { branchName: task.branchName } : {}),
    };
  },
});

export const snapshots = action({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<WorktreeSnapshot[] | null> => {
    const context: SnapshotContext = await ctx.runQuery(internal.checkpointRestore.snapshotContext, args);
    if (context.status === "not-found") return null;
    if (context.status !== "ok") return [];
    return await ctx.runAction(internal.checkpointRestoreNode.listSnapshotsGit, {
      repoPath: context.repoPath,
      ...(context.worktreePath ? { worktreePath: context.worktreePath } : {}),
      taskId: args.taskId,
    });
  },
});

export const worktreeRestored = internalMutation({
  args: { taskId: v.id("tasks"), worktreePath: v.string(), ref: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;
    // A fresh retention window, so the next sweep does not take it straight back.
    await ctx.db.patch(task._id, { worktreePath: args.worktreePath, updatedAt: Date.now() });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "branch.worktree_restored",
      payload: { worktreePath: args.worktreePath, branchName: task.branchName, ...(args.ref ? { ref: args.ref } : {}) },
      level: "info",
    });
  },
});

export type SnapshotRestoreResult =
  | Exclude<SnapshotContext, { status: "ok" }>
  | SnapshotRestoreOutcome
  | { status: "failed"; error: string };

export const restoreSnapshot = action({
  args: { taskId: v.id("tasks"), ref: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SnapshotRestoreResult> => {
    const context: SnapshotContext = await ctx.runQuery(internal.checkpointRestore.snapshotContext, { taskId: args.taskId });
    if (context.status !== "ok") return context;
    if (context.worktreePath) return { status: "worktree-exists" as const, worktreePath: context.worktreePath };
    const result: SnapshotRestoreResult = await ctx.runAction(internal.checkpointRestoreNode.restoreSnapshotGit, {
      repoPath: context.repoPath,
      taskId: args.taskId,
      ...(args.ref ? { ref: args.ref } : {}),
      ...(context.branchName ? { branch: context.branchName } : {}),
    });
    if (result.status === "ok") {
      await ctx.runMutation(internal.checkpointRestore.worktreeRestored, {
        taskId: args.taskId,
        worktreePath: result.worktreePath,
        ...(args.ref ? { ref: args.ref } : {}),
      });
    }
    return result;
  },
});
