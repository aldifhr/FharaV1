/**
 * Paradev A1: one task's changes for the Changes pane (plan
 * audit/paradev-plan-2026-11-11.md, P-A). Backend only; A2 renders it.
 *
 * - `forTask` (query): the proposed files from `fileChanges` before Accept,
 *   then the committed branch once `recordTaskCommit` wrote a taskPushes
 *   row, with PR facts copied from the newest row and the flow state
 *   (lib/changeset.ts).
 * - `branchPatch` (action): the `main..task branch` patch and exact file
 *   list, read through worktreeNode.getDiff (safe git config, byte budget).
 */
import { action, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getVisibleTask } from "./lib/authz";
import { fixInFlight } from "./prFeedback";
import {
  type ChangesetFile,
  type ChangesFlowState,
  type ChangesPr,
  type ChangesPush,
  filesFromFileChanges,
  getChangesFlowState,
} from "./lib/changeset";

/** fileChanges rows read per task (bounded). */
const FILE_CHANGE_LIMIT = 500;
/** taskPushes rows read per index (bounded; a task has a handful). */
const PUSH_LIMIT = 50;

export interface ChangesForTask {
  taskId: Id<"tasks">;
  /** Which view is current: nothing yet, proposed files, or the committed branch. */
  source: "none" | "proposed" | "branch";
  branchName?: string;
  /** The task worktree still exists, so `branchPatch` can read the branch. */
  hasWorktree: boolean;
  base?: string;
  /** Proposed files folded from fileChanges (one per path). After commit the exact branch list comes from `branchPatch`. */
  files: ChangesetFile[];
  commit: {
    sha: string;
    message: string;
    filesChanged: number;
    additions?: number;
    deletions?: number;
    ahead?: number;
    behind?: number;
    comparedTo?: string;
  } | null;
  push: ChangesPush | null;
  pr: ChangesPr | null;
  flow: ChangesFlowState;
}

function prFacts(row: Doc<"taskPushes">): ChangesPr | null {
  if (row.prNumber === undefined) return null;
  return {
    number: row.prNumber,
    ...(row.prUrl ? { url: row.prUrl } : {}),
    ...(row.prTitle ? { title: row.prTitle } : {}),
    state: row.prState ?? "open",
    ...(row.ciState ? { ciState: row.ciState } : {}),
    ciChecks: (row.ciChecks ?? []).map((c) => ({
      name: c.name,
      status: c.status,
      ...(c.conclusion ? { conclusion: c.conclusion } : {}),
      ...(c.url ? { url: c.url } : {}),
    })),
    ...(row.reviewState ? { reviewState: row.reviewState } : {}),
    ...(row.mergeable ? { mergeable: row.mergeable } : {}),
    ...(row.headSha ? { headSha: row.headSha } : {}),
  };
}

/** Newest push row of the task: its own commits and its fix tasks' commits on the same PR. */
export async function newestPush(ctx: QueryCtx, taskId: Id<"tasks">): Promise<Doc<"taskPushes"> | null> {
  const own = await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(PUSH_LIMIT);
  const fixes = await ctx.db
    .query("taskPushes")
    .withIndex("by_owner_task", (q) => q.eq("ownerTaskId", taskId))
    .take(PUSH_LIMIT);
  let newest: Doc<"taskPushes"> | null = null;
  for (const row of [...own, ...fixes]) {
    if (!newest || row.createdAt > newest.createdAt || (row.createdAt === newest.createdAt && row._creationTime > newest._creationTime)) {
      newest = row;
    }
  }
  return newest;
}

export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<ChangesForTask | null> => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    const rows = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(FILE_CHANGE_LIMIT);
    const files = filesFromFileChanges(rows);
    const row = await newestPush(ctx, task._id);
    const pr = row ? prFacts(row) : null;
    const push: ChangesPush | null = row
      ? { status: row.status, ...(row.error ? { error: row.error } : {}), pr }
      : null;
    const flow = getChangesFlowState({
      proposedCount: files.length,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      push,
      isFixRunning: await fixInFlight(ctx, task._id),
    });
    return {
      taskId: task._id,
      source: row ? "branch" : files.length > 0 ? "proposed" : "none",
      ...(task.branchName ?? row?.branchName ? { branchName: task.branchName ?? row?.branchName } : {}),
      hasWorktree: Boolean(task.worktreePath),
      ...(row?.baseBranch ?? project?.mainBranch ? { base: row?.baseBranch ?? project?.mainBranch } : {}),
      files,
      commit: row
        ? {
            sha: row.commitSha,
            message: row.commitMessage,
            filesChanged: row.filesChanged,
            additions: row.additions,
            deletions: row.deletions,
            ahead: row.ahead,
            behind: row.behind,
            comparedTo: row.comparedTo,
          }
        : null,
      push,
      pr,
      flow,
    };
  },
});

export type BranchPatchResult =
  | { status: "not-committed" }
  | { status: "worktree-gone" }
  | { status: "ok"; patch: string; truncated: boolean; files: ChangesetFile[]; base: string; branchName: string };

export const branchPatch = action({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<BranchPatchResult | null> => {
    // The query carries the caller's identity: same visibility as forTask.
    const view: ChangesForTask | null = await ctx.runQuery(api.changes.forTask, { taskId: args.taskId });
    if (!view) return null;
    if (!view.hasWorktree) return { status: "worktree-gone" };
    if (view.source !== "branch" || !view.branchName) return { status: "not-committed" };
    const diff = (await ctx.runAction(internal.worktreeNode.getDiff, { taskId: args.taskId })) as {
      diff: string;
      truncated: boolean;
      files: ChangesetFile[];
      base: string;
      branchName: string;
    };
    return {
      status: "ok",
      patch: diff.diff,
      truncated: diff.truncated,
      files: diff.files,
      base: diff.base,
      branchName: diff.branchName,
    };
  },
});
