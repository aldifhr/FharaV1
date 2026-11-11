"use node";

import { internalAction, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { internal } from "./_generated/api";
import { buildChildEnv } from "./lib/childEnv";
import { gitIdentity, gitIdentityArgs } from "./lib/gitIdentity";
import { settingFrom } from "./lib/appSettings";
import { makeTaskBranchName, resolveMainBranch } from "./lib/taskBranch";
import { worktreeRetentionMs } from "./lib/worktreeRetention";
import { assertRepoPathExists, resolveRepoPath } from "./lib/workspacePath";
import { checkRepoReadiness, taskWorktreePath, worktreesBaseFor } from "./lib/repoReadiness";
import { ensureWorktreesExcluded } from "./lib/gitInit";
import { buildBranchPatch, type GitRun } from "./lib/diffPatch";
import { deleteTaskCheckpointRefs, removeTaskGitState } from "./lib/checkpointRefs";
import { captureWorktreeSnapshot, pruneWorktreeSnapshots, type WorktreeSnapshot } from "./lib/checkpointRestore";
import type { Id } from "./_generated/dataModel";

// execFile, not a shell string: branch names, paths and the identity
// (`user.name=Some Name`) are passed as argv, never re-split or interpreted.
export function gitExec(cwd: string, args: string[], maxBuffer?: number, env?: Record<string, string>): string {
  // A relative or missing cwd surfaced as "spawnSync git ENOENT" (live
  // test 4): resolve it and fail with a clear message instead.
  const dir = resolveRepoPath(cwd);
  assertRepoPathExists(dir, cwd);
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf-8",
    windowsHide: true,
    env: buildChildEnv(env),
    ...(maxBuffer ? { maxBuffer } : {}),
  });
}

/**
 * Paradev A1: `gitExec` with a byte cap for diffs. Past `maxBuffer` git is
 * killed (ENOBUFS) and the output read so far is kept for the budget cut
 * in lib/diffPatch.ts, instead of failing the whole diff.
 */
function gitRunBounded(cwd: string): GitRun {
  return (args, maxBuffer) => {
    try {
      return { stdout: gitExec(cwd, args, maxBuffer), overflowed: false };
    } catch (err: any) {
      if (err?.code !== "ENOBUFS") throw err;
      return { stdout: String(err.stdout ?? ""), overflowed: true };
    }
  };
}

/**
 * git commands that write commits (merge, commit) carry the Fhara identity
 * per command: the scrubbed child env has no GIT_AUTHOR_*, and a fresh
 * clone has no user.name/user.email, so git would refuse with "Committer
 * identity unknown".
 */
function gitCommitExec(cwd: string, args: string[], settings?: Record<string, string>): string {
  // Settings → Source control: the UI author overrides the env one.
  const identity = gitIdentity({
    FHARA_GIT_AUTHOR_NAME: settingFrom(settings, "FHARA_GIT_AUTHOR_NAME"),
    FHARA_GIT_AUTHOR_EMAIL: settingFrom(settings, "FHARA_GIT_AUTHOR_EMAIL"),
  });
  return gitExec(cwd, [...gitIdentityArgs(identity), ...args]);
}

