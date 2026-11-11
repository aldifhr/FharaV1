import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, assertTaskAccess } from "./lib/authz";
import { appendTaskEvent } from "./lib/taskEvents";
import { classifyRepoHold } from "./lib/repoReadiness";
import { patchTask } from "./lib/threadIndex";
import { requeueForRetry } from "./tasks";

/**
 * Lane git-init: the database half of "Initialize git" (gitInit.ts runs
 * git). `target` resolves the project root the caller may act on;
 * `resumeAfterInit` re-queues the tasks the missing repository held.
 */

export const target = internalQuery({
  args: { projectId: v.optional(v.id("projects")), taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, args) => {
    const task = args.taskId ? await assertTaskAccess(ctx, args.taskId) : null;
    const projectId = (task?.projectId ?? args.projectId) as Id<"projects"> | undefined;
    if (!projectId) throw new Error("A project or task is required");
    const project = await assertProjectAccess(ctx, projectId);
    return { projectId: project._id, workspacePath: project.workspacePath, worktreesPath: project.worktreesPath };
  },
});

/** A task waiting on the repository: on a "repo" hold, or failed with the readiness / old raw error. */
function heldByRepo(task: Doc<"tasks">): boolean {
  if (task.status === "paused" && task.pausedBy === "held" && task.hold?.kind === "repo") return true;
  return task.status === "failed" && classifyRepoHold(task.errorMessage) !== null;
}

/**
 * Re-queues the project's tasks the repository held (the clicked task
 * first), so the next claim gets a worktree. Other tasks are untouched.
 */
export const resumeAfterInit = internalMutation({
  args: { projectId: v.id("projects"), taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, args): Promise<{ resumed: number }> => {
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);
    let resumed = 0;
    const now = Date.now();
    for (const task of rows) {
      if (!heldByRepo(task)) continue;
      if (task.status === "failed") {
        await requeueForRetry(ctx, task);
      } else {
        await patchTask(ctx, task._id, {
          status: "queued",
          pausedBy: undefined,
          pausedAt: undefined,
          hold: undefined,
          workerId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
        await appendTaskEvent(ctx, {
          taskId: task._id,
          projectId: task.projectId,
          type: "task.resumed",
          payload: { resumedBy: "git_init" },
          level: "info",
        });
      }
      resumed++;
    }
    return { resumed };
  },
});
