import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  gitIdentity,
  gitIdentityArgs,
} from "@/api/convex/lib/gitIdentity";
import {
  isTaskBranch,
  makeTaskBranchName,
  parseTaskBranch,
  taskBranchPrefixes,
  taskWorktreesFromPorcelain,
} from "@/api/convex/lib/taskBranch";
import { commitWorktree } from "@/tools/gitWorktree";
import { createTempGitRepo, makeTempDir, removeTempDir } from "./helpers/tempRepo";

describe("gitIdentity", () => {
  it("defaults to the Fhara noreply identity", () => {
    expect(gitIdentity({})).toEqual({ name: "Fhara", email: "fhara@users.noreply.github.com" });
    expect(DEFAULT_GIT_AUTHOR_NAME).toBe("Fhara");
    expect(DEFAULT_GIT_AUTHOR_EMAIL).toBe("fhara@users.noreply.github.com");
    expect(gitIdentityArgs({ name: "A B", email: "a@b" })).toEqual(["-c", "user.name=A B", "-c", "user.email=a@b"]);
  });

  it("takes FHARA_GIT_AUTHOR_NAME/EMAIL from the parent env and sanitizes them", () => {
    expect(gitIdentity({ FHARA_GIT_AUTHOR_NAME: " Ops Bot ", FHARA_GIT_AUTHOR_EMAIL: "ops@example.com" })).toEqual({
      name: "Ops Bot",
      email: "ops@example.com",
    });
    expect(gitIdentity({ FHARA_GIT_AUTHOR_NAME: "Evil\n[core]", FHARA_GIT_AUTHOR_EMAIL: "<x@y>" })).toEqual({
      name: "Evil[core]",
      email: "x@y",
    });
    expect(gitIdentity({ FHARA_GIT_AUTHOR_NAME: "  ", FHARA_GIT_AUTHOR_EMAIL: "" }).name).toBe("Fhara");
  });

  it("FHARA_GIT_AUTHOR_* never needs to reach the child: the scrubbed env drops it", () => {
    const env = buildChildEnv(undefined, { source: { PATH: "/bin", FHARA_GIT_AUTHOR_NAME: "x" } });
    expect(env.FHARA_GIT_AUTHOR_NAME).toBeUndefined();
  });
});

describe("git commits and merges on a repo with no identity (fresh clone)", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ["HOME", "XDG_CONFIG_HOME", "FHARA_GIT_AUTHOR_NAME", "FHARA_GIT_AUTHOR_EMAIL"];

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    // An empty HOME/XDG: no global ~/.gitconfig identity reaches git.
    home = makeTempDir("fhara-home-");
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    delete process.env.FHARA_GIT_AUTHOR_NAME;
    delete process.env.FHARA_GIT_AUTHOR_EMAIL;
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    removeTempDir(home);
  });

  function identitylessRepo() {
    const repo = createTempGitRepo({ prefix: "fhara-noident-", branch: "main", files: { "a.txt": "a" } });
    repo.git("config", "--unset", "user.name");
    repo.git("config", "--unset", "user.email");
    // Refuse hostname-guessed identities, like a container with no domain.
    repo.git("config", "user.useConfigOnly", "true");
    return repo;
  }

  const run = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv() });

  it("a plain merge fails, the per-command identity merge succeeds as Fhara", () => {
    const repo = identitylessRepo();
    try {
      run(repo.dir, [...gitIdentityArgs(), "checkout", "-q", "-b", "fhara/t1/x"]);
      writeFileSync(join(repo.dir, "b.txt"), "b");
      run(repo.dir, ["add", "b.txt"]);
      run(repo.dir, [...gitIdentityArgs(), "commit", "-q", "-m", "b"]);
      run(repo.dir, ["checkout", "-q", "main"]);
      expect(() => run(repo.dir, ["merge", "--no-ff", "--no-edit", "fhara/t1/x"])).toThrow();
      run(repo.dir, [...gitIdentityArgs(), "merge", "--no-ff", "--no-edit", "fhara/t1/x"]);
      expect(repo.git("log", "-1", "--format=%an <%ae>|%cn <%ce>").trim()).toBe(
        "Fhara <fhara@users.noreply.github.com>|Fhara <fhara@users.noreply.github.com>"
      );
      expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
    } finally {
      repo.cleanup();
    }
  });

  it("commitWorktree commits with the env-configured identity", async () => {
    const repo = identitylessRepo();
    process.env.FHARA_GIT_AUTHOR_NAME = "Ops Bot";
    process.env.FHARA_GIT_AUTHOR_EMAIL = "ops@example.com";
    try {
      writeFileSync(join(repo.dir, "c.txt"), "c");
      expect(await commitWorktree(repo.dir, "Fhara: c")).toBe(true);
      expect(repo.git("log", "-1", "--format=%an <%ae>").trim()).toBe("Ops Bot <ops@example.com>");
    } finally {
      repo.cleanup();
    }
  });
});

describe("task branch names", () => {
  it("new branches use the fhara/ prefix", () => {
    expect(makeTaskBranchName("k1", "Add Dark Mode!")).toBe("fhara/k1/add-dark-mode");
    expect(makeTaskBranchName("k1", "???")).toBe("fhara/k1/task");
  });

  it("parses current and legacy moagent/ branches", () => {
    expect(parseTaskBranch("fhara/k1/add-x")).toEqual({ prefix: "fhara/", taskId: "k1", slug: "add-x" });
    expect(parseTaskBranch("refs/heads/moagent/k2/old-one")).toEqual({ prefix: "moagent/", taskId: "k2", slug: "old-one" });
    expect(parseTaskBranch("main")).toBeNull();
    expect(parseTaskBranch("feature/x")).toBeNull();
    expect(isTaskBranch("moagent/k3/y")).toBe(true);
    expect(taskBranchPrefixes("k1")).toEqual(["fhara/k1/", "moagent/k1/"]);
  });

  it("finds this task's worktrees (both prefixes) from porcelain output", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.moagent-worktrees/p/fhara/k1/new",
      "HEAD bbbb",
      "branch refs/heads/fhara/k1/new",
      "",
      "worktree /repo/.moagent-worktrees/p/moagent/k1/old dir",
      "HEAD cccc",
      "branch refs/heads/moagent/k1/old",
      "",
      "worktree /repo/.moagent-worktrees/p/fhara/k10/other",
      "HEAD dddd",
      "branch refs/heads/fhara/k10/other",
      "",
      "worktree /repo/detached",
      "HEAD eeee",
      "detached",
      "",
    ].join("\n");
    expect(taskWorktreesFromPorcelain(porcelain, "k1")).toEqual([
      "/repo/.moagent-worktrees/p/fhara/k1/new",
      "/repo/.moagent-worktrees/p/moagent/k1/old dir",
    ]);
  });
});
