/**
 * Repository readiness for worktree isolation (lane git-init).
 *
 * A task runs in its own `git worktree`, which needs a real repository with
 * at least one commit. A plain folder failed deep in the worker with a raw
 * server error ("[Request ID: …] Server Error Uncaught Error: Not a git
 * repository at D:\…"), and a fresh `git init` with no commit failed with
 * "fatal: invalid reference: master". Both now hold the task with one plain
 * line and an "Initialize git" action instead.
 *
 * Pure (no node imports): shared by the backend, the worker and the web UI.
 * The path helpers take the `path` flavour so Windows paths are testable on
 * any host (`path.win32`).
 */

export const NOT_GIT_MESSAGE = "This project folder isn't a git repository. Initialize git to run tasks.";
export const NO_COMMITS_MESSAGE = "This repository has no commits yet. Create an initial commit to run tasks.";

/** The worktree directory inside the project (old name kept on purpose, see taskBranch.ts). */
export const WORKTREES_DIR = ".moagent-worktrees";

export type RepoReadiness =
  | { state: "ready" }
  | { state: "not_git"; message: string }
  | { state: "no_commits"; message: string };

/** Runs one git command in the project root; throws on a non-zero exit. */
export type RepoGit = (args: string[]) => string;

/**
 * Whether tasks can get a worktree here: a git work tree (`rev-parse
 * --is-inside-work-tree`) whose HEAD points at a commit. An unborn HEAD
 * (`git init` with no commit yet) counts as not ready.
 */
export function checkRepoReadiness(git: RepoGit): RepoReadiness {
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
      return { state: "not_git", message: NOT_GIT_MESSAGE };
    }
  } catch {
    return { state: "not_git", message: NOT_GIT_MESSAGE };
  }
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return { state: "no_commits", message: NO_COMMITS_MESSAGE };
  }
  return { state: "ready" };
}

/** The hold a repo-readiness failure puts a task on (tasks.hold kind "repo"), or null. */
export function classifyRepoHold(message: string | undefined | null): { kind: "repo"; reason: string } | null {
  const text = String(message ?? "").trim();
  if (!text) return null;
  if (text.startsWith(NOT_GIT_MESSAGE)) return { kind: "repo", reason: NOT_GIT_MESSAGE };
  if (text.startsWith(NO_COMMITS_MESSAGE)) return { kind: "repo", reason: NO_COMMITS_MESSAGE };
  // A worker or backend from before this lane: the raw worktree error.
  if (/^Worktree isolation requested but unavailable:[\s\S]*not a git repository/i.test(text)) {
    return { kind: "repo", reason: NOT_GIT_MESSAGE };
  }
  return null;
}

/**
 * One plain line from a Convex action error: drops "[Request ID: …]",
 * "Server Error", "Uncaught Error:" and the stack ("at async handler
 * (../convex/worker.ts:915:6)"), so the task card never shows them.
 */
export function plainServerError(message: string): string {
  let text = String(message ?? "");
  text = text.replace(/\[Request ID: [^\]]*\]\s*/gi, "");
  text = text.replace(/^\s*(?:Server Error\s*)?(?:Uncaught\s+)?(?:\w*Error:\s*)?/i, "");
  text = text.replace(/\s+at\s+(?:async\s+)?[^\s()]+\s+\([^)]*\)[\s\S]*$/, "");
  text = text.replace(/\n\s*at\s[\s\S]*$/, "");
  text = text.replace(/\n?\s*Called by client\s*$/i, "");
  return text.trim() || "Something went wrong";
}

/** The `path` functions the helpers need (node:path, path.win32 or path.posix). */
export interface PathLike {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
}

/** Where task worktrees live: the project's worktreesPath (relative to the root), else `<root>/.moagent-worktrees`. */
export function worktreesBaseFor(repoRoot: string, worktreesPath: string | undefined, p: PathLike): string {
  return worktreesPath && worktreesPath.trim() ? p.resolve(repoRoot, worktreesPath.trim()) : p.join(repoRoot, WORKTREES_DIR);
}

/** A directory name Windows and POSIX both accept (no `<>:"|?*`, slashes, control chars, trailing dot/space). */
export function safePathSegment(name: string): string {
  const cleaned = String(name ?? "")
    .replace(/[<>:"|?*\\/\u0000-\u001f]+/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "project";
}

/**
 * A task's worktree directory, built with the platform's own separators:
 * `<base>/<project>/fhara/<taskId>/<slug>` on POSIX and the same with `\`
 * on Windows (the old template string mixed `D:\…\.moagent-worktrees/…`).
 */
export function taskWorktreePath(base: string, projectName: string, branchName: string, p: PathLike): string {
  const parts = branchName.split("/").filter(Boolean);
  return p.join(base, safePathSegment(projectName), ...parts);
}

/**
 * The `.git/info/exclude` line that keeps the worktrees directory out of
 * `git add -A` (anchored at the repo root, forward slashes), or null when the
 * directory is outside the repository.
 */
export function worktreesExcludePattern(repoRoot: string, worktreesBase: string, p: PathLike): string | null {
  const rel = p.relative(repoRoot, worktreesBase);
  if (!rel || rel.startsWith("..") || p.isAbsolute(rel)) return null;
  return `/${rel.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
}

/** `exclude` with `pattern` appended once (unchanged when an equivalent line is there). */
export function withExcludeLine(exclude: string, pattern: string): string {
  const bare = pattern.replace(/^\/|\/$/g, "");
  const present = exclude
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\/|\/$/g, ""))
    .some((line) => line === bare);
  if (present) return exclude;
  const sep = exclude.length > 0 && !exclude.endsWith("\n") ? "\n" : "";
  return `${exclude}${sep}${pattern}\n`;
}
