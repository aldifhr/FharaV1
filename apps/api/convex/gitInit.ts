"use node";

import { action, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import * as fs from "node:fs";
import * as path from "node:path";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { gitExec } from "./worktreeNode";
import { gitIdentity, gitIdentityArgs } from "./lib/gitIdentity";
import { settingFrom } from "./lib/appSettings";
import { initializeRepo } from "./lib/gitInit";
import { checkRepoReadiness, plainServerError, worktreesBaseFor, type RepoReadiness } from "./lib/repoReadiness";
import { resolveRepoPath } from "./lib/workspacePath";

/**
 * Lane git-init: "Initialize git" in project settings, on a held task and
 * when adding a project. Runs only on the user's click; never automatic.
 * git runs with execFile (gitExec), no shell, so Windows paths and spaces
 * pass through as one argument.
 */

const targetArgs = {
  projectId: v.optional(v.id("projects")),
  taskId: v.optional(v.id("tasks")),
  /** New-project form only: the folder typed before the project exists. */
  workspacePath: v.optional(v.string()),
};

type Target = { projectId?: Id<"projects">; root: string; worktreesPath?: string };

async function resolveTarget(
  ctx: ActionCtx,
  args: { projectId?: Id<"projects">; taskId?: Id<"tasks">; workspacePath?: string }
): Promise<Target> {
  if (args.projectId || args.taskId) {
    const t = (await ctx.runQuery(internal.repoHold.target, { projectId: args.projectId, taskId: args.taskId })) as {
      projectId: Id<"projects">;
      workspacePath: string;
      worktreesPath?: string;
    };
    return { projectId: t.projectId, root: resolveRepoPath(t.workspacePath), worktreesPath: t.worktreesPath };
  }
  if (!args.workspacePath?.trim()) throw new Error("Set the project's folder path first");
  return { root: resolveRepoPath(args.workspacePath) };
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The folder's readiness; `missing` while it does not exist yet (the worker creates it). */
export const status = action({
  args: targetArgs,
  handler: async (ctx, args): Promise<RepoReadiness | { state: "missing" }> => {
    const target = await resolveTarget(ctx, args);
    if (!isDir(target.root)) return { state: "missing" };
    return checkRepoReadiness((gitArgs) => gitExec(target.root, gitArgs));
  },
});

/**
 * `git init` when needed, the worktree exclude, `git add -A` and the
 * initial commit when HEAD is unborn; then the tasks this held are
 * re-queued. Errors come back as one plain line.
 */
export const initialize = action({
  args: targetArgs,
  handler: async (
    ctx,
    args
  ): Promise<{ ok: true; initialized: boolean; committed: boolean; resumed: number } | { ok: false; error: string }> => {
    try {
      const target = await resolveTarget(ctx, args);
      const settings = (await ctx.runQuery(internal.appSettings.forWorker, {})).values as Record<string, string>;
      const identity = gitIdentity({
        FHARA_GIT_AUTHOR_NAME: settingFrom(settings, "FHARA_GIT_AUTHOR_NAME"),
        FHARA_GIT_AUTHOR_EMAIL: settingFrom(settings, "FHARA_GIT_AUTHOR_EMAIL"),
      });
      fs.mkdirSync(target.root, { recursive: true });
      const result = initializeRepo(
        target.root,
        worktreesBaseFor(target.root, target.worktreesPath, path),
        (gitArgs) => gitExec(target.root, gitArgs, 16 * 1024 * 1024),
        gitIdentityArgs(identity)
      );
      if (result.readiness.state !== "ready") return { ok: false, error: result.readiness.message };
      const resumed = target.projectId
        ? (await ctx.runMutation(internal.repoHold.resumeAfterInit, { projectId: target.projectId, taskId: args.taskId })).resumed
        : 0;
      return { ok: true, initialized: result.initialized, committed: result.committed, resumed };
    } catch (err) {
      return { ok: false, error: plainServerError(err instanceof Error ? err.message : String(err)) };
    }
  },
});
