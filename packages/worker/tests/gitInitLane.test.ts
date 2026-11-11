/**
 * Lane git-init, with real git: "Initialize git" turns a plain folder (or a
 * `git init` with no commit) into a repository with an initial commit that
 * leaves `.moagent-worktrees` out, and the retried task then gets a
 * worktree on the detected base branch. Windows paths go through the path
 * helpers with path.win32.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeRepo } from "@/api/convex/lib/gitInit";
import {
  checkRepoReadiness,
  NO_COMMITS_MESSAGE,
  NOT_GIT_MESSAGE,
  safePathSegment,
  taskWorktreePath,
  worktreesBaseFor,
  worktreesExcludePattern,
  withExcludeLine,
} from "@/api/convex/lib/repoReadiness";
import { gitIdentityArgs } from "@/api/convex/lib/gitIdentity";
import { makeTaskBranchName, resolveMainBranch } from "@/api/convex/lib/taskBranch";
import { makeTempDir, removeTempDir } from "./helpers/tempRepo";

// No global/system config: the identity must come from the repo or the Fhara default.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const gitIn = (dir: string) => (args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });

function retryGetsWorktree(root: string): string {
  const git = gitIn(root);
  const base = worktreesBaseFor(root, undefined, path);
  const branch = makeTaskBranchName("t1", "Fix login");
  const wt = taskWorktreePath(base, "My Project", branch, path);
  git(["worktree", "add", "-q", "-b", branch, wt, resolveMainBranch(undefined, git)]);
  return wt;
}

describe("Initialize git", () => {
  it("a plain folder: git init, initial commit without .moagent-worktrees, then a worktree", () => {
    const root = makeTempDir("fhara-gitinit-");
    try {
      fs.writeFileSync(path.join(root, "index.js"), "console.log(1)\n");
      fs.mkdirSync(path.join(root, ".moagent-worktrees", "old"), { recursive: true });
      fs.writeFileSync(path.join(root, ".moagent-worktrees", "old", "x.txt"), "stale");
      const git = gitIn(root);
      expect(checkRepoReadiness(git)).toEqual({ state: "not_git", message: NOT_GIT_MESSAGE });

      const result = initializeRepo(root, worktreesBaseFor(root, undefined, path), git, gitIdentityArgs());
      expect(result).toMatchObject({ initialized: true, committed: true, readiness: { state: "ready" } });
      expect(git(["log", "--format=%s|%an <%ae>"]).trim()).toBe("Initial commit|Fhara <fhara@users.noreply.github.com>");
      expect(git(["ls-files"]).trim().split("\n")).toEqual(["index.js"]);
      expect(git(["status", "--porcelain"]).trim()).toBe("");

      const wt = retryGetsWorktree(root);
      expect(fs.existsSync(path.join(wt, "index.js"))).toBe(true);
      expect(wt).toBe(path.join(root, ".moagent-worktrees", "My Project", "fhara", "t1", "fix-login"));
      // The new worktree stays out of the main checkout's status too.
      expect(git(["status", "--porcelain"]).trim()).toBe("");
    } finally {
      removeTempDir(root);
    }
  });

  it("git init with no commit (HEAD master, unborn): held as no-commits, then committed with the configured author; base is master", () => {
    const root = makeTempDir("fhara-gitinit-unborn-");
    try {
      const git = gitIn(root);
      git(["init", "-q", "-b", "master"]);
      git(["config", "user.name", "Dev"]);
      git(["config", "user.email", "dev@example.com"]);
      fs.writeFileSync(path.join(root, "a.txt"), "a");
      expect(checkRepoReadiness(git)).toEqual({ state: "no_commits", message: NO_COMMITS_MESSAGE });

      const result = initializeRepo(root, worktreesBaseFor(root, undefined, path), git, gitIdentityArgs());
      expect(result).toMatchObject({ initialized: false, committed: true });
      expect(git(["log", "--format=%an <%ae>"]).trim()).toBe("Dev <dev@example.com>");
      expect(resolveMainBranch(undefined, git)).toBe("master");
      expect(fs.existsSync(path.join(retryGetsWorktree(root), "a.txt"))).toBe(true);
    } finally {
      removeTempDir(root);
    }
  });

  it("a repo on main: the base is main, never a guessed master", () => {
    const root = makeTempDir("fhara-gitinit-main-");
    try {
      const git = gitIn(root);
      git(["init", "-q", "-b", "main"]);
      initializeRepo(root, worktreesBaseFor(root, undefined, path), git, gitIdentityArgs());
      expect(resolveMainBranch(undefined, git)).toBe("main");
      // Running it again changes nothing (no second commit, no re-init).
      expect(initializeRepo(root, worktreesBaseFor(root, undefined, path), git, gitIdentityArgs())).toMatchObject({ initialized: false, committed: false });
      expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
      expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf-8").match(/\.moagent-worktrees/g)).toHaveLength(1);
    } finally {
      removeTempDir(root);
    }
  });
});

describe("Windows paths", () => {
  const w = path.win32;
  const root = "D:\\CODE\\taskmanagement";

  it("builds the worktree path with backslashes only", () => {
    const base = worktreesBaseFor(root, undefined, w);
    expect(base).toBe("D:\\CODE\\taskmanagement\\.moagent-worktrees");
    const wt = taskWorktreePath(base, "taskmanagement", "fhara/k57abc/fix-login", w);
    expect(wt).toBe("D:\\CODE\\taskmanagement\\.moagent-worktrees\\taskmanagement\\fhara\\k57abc\\fix-login");
    expect(wt).not.toContain("/");
    // A forward-slash root (as typed) normalizes too.
    expect(taskWorktreePath(worktreesBaseFor("D:/CODE/taskmanagement", undefined, w), "p", "fhara/a/b", w)).toBe(
      "D:\\CODE\\taskmanagement\\.moagent-worktrees\\p\\fhara\\a\\b"
    );
    expect(worktreesBaseFor(root, "..\\wt", w)).toBe("D:\\CODE\\wt");
  });

  it("project names Windows refuses become safe directory names", () => {
    expect(safePathSegment('My: App?')).toBe("My- App-");
    expect(safePathSegment("name. ")).toBe("name");
    expect(safePathSegment("a/b\\c")).toBe("a-b-c");
  });

  it("the exclude line uses forward slashes and skips a worktrees dir outside the repo", () => {
    expect(worktreesExcludePattern(root, w.join(root, ".moagent-worktrees"), w)).toBe("/.moagent-worktrees/");
    expect(worktreesExcludePattern(root, w.join(root, "build", "wt"), w)).toBe("/build/wt/");
    expect(worktreesExcludePattern(root, "D:\\CODE\\wt", w)).toBeNull();
    expect(worktreesExcludePattern(root, "E:\\wt", w)).toBeNull();
    expect(withExcludeLine("# git ls-files --others\r\n.moagent-worktrees\r\n", "/.moagent-worktrees/")).toBe("# git ls-files --others\r\n.moagent-worktrees\r\n");
    expect(withExcludeLine("x", "/.moagent-worktrees/")).toBe("x\n/.moagent-worktrees/\n");
  });
});
