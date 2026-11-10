"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { internal } from "./_generated/api";
import { buildChildEnv } from "./lib/childEnv";
import { gitIdentityArgs } from "./lib/gitIdentity";
import { makeTaskBranchName, resolveMainBranch, taskWorktreesFromPorcelain } from "./lib/taskBranch";
import { worktreeRetentionMs } from "./lib/worktreeRetention";
import { assertRepoPathExists, resolveRepoPath } from "./lib/workspacePath";
import type { Id } from "./_generated/dataModel";

// execFile, not a shell string: branch names, paths and the identity
// (`user.name=Some Name`) are passed as argv, never re-split or interpreted.
function gitExec(cwd: string, args: string[]): string {
  // A relative or missing cwd surfaced as "spawnSync git ENOENT" (live
  // test 4): resolve it and fail with a clear message instead.
  const dir = resolveRepoPath(cwd);
  assertRepoPathExists(dir, cwd);
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", windowsHide: true, env: buildChildEnv() });
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
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    /** The worker's absolute WORKSPACE_ROOT: a relative project path resolves under it, as in the worker. */
    workspaceRoot: v.optional(v.string()),
  },
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

    // Absolute before any git / spawn call; a clear error when it is missing.
    const workspacePath = resolveRepoPath(data.workspacePath, { workspaceRoot: args.workspaceRoot });
    assertRepoPathExists(workspacePath, data.workspacePath);
    const branchName = data.existingBranchName ?? makeTaskBranchName(args.taskId, data.taskTitle);
    const worktreesBase = data.worktreesPath
      ? path.resolve(workspacePath, data.worktreesPath)
      : path.join(workspacePath, ".moagent-worktrees");
    const worktreePath =
      data.existingWorktreePath ?? `${worktreesBase}/${data.projectName}/${branchName}`;
    // Configured base branch, else detected (origin/HEAD → main → master):
    // a hard-coded "main" failed every task on a master repo.
    const mainBranch = resolveMainBranch(data.mainBranch, (gitArgs) => gitExec(workspacePath, gitArgs));

    try {
      // Create worktree directly on new branch from main (avoid checkout main in new wt)
      gitExec(workspacePath, ["worktree", "add", "-b", branchName, worktreePath, mainBranch]);
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
        throw new Error(`Not a git repository at ${workspacePath}`);
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
      mainBranch?: string;
    };
    const mainBranch = resolveMainBranch(data.mainBranch, (gitArgs) => gitExec(data.worktreePath, gitArgs));

    try {
      const diff = gitExec(data.worktreePath, ["diff", `${mainBranch}..${data.branchName}`]);
      const rawFiles = gitExec(data.worktreePath, [
        "diff",
        "--name-status",
        `${mainBranch}..${data.branchName}`,
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
      mainBranch?: string;
      projectId: string;
      keepWorktree?: boolean;
    };
    const repo = resolveRepoPath(data.workspacePath, { worktreePath: data.worktreePath });
    const mainBranch = resolveMainBranch(data.mainBranch, (gitArgs) => gitExec(repo, gitArgs));

    try {
      gitExec(repo, ["checkout", mainBranch]);
      gitCommitExec(repo, ["merge", "--no-ff", "--no-edit", data.branchName]);
    } catch (err: any) {
      await ctx.runMutation(internal.orchestration.mergeBranchCompleted, {
        taskId: args.taskId,
        projectId: data.projectId as any,
        branchName: data.branchName,
        conflict: err.message,
      });
      throw new Error(`Merge failed: ${err.message}`);
    }

    // Post-push feedback loop: keep the branch and worktree until the PR
    // closes, so CI / review fixes land on the same PR.
    if (!data.keepWorktree) {
      try {
        gitExec(repo, ["worktree", "remove", data.worktreePath]);
        gitExec(repo, ["branch", "-D", data.branchName]);
      } catch {
        // cleanup failures are non-fatal
      }
    }

    return await ctx.runMutation(internal.orchestration.mergeBranchCompleted, {
      taskId: args.taskId,
      projectId: data.projectId as any,
      branchName: data.branchName,
      ...(data.keepWorktree ? { kept: true } : {}),
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
    const repo = resolveRepoPath(data.workspacePath, { worktreePath: data.worktreePath });

    if (data.worktreePath) {
      try {
        gitExec(repo, ["worktree", "remove", "--force", data.worktreePath]);
      } catch {}
    }
    if (data.branchName) {
      try {
        gitExec(repo, ["branch", "-D", data.branchName]);
      } catch {}
    }

    await ctx.runMutation(internal.orchestration.discardBranchDone, {
      taskId: args.taskId,
      projectId: data.projectId as any,
      branchName: data.branchName,
    });
  },
});

/**
 * Remove every worktree of this task (fhara/<id>/ and legacy moagent/<id>/
 * branches, read from `worktree list --porcelain`), never the main
 * checkout. Branches are kept. Returns the removed paths.
 */
function removeTaskWorktrees(workspacePath: string, taskId: string): string[] {
  const removed: string[] = [];
  try {
    // Porcelain output, matched on the branch: the human `worktree list`
    // lines start with the path followed by sha and branch, so they never
    // named a removable path.
    const porcelain = gitExec(workspacePath, ["worktree", "list", "--porcelain"]);
    const main = resolveRepoPath(workspacePath);
    for (const wtPath of taskWorktreesFromPorcelain(porcelain, taskId)) {
      if (path.resolve(wtPath) === main) continue;
      try {
        gitExec(workspacePath, ["worktree", "remove", "--force", wtPath]);
        removed.push(wtPath);
      } catch {}
    }
    try {
      gitExec(workspacePath, ["worktree", "prune"]);
    } catch {}
  } catch {}
  return removed;
}

export const cleanupStaleWorktrees = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.orchestration.cleanupWorktreeContext, args)) as {
      workspacePath: string;
      branchPrefixes: string[];
    } | null;
    if (!data) return [];
    return removeTaskWorktrees(data.workspacePath, args.taskId);
  },
});

/**
 * Cron sweep: remove the worktrees of finished tasks past the retention
 * window (FHARA_WORKTREE_RETENTION_HOURS, default 72) unless their PR is
 * still open or a push is in flight. The task branch is kept.
 */
export const sweepStaleWorktrees = internalAction({
  args: {},
  handler: async (ctx) => {
    const tasks = (await ctx.runQuery(internal.orchestration.listStaleWorktreeTasks, {
      now: Date.now(),
      retentionMs: worktreeRetentionMs(),
    })) as Array<{ taskId: Id<"tasks"> }>;
    let cleaned = 0;
    for (const { taskId } of tasks) {
      const data = (await ctx.runQuery(internal.orchestration.cleanupWorktreeContext, { taskId })) as {
        workspacePath: string;
      } | null;
      if (!data) continue;
      const removed = removeTaskWorktrees(data.workspacePath, taskId);
      await ctx.runMutation(internal.orchestration.worktreeCleaned, { taskId, removed });
      cleaned += 1;
    }
    return { cleaned };
  },
});

/**
 * Post-push feedback loop: the PR of a task merged or closed, so the
 * worktree and local branch kept for fixes are removed (prFeedback).
 */
export const releasePrWorktree = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.prFeedback.getReleaseContext, args);
    if (!data) return;
    const repo = resolveRepoPath(data.workspacePath, { worktreePath: data.worktreePath });
    try {
      gitExec(repo, ["worktree", "remove", "--force", data.worktreePath]);
    } catch {}
    try {
      gitExec(repo, ["branch", "-D", data.branchName]);
    } catch {}
    await ctx.runMutation(internal.prFeedback.worktreeReleased, args);
  },
});
