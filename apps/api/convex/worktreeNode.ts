"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { internal } from "./_generated/api";

function gitExec(cwd: string, args: string[]): string {
  return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8", windowsHide: true });
}

function makeBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `fhara/${taskId}/${slug || "task"}`;
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

    const branchName = data.existingBranchName ?? makeBranchName(args.taskId, data.taskTitle);
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
      gitExec(data.workspacePath, ["merge", "--no-ff", data.branchName]);
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
      branchPrefix: string;
    } | null;
    if (!data) return;

    try {
      const currentWorktree = gitExec(data.workspacePath, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9))
        .pop();

      const orphanedWorktrees = gitExec(data.workspacePath, ["worktree", "list"])
        .split("\n")
        .filter((line) => line.includes(data.branchPrefix) && !line.includes("(bare)"));

      for (const wt of orphanedWorktrees) {
        const wtPath = wt.trim();
        if (!wtPath || wtPath === currentWorktree) continue;
        try {
          gitExec(data.workspacePath, ["worktree", "remove", "--force", wtPath]);
        } catch {}
      }
    } catch {}
  },
});
