/// <reference types="vite/client" />
/**
 * Lane git-init: a project folder that is not a git repository, or has no
 * commits, holds the task with one plain line instead of failing it with a
 * raw server error; "Initialize git" re-queues what it held. Base branch
 * detection never assumes `master`. (Real-git and Windows-path cases:
 * packages/worker/tests/gitInitLane.test.ts.)
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { classifyTaskHold, holdNoticeText } from "./lib/providerHold";
import { checkRepoReadiness, classifyRepoHold, NO_COMMITS_MESSAGE, NOT_GIT_MESSAGE, plainServerError } from "./lib/repoReadiness";

const modules = import.meta.glob("./**/*.ts");

const LIVE_ERROR =
  "[Request ID: 82789b10ac81e32a] Server Error\nUncaught Error: Not a git repository at D:\\CODE\\taskmanagement\n    at async handler (../convex/worker.ts:915:6)\n";

function fakeGit(repo: "none" | "unborn" | "ready") {
  return (args: string[]): string => {
    if (args[1] === "--is-inside-work-tree") {
      if (repo === "none") throw new Error("fatal: not a git repository (or any of the parent directories): .git");
      return "true\n";
    }
    if (args.includes("HEAD^{commit}")) {
      if (repo !== "ready") throw new Error("exit 1");
      return "abc\n";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

describe("repo readiness", () => {
  test("not a repository, unborn HEAD and ready", () => {
    expect(checkRepoReadiness(fakeGit("none"))).toEqual({ state: "not_git", message: NOT_GIT_MESSAGE });
    expect(checkRepoReadiness(fakeGit("unborn"))).toEqual({ state: "no_commits", message: NO_COMMITS_MESSAGE });
    expect(checkRepoReadiness(fakeGit("ready"))).toEqual({ state: "ready" });
  });

  test("the plain lines and the old raw error classify as a repo hold; others do not", () => {
    expect(classifyRepoHold(NOT_GIT_MESSAGE)).toEqual({ kind: "repo", reason: NOT_GIT_MESSAGE });
    expect(classifyRepoHold(NO_COMMITS_MESSAGE)).toEqual({ kind: "repo", reason: NO_COMMITS_MESSAGE });
    expect(classifyRepoHold(`Worktree isolation requested but unavailable: ${LIVE_ERROR}`)?.reason).toBe(NOT_GIT_MESSAGE);
    expect(classifyRepoHold("Verification failed: not a git repository in test output")).toBeNull();
    expect(classifyTaskHold(NOT_GIT_MESSAGE)?.kind).toBe("repo");
    expect(holdNoticeText({ kind: "repo", reason: NO_COMMITS_MESSAGE, resumeAt: 0 }, 0)).toBe(NO_COMMITS_MESSAGE);
  });

  test("server errors lose the Request ID and the stack", () => {
    const plain = plainServerError(LIVE_ERROR);
    expect(plain).toBe("Not a git repository at D:\\CODE\\taskmanagement");
    expect(plain).not.toMatch(/Request ID|worker\.ts|Uncaught|Server Error/);
  });
});

async function seedRunning(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "D:\\CODE\\taskmanagement" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "t",
      command: "c",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 3_600_000,
      updatedAt: Date.now(),
    });
    return { projectId, taskId };
  });
}

describe("repo hold lifecycle", () => {
  test("a non-git root holds the task with the plain line, no auto-resume, no thrown error", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    const result = await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: NOT_GIT_MESSAGE, workerId: "w1" });
    expect(result).toMatchObject({ applied: true, status: "paused", held: true });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ status: "paused", pausedBy: "held", hold: { kind: "repo", reason: NOT_GIT_MESSAGE } });
    expect(task?.errorMessage ?? "").not.toMatch(/Request ID|at async/);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("autoResumeHeld"))).toBe(false);
  });

  test("an unborn HEAD holds the same way", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: NO_COMMITS_MESSAGE, workerId: "w1" });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.hold).toMatchObject({ kind: "repo", reason: NO_COMMITS_MESSAGE });
  });

  test("after Initialize git the held task and an old raw-error failure are re-queued; others are untouched", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: NOT_GIT_MESSAGE, workerId: "w1" });
    const { oldFail, otherFail } = await t.run(async (ctx) => {
      const base = { projectId, command: "c", updatedAt: Date.now() };
      return {
        oldFail: await ctx.db.insert("tasks", { ...base, title: "old", status: "failed", errorMessage: `Worktree isolation requested but unavailable: ${LIVE_ERROR}` }),
        otherFail: await ctx.db.insert("tasks", { ...base, title: "other", status: "failed", errorMessage: "Verification failed" }),
      };
    });
    const target = await t.query(internal.repoHold.target, { taskId });
    expect(target.workspacePath).toBe("D:\\CODE\\taskmanagement");
    const { resumed } = await t.mutation(internal.repoHold.resumeAfterInit, { projectId, taskId });
    expect(resumed).toBe(2);
    const rows = await t.run(async (ctx) => [await ctx.db.get(taskId), await ctx.db.get(oldFail), await ctx.db.get(otherFail)]);
    expect(rows[0]).toMatchObject({ status: "queued" });
    expect(rows[0]?.hold).toBeUndefined();
    expect(rows[0]?.pausedBy).toBeUndefined();
    expect(rows[1]).toMatchObject({ status: "queued" });
    expect(rows[2]).toMatchObject({ status: "failed" });
  });
});