export const createBranch = internalAction({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    /** The worker's absolute WORKSPACE_ROOT: a relative project path resolves under it, as in the worker. */
    workspaceRoot: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Only the ids: getBranchContext's validator has no workspaceRoot, and
    // passing `args` whole failed every isolated task once the worker sent
    // its WORKSPACE_ROOT ("extra field `workspaceRoot`").
    const data = (await ctx.runQuery(internal.orchestration.getBranchContext, {
      taskId: args.taskId,
      projectId: args.projectId,
    })) as {
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
    const worktreesBase = worktreesBaseFor(workspacePath, data.worktreesPath, path);
    // path.join, not a template: on Windows the old one mixed `\` and `/`.
    const worktreePath = data.existingWorktreePath ?? taskWorktreePath(worktreesBase, data.projectName, branchName, path);
    const git = (gitArgs: string[]) => gitExec(workspacePath, gitArgs);
    // Lane git-init: a plain folder or an unborn HEAD holds the task with a
    // plain line (a value, not a throw: no Request ID or stack reaches the card).
    const readiness = checkRepoReadiness(git);
    if (readiness.state !== "ready") return { held: true as const, state: readiness.state, reason: readiness.message };
    ensureWorktreesExcluded(workspacePath, worktreesBase, git);
    // Configured base branch, else detected (origin/HEAD → main → master):
    // a hard-coded "main" failed every task on a master repo.
    const mainBranch = resolveMainBranch(data.mainBranch, git);

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

    // GOAT G9: `created` tells the worker this worktree is new, so the
    // project's setup script runs once (never on a reused worktree).
    return { branchName, worktreePath, created: true as const };
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
      // Paradev A1: safe -c config + base args (a user's diff.noprefix or
      // quotePath cannot change the patch shape) and a byte budget with a
      // truncation marker (lib/diffPatch.ts).
      const { patch, truncated, files } = buildBranchPatch(
        gitRunBounded(data.worktreePath),
        mainBranch,
        data.branchName,
      );
      return { diff: patch, truncated, fileCount: files.length, files, base: mainBranch, branchName: data.branchName };
    } catch {
      return { diff: "", truncated: false, fileCount: 0, files: [], base: mainBranch, branchName: data.branchName };
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

    const settings = (await ctx.runQuery(internal.appSettings.forWorker, {})).values;
    try {
      gitExec(repo, ["checkout", mainBranch]);
      gitCommitExec(repo, ["merge", "--no-ff", "--no-edit", data.branchName], settings);
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
      await dropCheckpointRefs(ctx, repo, args.taskId);
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
    await dropCheckpointRefs(ctx, repo, args.taskId);

    await ctx.runMutation(internal.orchestration.discardBranchDone, {
      taskId: args.taskId,
      projectId: data.projectId as any,
      branchName: data.branchName,
    });
  },
});

/**
 * GOAT G5: delete the task's hidden checkpoint refs (lib/checkpointRefs.ts)
 * and mark its rows, when its worktree goes for good. Best effort.
 */
async function dropCheckpointRefs(ctx: ActionCtx, repo: string, taskId: Id<"tasks">): Promise<void> {
  try {
    if (deleteTaskCheckpointRefs((args) => gitExec(repo, args), taskId).length > 0) {
      await ctx.runMutation(internal.checkpoints.refsDeleted, { taskId });
    }
  } catch {}
}

/**
 * Remove every worktree of this task (fhara/<id>/ and legacy moagent/<id>/
 * branches, read from `worktree list --porcelain`), never the main
 * checkout, and (GOAT G5) its checkpoint refs. Branches are kept.
 */
function removeTaskWorktrees(
  workspacePath: string,
  taskId: string,
  beforeRemove?: (worktreePath: string) => void
): { removed: string[]; refsDeleted: string[]; kept: string[] } {
  let main: string;
  try {
    main = resolveRepoPath(workspacePath);
  } catch {
    return { removed: [], refsDeleted: [], kept: [] };
  }
  const isMain = (wtPath: string) => path.resolve(wtPath) === main;
  return removeTaskGitState((args) => gitExec(workspacePath, args), taskId, isMain, beforeRemove);
}

/** GOAT G6: snapshot a worktree into `refs/fhara/snapshots/<taskId>/<ms>` (lib/checkpointRestore.ts). Throws on failure. */
function snapshotWorktree(worktreePath: string, taskId: string, now: number): WorktreeSnapshot {
  return captureWorktreeSnapshot(
    {
      git: (args, env) => gitExec(worktreePath, args, undefined, env),
      removeFile: (file) => rmSync(file, { force: true }),
    },
    taskId,
    now,
    { worktreePath }
  );
}

export const cleanupStaleWorktrees = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.orchestration.cleanupWorktreeContext, args)) as {
      workspacePath: string;
      branchPrefixes: string[];
    } | null;
    if (!data) return [];
    const { removed, refsDeleted } = removeTaskWorktrees(data.workspacePath, args.taskId);
    if (refsDeleted.length > 0) await ctx.runMutation(internal.checkpoints.refsDeleted, { taskId: args.taskId });
    return removed;
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
    // Settings → Worktrees: the UI retention overrides the env one.
    const settings = (await ctx.runQuery(internal.appSettings.forWorker, {})).values;
    const tasks = (await ctx.runQuery(internal.orchestration.listStaleWorktreeTasks, {
      now: Date.now(),
      retentionMs: worktreeRetentionMs(settingFrom(settings, "FHARA_WORKTREE_RETENTION_HOURS")),
    })) as Array<{ taskId: Id<"tasks"> }>;
    let cleaned = 0;
    let snapshotFailed = 0;
    for (const { taskId } of tasks) {
      const data = (await ctx.runQuery(internal.orchestration.cleanupWorktreeContext, { taskId })) as {
        workspacePath: string;
      } | null;
      if (!data) continue;
      // GOAT G6: snapshot before removal; a failed snapshot keeps the worktree for the next sweep.
      const snapshots: WorktreeSnapshot[] = [];
      const { removed, refsDeleted, kept } = removeTaskWorktrees(data.workspacePath, taskId, (wtPath) => {
        snapshots.push(snapshotWorktree(wtPath, taskId, Date.now()));
      });
      for (const snapshot of snapshots) {
        await ctx.runMutation(internal.checkpointRestore.snapshotTaken, { taskId, ...snapshotEvent(snapshot) });
      }
      if (kept.length > 0) {
        snapshotFailed += 1;
        continue;
      }
      await ctx.runMutation(internal.orchestration.worktreeCleaned, { taskId, removed });
      if (refsDeleted.length > 0) await ctx.runMutation(internal.checkpoints.refsDeleted, { taskId });
      cleaned += 1;
    }
    const snapshotsPruned = await pruneSnapshotRefs(ctx);
    return { cleaned, snapshotFailed, snapshotsPruned };
  },
});

