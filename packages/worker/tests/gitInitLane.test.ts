/**
 * Lane git-init, with real git: "Initialize git" turns a plain folder (or a
 * `git init` with no commit) into a repository with an initial commit that
 * leaves the legacy `.moagent-worktrees` folder out, and the retried task
 * then gets a worktree on the detected base branch. New worktrees live under
 * the given home's `.fhara/worktrees` (plan 065). Windows paths go through
 * the path helpers with path.win32.
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
// GIT_CONFIG_GLOBAL must be a real empty file: git on this Windows setup
// rejects the NUL device ("unable to access '\\.\nul'").
const EMPTY_CONFIG = path.join(os.tmpdir(), `fhara-empty-gitconfig-${process.pid}`);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const gitIn = (dir: string) => (args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });

/** A throwaway home dir per test: the default worktrees base lives in it. */
function makeHome(): { home: string; cleanup: () => void } {
  const home = makeTempDir("fhara-home-");
  return { home, cleanup: () => removeTempDir(home) };
}

function retryGetsWorktree(root: string, home: string): string {
  const git = gitIn(root);
  const base = worktreesBaseFor(root, undefined, path, home);
  const branch = makeTaskBranchName("t1", "Fix login");
  const wt = taskWorktreePath(base, "My Project", branch, path);
  git(["worktree", "add", "-q", "-b", branch, wt, resolveMainBranch(undefined, git)]);
  return wt;
}

describe("Initialize git", () => {
  fs.writeFileSync(EMPTY_CONFIG, "");
  it("a plain folder: git init, initial commit without the legacy worktrees dir, then a worktree under ~/.fhara", () => {
    const root = makeTempDir("fhara-gitinit-");
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(root, "index.js"), "console.log(1)\n");
      fs.mkdirSync(path.join(root, ".moagent-worktrees", "old"), { recursive: true });
      fs.writeFileSync(path.join(root, ".moagent-worktrees", "old", "x.txt"), "stale");
      const git = gitIn(root);
      expect(checkRepoReadiness(git)).toEqual({ state: "not_git", message: NOT_GIT_MESSAGE });

      const result = initializeRepo(root, worktreesBaseFor(root, undefined, path, home), git, gitIdentityArgs());
      expect(result).toMatchObject({ initialized: true, committed: true, readiness: { state: "ready" } });
      expect(git(["log", "--format=%s|%an <%ae>"]).trim()).toBe("Initial commit|Fhara <fhara@users.noreply.github.com>");
      expect(git(["ls-files"]).trim().split("\n")).toEqual(["index.js"]);
      expect(git(["status", "--porcelain"]).trim()).toBe("");

      const wt = retryGetsWorktree(root, home);
      expect(fs.existsSync(path.join(wt, "index.js"))).toBe(true);
      // Plan 065: the worktree lives in the home's .fhara, not in the project.
      expect(wt).toBe(path.join(home, ".fhara", "worktrees", "My Project", "fhara", "t1", "fix-login"));
      // The new worktree stays out of the main checkout's status too.
      expect(git(["status", "--porcelain"]).trim()).toBe("");
      // The legacy in-repo dir is excluded from the initial commit and status.
      expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf-8")).toContain("/.moagent-worktrees/");
    } finally {
      cleanup();
      removeTempDir(root);
    }
  });

  it("git init with no commit (HEAD master, unborn): held as no-commits, then committed with the configured author; base is master", () => {
    const root = makeTempDir("fhara-gitinit-unborn-");
    const { home, cleanup } = makeHome();
    try {
      const git = gitIn(root);
      git(["init", "-q", "-b", "master"]);
      git(["config", "user.name", "Dev"]);
      git(["config", "user.email", "dev@example.com"]);
      fs.writeFileSync(path.join(root, "a.txt"), "a");
      expect(checkRepoReadiness(git)).toEqual({ state: "no_commits", message: NO_COMMITS_MESSAGE });

      const result = initializeRepo(root, worktreesBaseFor(root, undefined, path, home), git, gitIdentityArgs());
      expect(result).toMatchObject({ initialized: false, committed: true });
      expect(git(["log", "--format=%an <%ae>"]).trim()).toBe("Dev <dev@example.com>");
      expect(resolveMainBranch(undefined, git)).toBe("master");
      expect(fs.existsSync(path.join(retryGetsWorktree(root, home), "a.txt"))).toBe(true);
    } finally {
      cleanup();
      removeTempDir(root);
    }
  });

  it("a repo on main: the base is main, never a guessed master", () => {
    const root = makeTempDir("fhara-gitinit-main-");
    const { home, cleanup } = makeHome();
    try {
      const git = gitIn(root);
      git(["init", "-q", "-b", "main"]);
      initializeRepo(root, worktreesBaseFor(root, undefined, path, home), git, gitIdentityArgs());
      expect(resolveMainBranch(undefined, git)).toBe("main");
      // Running it again changes nothing (no second commit, no re-init).
      expect(initializeRepo(root, worktreesBaseFor(root, undefined, path, home), git, gitIdentityArgs())).toMatchObject({ initialized: false, committed: false });
      expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
      // The legacy in-repo dir is always excluded, even though the default
      // worktrees base is outside the repo now.
      expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf-8").match(/\.moagent-worktrees/g)).toHaveLength(1);
    } finally {
      cleanup();
      removeTempDir(root);
    }
  });
});

describe("Windows paths", () => {
  const w = path.win32;
  const root = "D:\\CODE\\taskmanagement";
  const home = "C:\\Users\\dev";

  it("builds the worktree path in the home's .fhara, with backslashes only", () => {
    const base = worktreesBaseFor(root, undefined, w, home);
    expect(base).toBe("C:\\Users\\dev\\.fhara\\worktrees");
    const wt = taskWorktreePath(base, "taskmanagement", "fhara/k57abc/fix-login", w);
    expect(wt).toBe("C:\\Users\\dev\\.fhara\\worktrees\\taskmanagement\\fhara\\k57abc\\fix-login");
    expect(wt).not.toContain("/");
    // A forward-slash root (as typed) normalizes too.
    expect(taskWorktreePath(worktreesBaseFor("D:/CODE/taskmanagement", undefined, w, home), "p", "fhara/a/b", w)).toBe(
      "C:\\Users\\dev\\.fhara\\worktrees\\p\\fhara\\a\\b"
    );
    // A configured worktreesPath still resolves relative to the repo root.
    expect(worktreesBaseFor(root, "..\\wt", w, home)).toBe("D:\\CODE\\wt");
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
    expect(worktreesExcludePattern(root, w.join(home, ".fhara", "worktrees"), w)).toBeNull();
    expect(withExcludeLine("# git ls-files --others\r\n.moagent-worktrees\r\n", "/.moagent-worktrees/")).toBe("# git ls-files --others\r\n.moagent-worktrees\r\n");
    expect(withExcludeLine("x", "/.moagent-worktrees/")).toBe("x\n/.moagent-worktrees/\n");
  });
});
