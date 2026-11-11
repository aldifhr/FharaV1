/// <reference types="vite/client" />
// Paradev A1: changes.forTask before and after recordTaskCommit, and the PR
// facts copied from the newest taskPushes row.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "add dark mode",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
      branchName: "fhara/t/add-dark-mode",
      worktreePath: "/tmp/p/.moagent-worktrees/P/fhara/t/add-dark-mode",
    });
    for (const [filePath, changeType, diff] of [
      ["src/theme.ts", "modified", "--- a/src/theme.ts\n+++ b/src/theme.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"],
      ["src/dark.css", "new", "+body{}\n"],
    ] as const) {
      await ctx.db.insert("fileChanges", { taskId, projectId, filePath, changeType, diff });
    }
    return { projectId, taskId };
  });
  return { t, ...ids };
}

async function commit(t: Awaited<ReturnType<typeof setup>>["t"], taskId: any, projectId: any, commitSha = SHA) {
  const res = await t.mutation(internal.githubPush.recordTaskCommit, {
    taskId,
    projectId,
    workerId: "w1",
    branchName: "fhara/t/add-dark-mode",
    commitSha,
    commitMessage: "Fhara: Add dark mode",
    filesChanged: 2,
    additions: 3,
    deletions: 1,
  });
  if (!res.applied) throw new Error("commit not applied");
  return res.pushId;
}

describe("changes.forTask", () => {
  test("proposed files from fileChanges before Accept", async () => {
    const { t, taskId } = await setup();
    const view = await t.query(api.changes.forTask, { taskId });
    expect(view?.source).toBe("proposed");
    expect(view?.flow).toEqual({ kind: "proposed", fileCount: 2 });
    expect(view?.files).toEqual([
      { path: "src/dark.css", status: "added", additions: 1, deletions: 0, source: "proposed" },
      { path: "src/theme.ts", status: "modified", additions: 2, deletions: 1, source: "proposed" },
    ]);
    expect(view?.commit).toBeNull();
    expect(view?.pr).toBeNull();
    expect(view?.hasWorktree).toBe(true);
    expect(view?.base).toBe("main");
  });

  test("the branch after recordTaskCommit", async () => {
    const { t, taskId, projectId } = await setup();
    await commit(t, taskId, projectId);
    const view = await t.query(api.changes.forTask, { taskId });
    expect(view?.source).toBe("branch");
    expect(view?.branchName).toBe("fhara/t/add-dark-mode");
    expect(view?.commit).toMatchObject({ sha: SHA, filesChanged: 2, additions: 3, deletions: 1 });
    expect(view?.flow.kind).toBe("committed");
    expect(view?.push).toEqual({ status: "ready", pr: null });
    // Open PR / Refresh act on the newest push row.
    expect(view?.pushId).toBeTruthy();
  });

  test("worktree-gone once the worktree is released", async () => {
    const { t, taskId, projectId } = await setup();
    await commit(t, taskId, projectId);
    await t.run(async (ctx) => ctx.db.patch(taskId, { worktreePath: undefined }));
    const view = await t.query(api.changes.forTask, { taskId });
    expect(view?.flow.kind).toBe("worktree-gone");
    expect(view?.hasWorktree).toBe(false);
    expect(await t.action(api.changes.branchPatch, { taskId })).toEqual({ status: "worktree-gone" });
  });

  test("branchPatch before commit says not-committed", async () => {
    const { t, taskId } = await setup();
    expect(await t.action(api.changes.branchPatch, { taskId })).toEqual({ status: "not-committed" });
  });

  test("PR facts come from the newest taskPushes row", async () => {
    const { t, taskId, projectId } = await setup();
    const older = await commit(t, taskId, projectId, SHA);
    await t.run(async (ctx) =>
      ctx.db.patch(older, { status: "pushed", prNumber: 1, prUrl: "https://github.com/acme/app/pull/1", prState: "closed", createdAt: 1 }),
    );
    const newer = await commit(t, taskId, projectId, SHA2);
    await t.run(async (ctx) =>
      ctx.db.patch(newer, {
        status: "pushed",
        repoFullName: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        prTitle: "Add dark mode",
        prState: "open",
        ciState: "failed",
        ciChecks: [
          { name: "build", status: "passed", conclusion: "success", url: "https://ci/1" },
          { name: "test", status: "failed", conclusion: "failure" },
        ],
        reviewState: "changes_requested",
        mergeable: "mergeable",
        headSha: SHA2,
      }),
    );
    const view = await t.query(api.changes.forTask, { taskId });
    expect(view?.commit?.sha).toBe(SHA2);
    expect(view?.pr).toEqual({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "Add dark mode",
      state: "open",
      ciState: "failed",
      ciChecks: [
        { name: "build", status: "passed", conclusion: "success", url: "https://ci/1" },
        { name: "test", status: "failed", conclusion: "failure" },
      ],
      reviewState: "changes_requested",
      mergeable: "mergeable",
      headSha: SHA2,
    });
    expect(view?.flow.kind).toBe("pr-exists");
  });

  test("a running fix task shows fix-running with the PR kept", async () => {
    const { t, taskId, projectId } = await setup();
    const pushId = await commit(t, taskId, projectId);
    await t.run(async (ctx) => {
      await ctx.db.patch(pushId, { status: "pushed", repoFullName: "acme/app", prNumber: 7, prState: "open" });
      const reactionId = await ctx.db.insert("prReactions", {
        projectId,
        ownerTaskId: taskId,
        pushId,
        repoFullName: "acme/app",
        prNumber: 7,
        kind: "ci_failed",
        signature: `ci:${SHA}`,
        status: "created",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("tasks", {
        projectId,
        title: "Fix CI",
        command: "fix ci",
        status: "running",
        parentTaskId: taskId,
        prFix: { repoFullName: "acme/app", prNumber: 7, kind: "ci_failed", reactionId },
      });
    });
    const view = await t.query(api.changes.forTask, { taskId });
    expect(view?.flow).toMatchObject({ kind: "fix-running", pr: { number: 7 } });
  });

  test("missing task → null", async () => {
    const { t, taskId } = await setup();
    await t.run(async (ctx) => ctx.db.delete(taskId));
    expect(await t.query(api.changes.forTask, { taskId })).toBeNull();
  });
});