function snapshotEvent(snapshot: WorktreeSnapshot) {
  return {
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    headSha: snapshot.headSha,
    ...(snapshot.worktreePath ? { worktreePath: snapshot.worktreePath } : {}),
  };
}

/** GOAT G6 retention: snapshot refs older than 7 days (SNAPSHOT_RETENTION_MS), in every project repo. */
async function pruneSnapshotRefs(ctx: ActionCtx): Promise<number> {
  const repos = (await ctx.runQuery(internal.checkpointRestore.snapshotRepos, {})) as string[];
  let pruned = 0;
  const seen = new Set<string>();
  for (const workspacePath of repos) {
    try {
      const repo = resolveRepoPath(workspacePath);
      if (seen.has(repo)) continue;
      seen.add(repo);
      pruned += pruneWorktreeSnapshots((args) => gitExec(repo, args), Date.now()).length;
    } catch {}
  }
  return pruned;
}

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
    await dropCheckpointRefs(ctx, repo, args.taskId);
    await ctx.runMutation(internal.prFeedback.worktreeReleased, args);
  },
});

/**
 * GOAT G5: patch and file list between two checkpoint commits (or a
 * checkpoint and the HEAD it was captured on), with the Paradev A1 safe
 * config and byte budget (lib/diffPatch.ts). The commits live in the
 * shared object store, so the main checkout reads them after the worktree
 * is gone. `ok: false` when either commit is missing.
 */
export const checkpointDiff = internalAction({
  args: { repoPath: v.string(), worktreePath: v.optional(v.string()), fromSha: v.string(), toSha: v.string() },
  handler: async (_ctx, args) => {
    const empty = { ok: false, patch: "", truncated: false, files: [] };
    if (!/^[0-9a-f]{40,64}$/.test(args.fromSha) || !/^[0-9a-f]{40,64}$/.test(args.toSha)) return empty;
    try {
      const repo = resolveRepoPath(args.repoPath, { worktreePath: args.worktreePath });
      for (const sha of [args.fromSha, args.toSha]) gitExec(repo, ["cat-file", "-e", `${sha}^{commit}`]);
      return { ok: true, ...buildBranchPatch(gitRunBounded(repo), args.fromSha, args.toSha) };
    } catch {
      return empty;
    }
  },
});
