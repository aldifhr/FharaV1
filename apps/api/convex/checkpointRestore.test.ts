/// <reference types="vite/client" />
// GOAT G6: restore context (target checkpoint for "Revert to N" and "Undo
// last apply", refusals before git runs, push rows) and the snapshot
// bookkeeping. The git side runs on real temp repos in the worker's
// tests/checkpointRestore.test.ts.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const HEAD = "a".repeat(40);
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const WT = "/tmp/p/.moagent-worktrees/P/fhara/t/add-dark-mode";

async function setup(status: "done" | "running" = "done") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "add dark mode",
      status,
      branchName: "fhara/t/add-dark-mode",
      worktreePath: WT,
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

function row(taskId: any, n: number, kind: "subtask" | "apply" = "subtask") {
  return {
    taskId,
    n,
    ref: `refs/fhara/checkpoints/${taskId}/${n}`,
    commitSha: sha(n),
    treeSha: "b".repeat(40),
    headSha: HEAD,
    kind,
    files: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

describe("restore context", () => {
  test("revert to N and undo last apply pick their checkpoint", async () => {
    const { t, taskId } = await setup();
    for (const [n, kind] of [[1, "subtask"], [2, "apply"], [3, "subtask"], [4, "apply"]] as const) {
      await t.mutation(internal.checkpoints.recordInternal, row(taskId, n, kind));
    }
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, n: 2 })).toEqual({
      status: "ok",
      worktreePath: WT,
      n: 2,
      commitSha: sha(2),
      headSha: HEAD,
      pushedInFhara: false,
    });
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, undoApply: true })).toMatchObject({ status: "ok", n: 3 });
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, n: 9 })).toEqual({ status: "not-found" });
  });

  test("refusals: no apply, nothing before it, swept refs, active task, no worktree", async () => {
    const { t, taskId } = await setup();
    await t.mutation(internal.checkpoints.recordInternal, row(taskId, 1));
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, undoApply: true })).toEqual({ status: "no-apply" });
    const other = await setup();
    await other.t.mutation(internal.checkpoints.recordInternal, row(other.taskId, 1, "apply"));
    expect(await other.t.query(internal.checkpointRestore.restoreContext, { taskId: other.taskId, undoApply: true })).toEqual({
      status: "no-earlier-checkpoint",
    });
    await t.mutation(internal.checkpoints.refsDeleted, { taskId });
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, n: 1 })).toEqual({ status: "refs-gone" });
    const running = await setup("running");
    expect(await running.t.query(internal.checkpointRestore.restoreContext, { taskId: running.taskId, n: 1 })).toEqual({
      status: "task-active",
    });
    await t.run(async (ctx) => ctx.db.patch(taskId, { worktreePath: undefined }));
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, n: 1 })).toEqual({ status: "no-worktree" });
    expect(await t.action(api.checkpointRestore.revertToCheckpoint, { taskId, n: 0 })).toEqual({ status: "not-found" });
    expect(await t.action(api.checkpointRestore.undoLastApply, { taskId })).toEqual({ status: "no-worktree" });
  });

  test("a push row past ready marks the branch pushed", async () => {
    const { t, taskId, projectId } = await setup();
    await t.mutation(internal.checkpoints.recordInternal, row(taskId, 1));
    const push = {
      taskId,
      projectId,
      branchName: "fhara/t/add-dark-mode",
      commitSha: sha(5),
      commitMessage: "m",
      filesChanged: 1,
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const pushId = await t.run(async (ctx) => ctx.db.insert("taskPushes", { ...push, status: "ready" }));
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, n: 1 })).toMatchObject({ pushedInFhara: false });
    await t.run(async (ctx) => ctx.db.patch(pushId, { status: "pushed", pushedAt: Date.now() }));
    expect(await t.query(internal.checkpointRestore.restoreContext, { taskId, n: 1 })).toMatchObject({ pushedInFhara: true });
  });
});

describe("snapshot bookkeeping", () => {
  test("snapshot and restore events; restore sets the worktree back with a fresh retention window", async () => {
    const { t, taskId } = await setup();
    await t.run(async (ctx) => ctx.db.patch(taskId, { worktreePath: undefined, updatedAt: 1 }));
    await t.mutation(internal.checkpointRestore.snapshotTaken, {
      taskId,
      ref: `refs/fhara/snapshots/${taskId}/1`,
      commitSha: sha(7),
      headSha: HEAD,
      worktreePath: WT,
    });
    await t.mutation(internal.checkpointRestore.worktreeRestored, { taskId, worktreePath: WT });
    const { task, events } = await t.run(async (ctx) => ({
      task: await ctx.db.get(taskId),
      events: await ctx.db.query("taskEvents").collect(),
    }));
    expect(task?.worktreePath).toBe(WT);
    expect(task!.updatedAt!).toBeGreaterThan(1);
    expect(events.map((event) => event.type)).toEqual(["branch.worktree_snapshot", "branch.worktree_restored"]);
    expect(await t.query(internal.checkpointRestore.snapshotRepos, {})).toEqual(["/tmp/p"]);
    // A worktree already there is never overwritten by a snapshot restore.
    expect(await t.action(api.checkpointRestore.restoreSnapshot, { taskId })).toEqual({ status: "worktree-exists", worktreePath: WT });
  });
});
