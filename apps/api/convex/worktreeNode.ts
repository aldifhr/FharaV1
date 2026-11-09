"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { internal } from "./_generated/api";
import { buildChildEnv } from "./lib/childEnv";
import { gitIdentityArgs } from "./lib/gitIdentity";
import { makeTaskBranchName, taskWorktreesFromPorcelain } from "./lib/taskBranch";

// execFile, not a shell string: branch names, paths and the identity
// (`user.name=Some Name`) are passed as argv, never re-split or interpreted.
function gitExec(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true, env: buildChildEnv() });
}

/**
 * git commands that write commits (merge, commit) carry the Fhara identity
 * per command: the scrubbed child env has no GIT_AUTHOR_*, and a fresh
 * clone has no user.name/user.email, so git would refuse with "Committer
 * identity unknown".
 */
function gitCommitExec(cwd: string, args: string[]): string {
  return gitExec(cwd, [...gitIdentityArgs(), ...args]);
}

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

    const branchName = data.existingBranchName ?? makeTaskBranchName(args.taskId, data.taskTitle);
    const worktreesBase = data.worktreesPath ?? path.join(data.workspacePath, ".moagent-worktrees");
    const worktreePath =
      data.existingWorktreePath ?? `${worktreesBase}/${data.projectName}/${branchName}`;
    const mainBranch = data.mainBranch ?? "main";

    try {
      // Create worktree directly on new branch from main (avoid checkout main in new wt)
      gitExec(data.workspacePath, ["worktree", "add", "-b", branchName, worktreePath, mainBranch]);
    } catch (err: any) {
      const msg = (err.message ?? "").toLowerCase();
      if (msg.includes("already exists") || msg.includes("already checked out")) {
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

export const getDiff = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.orchestration.getDiffContext, args)) as {
      worktreePath: string;
      branchName: string;
      mainBranch: string;
    };

    try {
      const diff = gitExec(data.worktreePath, ["diff", `${data.mainBranch}..${data.branchName}`]);
      const rawFiles = gitExec(data.worktreePath, [
        "diff",
        "--name-status",
        `${data.mainBranch}..${data.branchName}`,
      ])
        .trim()
        .split("\n")
        .filter(Boolean);

      const files = rawFiles.map((line) => {
        const [status, ...pathParts] = line.split("\t");
        return { path: pathParts.join("\t"), status };
      });

      return { diff, fileCount: files.length, files };
    } catch {
      return { diff: "", fileCount: 0, files: [] };
    }
  },
});

export const mergeBranch = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const data = (await ctx.runQuery(internal.orchestration.getMergeContext, args)) as {
      branchName: string;
      worktreePath: string;
      workspacePath: string;
      mainBranch: string;
      projectId: string;
    };

    try {
      gitExec(data.workspacePath, ["checkout", data.mainBranch]);
      gitCommitExec(data.workspacePath, ["merge", "--no-ff", "--no-edit", data.branchName]);
    } catch (err: any) {
      await ctx.runMutation(internal.orchestration.mergeBranchCompleted, {
        taskId: args.taskId,
        projectId: data.projectId as any,
        branchName: data.branchName,
        conflict: err.message,
      });
      throw new Error(`Merge failed: ${err.message}`);
    }

    try {
      gitExec(data.workspacePath, ["worktree", "remove", data.worktreePath]);
      gitExec(data.workspacePath, ["branch", "-D", data.branchName]);
    } catch {
      // cleanup failures are non-fatal
    }

    return await ctx.runMutation(internal.orchestration.mergeBranchCompleted, {
      taskId: args.taskId,
      projectId: data.projectId as any,
      branchName: data.branchName,
    });
  },
});

export const discardBranch = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.orchestration.getDiscardContext, args)) as {
      workspacePath: string;
      worktreePath?: string;
      branchName?: string;
      projectId: string;
    } | null;
    if (!data) return;

    if (data.worktreePath) {
      try {
        gitExec(data.workspacePath, ["worktree", "remove", "--force", data.worktreePath]);
      } catch {}
    }
    if (data.branchName) {
      try {
        gitExec(data.workspacePath, ["branch", "-D", data.branchName]);
      } catch {}
    }

    await ctx.runMutation(internal.orchestration.discardBranchDone, {
      taskId: args.taskId,
      projectId: data.projectId as any,
      branchName: data.branchName,
    });
  },
});

export const cleanupStaleWorktrees = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.orchestration.cleanupWorktreeContext, args)) as {
      workspacePath: string;
      branchPrefixes: string[];
    } | null;
    if (!data) return;

    try {
      // Porcelain output, matched on the branch (fhara/<id>/ and the legacy
      // moagent/<id>/): the human `worktree list` lines start with the path
      // followed by sha and branch, so they never named a removable path.
      const porcelain = gitExec(data.workspacePath, ["worktree", "list", "--porcelain"]);
      const main = path.resolve(data.workspacePath);
      for (const wtPath of taskWorktreesFromPorcelain(porcelain, args.taskId)) {
        if (path.resolve(wtPath) === main) continue;
        try {
          gitExec(data.workspacePath, ["worktree", "remove", "--force", wtPath]);
        } catch {}
      }
    } catch {}
  },
});
