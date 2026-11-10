import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_TIMEOUT_MS,
  PUSH_GIT_CONFIG,
  assertGitCwd,
  defaultExecGit,
  gitChildEnv,
  githubAuthEnv,
  pushCommitToGithub,
  pushFailureHint,
  type ExecGit,
} from "@/tools/gitPush";
import { PUSH_LEASE_MS, processNextPushRequest } from "@/services/pushRequests";

const TOKEN = "gho_supersecrettoken1234567890abcdef";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fhara-push-hardening-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  return dir;
}

describe("T1 push hardening: environment", () => {
  it("an inherited GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_PARAMETERS never reaches the push", () => {
    const env = githubAuthEnv(TOKEN, {
      PATH: "/bin",
      GIT_DIR: "/somewhere/else/.git",
      GIT_WORK_TREE: "/somewhere/else",
      GIT_CONFIG_PARAMETERS: "'core.sshCommand'='evil'",
      GIT_SSH_COMMAND: "evil",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/evil",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.PATH).toBe("/bin");
  });

  it("the push call sees no GIT_DIR even when the worker process has one", async () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = "/tmp/not-the-repo/.git";
    try {
      const seen: NodeJS.ProcessEnv[] = [];
      const argv: string[][] = [];
      const execGit: ExecGit = async (args, options) => {
        argv.push(args);
        seen.push(options.env);
        return { stdout: "", stderr: "" };
      };
      await pushCommitToGithub({
        repoPath: "/repo",
        owner: "acme",
        repo: "app",
        commitSha: SHA,
        branchName: "fhara/t/x",
        baseBranch: "main",
        token: TOKEN,
        execGit,
      });
      // cat-file, the L2 outgoing-diff secret scan (merge-base ×2, rev-parse, show), push.
      expect(argv.map((a) => a[0])).toEqual(["cat-file", "merge-base", "merge-base", "rev-parse", "show", "push"]);
      for (const env of seen) expect(env.GIT_DIR).toBeUndefined();
      expect(gitChildEnv().GIT_DIR).toBeUndefined();
      // The token never appears in argv.
      for (const args of argv) for (const a of args) expect(a.includes(TOKEN) || a.includes(BASIC)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe("T1 push hardening: cwd, timeout, errors", () => {
  it("refuses a relative or missing cwd before running git", async () => {
    const execGit = vi.fn<ExecGit>(async () => ({ stdout: "", stderr: "" }));
    await expect(
      pushCommitToGithub({
        repoPath: "relative/repo",
        owner: "acme",
        repo: "app",
        commitSha: SHA,
        branchName: "fhara/t/x",
        token: TOKEN,
        execGit,
      })
    ).rejects.toThrow(/must be absolute/);
    expect(execGit).not.toHaveBeenCalled();
    expect(() => assertGitCwd("relative")).toThrow(/absolute/);
    expect(() => assertGitCwd(join(tmpdir(), "fhara-definitely-missing-dir-xyz"))).toThrow(/does not exist/);
    await expect(defaultExecGit(["status"], { cwd: "rel", env: gitChildEnv(), timeoutMs: 5_000 })).rejects.toThrow(/absolute/);
  });

  it("kills a hung git at the timeout with a clear message", async () => {
    const dir = tempRepo();
    try {
      // hash-object --stdin waits on stdin forever.
      await expect(
        defaultExecGit(["hash-object", "--stdin"], { cwd: dir, env: gitChildEnv(), timeoutMs: 300 })
      ).rejects.toThrow(/git hash-object timed out after 0s and was killed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never runs the repository's hooks (a pre-push hook would see the credential)", async () => {
    const dir = tempRepo();
    try {
      const hooks = join(dir, "myhooks");
      mkdirSync(hooks);
      const marker = join(dir, "hook-ran");
      writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(hooks, "pre-commit"), 0o755);
      execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: dir });
      writeFileSync(join(dir, "b.txt"), "b\n");
      await defaultExecGit(["add", "b.txt"], { cwd: dir, env: gitChildEnv(), timeoutMs: 10_000 });
      await defaultExecGit(["commit", "-q", "-m", "b"], { cwd: dir, env: gitChildEnv(), timeoutMs: 10_000 });
      expect(existsSync(marker)).toBe(false);
      expect(PUSH_GIT_CONFIG).toContain("core.fsmonitor=false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("push errors name the branch and repo, add a hint, and never carry the token", async () => {
    const execGit: ExecGit = async (args) => {
      if (args[0] === "push") {
        throw new Error(` ! [rejected] x -> x (non-fast-forward)\nAuthorization: basic ${BASIC} ${TOKEN}`);
      }
      return { stdout: "", stderr: "" };
    };
    const failure = await pushCommitToGithub({
      repoPath: "/repo",
      owner: "acme",
      repo: "app",
      commitSha: SHA,
      branchName: "fhara/t/x",
      token: TOKEN,
      execGit,
    }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/git push failed for fhara\/t\/x → acme\/app \(the remote branch has commits/);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(BASIC);
  });

  it("hints for common rejections", () => {
    expect(pushFailureHint("remote: Permission to a/b.git denied to x. The requested URL returned error: 403")).toMatch(/push access/);
    expect(pushFailureHint("remote: error: GH006: Protected branch update failed")).toMatch(/protected/);
    expect(pushFailureHint("fatal: Authentication failed for 'https://github.com/a/b.git/'")).toMatch(/reconnect/);
    expect(pushFailureHint("remote: Repository not found.")).toMatch(/not found/);
    expect(pushFailureHint("git push timed out after 300s and was killed")).toMatch(/did not answer/);
    expect(pushFailureHint("something odd")).toBeUndefined();
  });

  it("caps the per-call timeout at 5 minutes and leases longer than that", async () => {
    const timeouts: number[] = [];
    const execGit: ExecGit = async (args, options) => {
      if (args[0] === "push") timeouts.push(options.timeoutMs);
      return { stdout: "", stderr: "" };
    };
    await pushCommitToGithub({
      repoPath: "/repo",
      owner: "acme",
      repo: "app",
      commitSha: SHA,
      branchName: "fhara/t/x",
      token: TOKEN,
      timeoutMs: 60 * 60_000,
      execGit,
    });
    expect(GIT_TIMEOUT_MS).toBe(300_000);
    expect(timeouts[0]).toBe(GIT_TIMEOUT_MS);
    expect(PUSH_LEASE_MS).toBeGreaterThan(GIT_TIMEOUT_MS);
    const claimPushRequest = vi.fn(async () => null);
    await processNextPushRequest({
      api: { claimPushRequest, completePushRequest: vi.fn() } as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: () => {},
    });
    expect(claimPushRequest).toHaveBeenCalledWith({ workerId: "w1", leaseMs: PUSH_LEASE_MS });
  });
});

describe("T1 push guard", () => {
  const base = { repoPath: "/repo", owner: "acme", repo: "app", commitSha: SHA, token: TOKEN };

  it("refuses base-branch and force pushes unless the env allows them", async () => {
    const execGit = vi.fn<ExecGit>(async () => ({ stdout: "", stderr: "" }));
    const saved = { b: process.env.FHARA_ALLOW_BASE_BRANCH_PUSH, f: process.env.FHARA_ALLOW_FORCE_PUSH };
    delete process.env.FHARA_ALLOW_BASE_BRANCH_PUSH;
    delete process.env.FHARA_ALLOW_FORCE_PUSH;
    try {
      await expect(pushCommitToGithub({ ...base, branchName: "develop", baseBranch: "develop", execGit })).rejects.toThrow(
        /FHARA_ALLOW_BASE_BRANCH_PUSH/
      );
      await expect(pushCommitToGithub({ ...base, branchName: "main", execGit })).rejects.toThrow(/base branch/);
      await expect(pushCommitToGithub({ ...base, branchName: "fhara/x", force: true, execGit })).rejects.toThrow(
        /FHARA_ALLOW_FORCE_PUSH/
      );
      expect(execGit).not.toHaveBeenCalled();
      process.env.FHARA_ALLOW_BASE_BRANCH_PUSH = "true";
      process.env.FHARA_ALLOW_FORCE_PUSH = "1";
      await pushCommitToGithub({ ...base, branchName: "main", force: true, execGit });
      expect(execGit.mock.calls.find((call) => call[0][0] === "push")![0]).toEqual(["push", "--porcelain", "https://github.com/acme/app.git", `+${SHA}:refs/heads/main`]);
    } finally {
      if (saved.b === undefined) delete process.env.FHARA_ALLOW_BASE_BRANCH_PUSH;
      else process.env.FHARA_ALLOW_BASE_BRANCH_PUSH = saved.b;
      if (saved.f === undefined) delete process.env.FHARA_ALLOW_FORCE_PUSH;
      else process.env.FHARA_ALLOW_FORCE_PUSH = saved.f;
    }
  });
});
