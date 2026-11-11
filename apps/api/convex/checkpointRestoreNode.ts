"use node";

/**
 * GOAT G6: the git side of "Revert to checkpoint", "Undo last apply" and
 * "Restore from snapshot" (lib/checkpointRestore.ts), run where the
 * worktrees live, like worktreeNode.ts. Called only from checkpointRestore.ts,
 * which checks visibility, task state and the push rows first.
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { gitExec } from "./worktreeNode";
import { settingFrom } from "./lib/appSettings";
import { gitIdentity, gitIdentityArgs } from "./lib/gitIdentity";
import { resolveRepoPath } from "./lib/workspacePath";
import {
  listWorktreeSnapshots,
  restoreToCheckpoint,
  restoreWorktreeSnapshot,
  revertCommitToCheckpoint,
  type RestoreOutcome,
  type RevertCommitOutcome,
  type SnapshotRestoreOutcome,
  type WorktreeSnapshot,
} from "./lib/checkpointRestore";
import type { GitSync } from "./lib/checkpointRefs";

const gitAt =
  (cwd: string): GitSync =>
  (args) =>
    gitExec(cwd, args);

export type CheckpointGitResult =
  | RestoreOutcome
  | RevertCommitOutcome
  | { status: "failed"; error: string };

export const restoreCheckpointGit = internalAction({
  args: {
    worktreePath: v.string(),
    commitSha: v.string(),
    headSha: v.optional(v.string()),
    n: v.number(),
    mode: v.union(v.literal("restore"), v.literal("revert-commit")),
    pushedInFhara: v.boolean(),
  },
  handler: async (ctx, args): Promise<CheckpointGitResult> => {
    try {
      const git = gitAt(args.worktreePath);
      if (args.mode === "restore") {
        return restoreToCheckpoint(
          git,
          { commitSha: args.commitSha, ...(args.headSha ? { headSha: args.headSha } : {}) },
          { pushedInFhara: args.pushedInFhara }
        );
      }
      // Settings → Source control: the UI author overrides the env one, as for merges.
      const settings = (await ctx.runQuery(internal.appSettings.forWorker, {})).values;
      const identity = gitIdentity({
        FHARA_GIT_AUTHOR_NAME: settingFrom(settings, "FHARA_GIT_AUTHOR_NAME"),
        FHARA_GIT_AUTHOR_EMAIL: settingFrom(settings, "FHARA_GIT_AUTHOR_EMAIL"),
      });
      return revertCommitToCheckpoint(git, { commitSha: args.commitSha, n: args.n }, gitIdentityArgs(identity));
    } catch (err) {
      return { status: "failed", error: String((err as Error)?.message ?? err).slice(0, 500) };
    }
  },
});

export const listSnapshotsGit = internalAction({
  args: { repoPath: v.string(), worktreePath: v.optional(v.string()), taskId: v.id("tasks") },
  handler: async (_ctx, args): Promise<WorktreeSnapshot[]> => {
    try {
      const repo = resolveRepoPath(args.repoPath, { worktreePath: args.worktreePath });
      return listWorktreeSnapshots(gitAt(repo), args.taskId);
    } catch {
      return [];
    }
  },
});

export const restoreSnapshotGit = internalAction({
  args: {
    repoPath: v.string(),
    taskId: v.id("tasks"),
    ref: v.optional(v.string()),
    branch: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<SnapshotRestoreOutcome | { status: "failed"; error: string }> => {
    try {
      const repo = resolveRepoPath(args.repoPath);
      const snapshots = listWorktreeSnapshots(gitAt(repo), args.taskId);
      const snapshot = args.ref ? snapshots.find((row) => row.ref === args.ref) : snapshots[0];
      if (!snapshot) return { status: "missing", detail: "no snapshot for this task" };
      return restoreWorktreeSnapshot(gitAt, repo, snapshot, args.branch ? { branch: args.branch } : {});
    } catch (err) {
      return { status: "failed", error: String((err as Error)?.message ?? err).slice(0, 500) };
    }
  },
});
