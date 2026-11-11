"use node";

import { resolveProjectPath } from "@fhara/config";
import { cenvRaw } from "@fhara/config/convex";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Absolute repository path for a project's `workspacePath` before any git /
 * spawn call (live test 4: a project saved as "live4-demo" made every
 * `git worktree add` fail with `spawnSync git ENOENT`, because the
 * relative cwd did not exist for the Convex process).
 *
 * The worker resolves a relative project path under its WORKSPACE_ROOT
 * (packages/worker resolveWorkspacePath), so the same rule applies here,
 * in this order:
 *   1. an absolute path is used as is;
 *   2. the worker's absolute workspace root, when the call carries it;
 *   3. the main checkout of an existing task worktree (its `.git` file
 *      names it), for merge / discard calls on a task created earlier;
 *   4. WORKSPACE_ROOT from this process's env (relative to its cwd);
 *   5. this process's cwd.
 */
export function resolveRepoPath(
  configured: string,
  options: { workspaceRoot?: string; worktreePath?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): string {
  const raw = (configured ?? "").trim();
  if (!raw) throw new Error("The project has no workspace path; set one in the project settings");
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const cwd = options.cwd ?? process.cwd();
  // B7: the shared rule (@fhara/config resolveProjectPath). This process
  // cannot see packages/worker, so a relative root is measured from its cwd;
  // the worker sends its absolute root, which wins.
  if (options.workspaceRoot && options.workspaceRoot.trim()) {
    return resolveProjectPath(raw, options.workspaceRoot.trim(), cwd, path);
  }
  const fromWorktree = options.worktreePath ? mainCheckoutOfWorktree(options.worktreePath) : null;
  if (fromWorktree) return fromWorktree;
  const envRoot = cenvRaw("WORKSPACE_ROOT", options.env);
  return resolveProjectPath(raw, envRoot?.trim() || ".", cwd, path);
}

/** Throws a clear error when the resolved repository path does not exist. */
export function assertRepoPathExists(resolved: string, configured: string): void {
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(
      `Project workspace path does not exist: ${resolved}${
        configured && configured !== resolved ? ` (configured as "${configured}")` : ""
      }. Set an absolute path to the project's git checkout in the project settings.`
    );
  }
}

/** The main checkout of a linked git worktree (from its `.git` file), or null. */
export function mainCheckoutOfWorktree(worktreePath: string): string | null {
  if (!path.isAbsolute(worktreePath)) return null;
  try {
    const gitFile = path.join(worktreePath, ".git");
    if (!fs.statSync(gitFile).isFile()) return null;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitFile, "utf-8"))?.[1]?.trim();
    if (!gitdir) return null;
    const absolute = path.resolve(worktreePath, gitdir);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const index = absolute.lastIndexOf(marker);
    return index === -1 ? null : absolute.slice(0, index);
  } catch {
    return null;
  }
}
