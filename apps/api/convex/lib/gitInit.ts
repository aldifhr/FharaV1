"use node";

import * as fs from "node:fs";
import * as path from "node:path";
import { checkRepoReadiness, withExcludeLine, worktreesExcludePattern, type RepoGit, type RepoReadiness } from "./repoReadiness";

/**
 * Lane git-init: the "Initialize git" action and the worktree exclude.
 * Never runs on its own: only the user's click (gitInit.initialize) calls
 * initializeRepo. Not destructive: `git init` on an existing repo is never
 * run, nothing is reset, and an existing history is left as is.
 */

/**
 * Keep the worktrees directory out of the repository: one line in
 * `.git/info/exclude` (local, never committed), so `git add -A` in the
 * initial commit, and `git status` afterwards, skip it.
 */
export function ensureWorktreesExcluded(repoRoot: string, worktreesBase: string, git: RepoGit): void {
  const pattern = worktreesExcludePattern(repoRoot, worktreesBase, path);
  if (!pattern) return;
  const excludePath = path.resolve(repoRoot, git(["rev-parse", "--git-path", "info/exclude"]).trim());
  let current = "";
  try {
    current = fs.readFileSync(excludePath, "utf-8");
  } catch {
    current = "";
  }
  const next = withExcludeLine(current, pattern);
  if (next === current) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.writeFileSync(excludePath, next, "utf-8");
}

/** Whether the repository's git config already names a committer. */
function hasConfiguredIdentity(git: RepoGit): boolean {
  const read = (key: string) => {
    try {
      return git(["config", "--get", key]).trim();
    } catch {
      return "";
    }
  };
  return Boolean(read("user.name") && read("user.email"));
}

export interface InitializeResult {
  /** `git init` ran (the folder was not a repository). */
  initialized: boolean;
  /** The initial commit was made (the repository had no commits). */
  committed: boolean;
  readiness: RepoReadiness;
}

/**
 * `git init` (when needed), the worktree exclude, then `git add -A` and an
 * initial commit (when HEAD is unborn). The author comes from the git
 * config; when it names none, `fallbackIdentityArgs` (`-c user.name=… -c
 * user.email=…`, the Fhara default or the Settings author) is used.
 */
export function initializeRepo(
  repoRoot: string,
  worktreesBase: string,
  git: RepoGit,
  fallbackIdentityArgs: string[]
): InitializeResult {
  fs.mkdirSync(repoRoot, { recursive: true });
  const before = checkRepoReadiness(git);
  let initialized = false;
  if (before.state === "not_git") {
    git(["init", "-q"]);
    initialized = true;
  }
  ensureWorktreesExcluded(repoRoot, worktreesBase, git);
  let committed = false;
  if (before.state !== "ready") {
    const identity = hasConfiguredIdentity(git) ? [] : fallbackIdentityArgs;
    git(["add", "-A"]);
    git([...identity, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Initial commit"]);
    committed = true;
  }
  return { initialized, committed, readiness: checkRepoReadiness(git) };
}
