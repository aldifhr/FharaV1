"use node";

import { internalAction, "use node" } from "./_generated/server";
import { v } from "convex/values";
import { gitExec, makeBranchName, resolveWorktreesBase } from "./git";
import { internal } from "./_generated/api";

/**
 * Node-only git worktree helpers used by orchestration mutations.
 * Convex restricts non-action exports from Node modules, so this file
 * exposes internal actions and delegates DB writes back.
 */
export const createBranch = internalAction({
  args: { taskId: v.id("tasks"), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.orchestration.getBranchContext, args)) as {
      taskTitle: string;
      workspacePath: string;
      worktreesPath?: string;
      mainBranch?: string;
      projectName: string;
      existingBranchName?: string;
      existingWorktreePath?: string;
    };

    const branchName = data.existingBranchName ?? makeBranchName(args.taskId, data.taskTitle);
    const worktreesBase = resolveWorktreesBase(data.workspacePath, data.worktreesPath);
    const worktreePath =
      data.existingWorktreePath ?? `${worktreesBase}/${data.projectName}/${branchName}`;
    const mainBranch = data.mainBranch ?? "main";

    try {
      gitExec(data.workspacePath, ["worktree", "add", "--force", "--detach", worktreePath]);
      gitExec(worktreePath, ["checkout", mainBranch]);
      gitExec(worktreePath, ["checkout", "-b", branchName]);
    } catch (err: any) {
      const msg = (err.message ?? "").toLowerCase();
      if (msg.includes("already exists")) {
        return { branchName, worktreePath };
      }
      if (msg.includes("dirty")) {
        throw new Error(
          `Repo has uncommitted changes; stash or commit them first: ${err.message}`,
        );
      }
      if (msg.includes("not a git repository")) {
        throw new Error(`Not a git repository at ${data.workspacePath}`);
      }
      throw new Error(`git worktree failed: ${err.message}`);
    }

    await ctx.runMutation(internal.orchestration.completeBranchCreation, {
      taskId: args.taskId,
      projectId: args.projectId,
      branchName,
      worktreePath,
    });

    return { branchName, worktreePath };
  },
});
