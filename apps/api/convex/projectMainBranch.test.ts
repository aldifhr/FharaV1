/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { normalizeMainBranch, resolveMainBranch } from "./lib/taskBranch";

const modules = import.meta.glob("./**/*.ts");

/** A fake `git` for a repo with these local branches and origin/HEAD. */
function fakeGit(opts: { branches: string[]; originHead?: string; current?: string }) {
  const calls: string[][] = [];
  const git = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "symbolic-ref" && args.at(-1) === "refs/remotes/origin/HEAD") {
      if (!opts.originHead) throw new Error("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref");
      return `origin/${opts.originHead}\n`;
    }
    if (args[0] === "symbolic-ref" && args.at(-1) === "HEAD") {
      if (!opts.current) throw new Error("fatal: not a symbolic ref");
      return `${opts.current}\n`;
    }
    if (args[0] === "rev-parse") {
      const ref = args.at(-1) ?? "";
      if (opts.branches.some((b) => ref === `refs/heads/${b}`)) return "abc123\n";
      throw new Error("fatal: Needed a single revision");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { git, calls };
}

// live2 case 0: `git worktree add … main` → "invalid reference: main" on a master repo.
describe("task worktree base branch", () => {
  test("a configured branch wins and git is not asked", () => {
    const { git, calls } = fakeGit({ branches: ["main"] });
    expect(resolveMainBranch("develop", git)).toBe("develop");
    expect(calls).toHaveLength(0);
  });

  test("auto-detect: the current branch, then origin/HEAD, then main, then master", () => {
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["master", "trunk"], originHead: "trunk" }).git)).toBe("trunk");
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["main", "master"] }).git)).toBe("main");
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["master"] }).git)).toBe("master");
    expect(resolveMainBranch("  ", fakeGit({ branches: ["master"] }).git)).toBe("master");
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["dev"], current: "dev" }).git)).toBe("dev");
    // Lane git-init: the checked-out branch wins over a guessed main/master
    // (live: "invalid reference: master"), but never a task branch (inside
    // a task worktree) and never an unborn one.
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["main", "master"], current: "master" }).git)).toBe("master");
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["main", "fhara/t1/x"], current: "fhara/t1/x" }).git)).toBe("main");
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["main"], current: "master" }).git)).toBe("main");
    // origin/HEAD naming a branch with no local copy falls through.
    expect(resolveMainBranch(undefined, fakeGit({ branches: ["master"], originHead: "main" }).git)).toBe("master");
    expect(resolveMainBranch(undefined, () => { throw new Error("not a git repository"); })).toBe("main");
  });

  test("branch names git would refuse are rejected", () => {
    expect(normalizeMainBranch(" release/2.x ")).toBe("release/2.x");
    expect(normalizeMainBranch("")).toBeNull();
    for (const bad of ["-main", "a..b", "has space", "x.lock", "a~1", "refs/", "a:b"]) {
      expect(() => normalizeMainBranch(bad)).toThrow(/Invalid base branch name/);
    }
  });

  test("projects.create / update store mainBranch; empty clears it; diff/merge context passes it through", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.mutation(api.projects.create, { name: "P", workspacePath: "/tmp/p", mainBranch: "master" });
    const read = async () => (await t.run(async (ctx) => ctx.db.get(projectId)))?.mainBranch;
    expect(await read()).toBe("master");
    await t.mutation(api.projects.update, { projectId, mainBranch: "trunk" });
    expect(await read()).toBe("trunk");
    await t.mutation(api.projects.update, { projectId, mainBranch: "" });
    expect(await read()).toBeUndefined();
    await expect(t.mutation(api.projects.update, { projectId, mainBranch: "bad name" })).rejects.toThrow(/Invalid base branch name/);
    const taskId = await t.run(async (ctx) =>
      ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "running", branchName: "fhara/x", worktreePath: "/tmp/wt" })
    );
    // No configured branch: worktreeNode auto-detects (never a hard-coded "main").
    expect((await t.query(internal.orchestration.getDiffContext, { taskId })).mainBranch).toBeUndefined();
    expect((await t.query(internal.orchestration.getMergeContext, { taskId })).mainBranch).toBeUndefined();
  });
});
