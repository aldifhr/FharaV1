/// <reference types="vite/client" />
// Plan 054: pullRequests.list groups taskPushes rows by repoFullName#prNumber,
// newest facts win, fix-task rows link to the owner task.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" });
    const otherProjectId = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q", mainBranch: "main" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "add dark mode",
      status: "done",
    });
    const fixTaskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Fix CI on dark mode PR",
      command: "fix ci",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    return { projectId, otherProjectId, taskId, fixTaskId };
  });
  return { t, ...ids };
}

describe("pullRequests.list", () => {
  test("groups rows of the same PR; newest prFactsAt wins", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("taskPushes", {
        taskId,
        projectId,
        branchName: "fhara/t/a",
        commitSha: SHA,
        commitMessage: "Fhara: a",
        filesChanged: 1,
        status: "pushed",
        attempts: 1,
        repoFullName: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        prState: "open",
        ciState: "failed",
        prFactsAt: 100,
        createdAt: 100,
        updatedAt: 100,
      });
      await ctx.db.insert("taskPushes", {
        taskId,
        projectId,
        branchName: "fhara/t/a",
        commitSha: SHA,
        commitMessage: "Fhara: a fix",
        filesChanged: 1,
        status: "pushed",
        attempts: 1,
        repoFullName: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        prTitle: "Add dark mode",
        prState: "open",
        ciState: "passed",
        mergeable: "mergeable",
        prFactsAt: 200,
        createdAt: 150,
        updatedAt: 200,
      });
    });
    const rows = await t.query(api.pullRequests.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repoFullName: "acme/app",
      prNumber: 7,
      prTitle: "Add dark mode",
      prState: "open",
      ciState: "passed",
      mergeable: "mergeable",
      projectName: "P",
      taskTitle: "Add dark mode",
      updatedAt: 200,
    });
  });

  test("a fix-task row links to the owner task", async () => {
    const { t, projectId, taskId, fixTaskId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("taskPushes", {
        taskId: fixTaskId,
        projectId,
        ownerTaskId: taskId,
        branchName: "fhara/t/fix",
        commitSha: SHA,
        commitMessage: "Fhara: fix",
        filesChanged: 1,
        status: "pushed",
        attempts: 1,
        repoFullName: "acme/app",
        prNumber: 9,
        prState: "open",
        createdAt: 100,
        updatedAt: 100,
      });
    });
    const rows = await t.query(api.pullRequests.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe(taskId);
    expect(rows[0].taskTitle).toBe("Add dark mode");
  });

  test("rows without a PR and projects the viewer cannot see are excluded", async () => {
    const { t, projectId, otherProjectId, taskId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("taskPushes", {
        taskId,
        projectId,
        branchName: "fhara/t/a",
        commitSha: SHA,
        commitMessage: "Fhara: a",
        filesChanged: 1,
        status: "pushed",
        attempts: 1,
        createdAt: 100,
        updatedAt: 100,
      });
      const otherTask = await ctx.db.insert("tasks", {
        projectId: otherProjectId,
        title: "Other",
        command: "other",
        status: "done",
      });
      await ctx.db.insert("projects", {
        name: "Owned",
        workspacePath: "/tmp/owned",
        mainBranch: "main",
        ownerId: "someone-else",
      }).then(async (ownedId) => {
        const ownedTask = await ctx.db.insert("tasks", {
          projectId: ownedId,
          title: "Owned task",
          command: "owned",
          status: "done",
        });
        await ctx.db.insert("taskPushes", {
          taskId: ownedTask,
          projectId: ownedId,
          branchName: "fhara/t/owned",
          commitSha: SHA,
          commitMessage: "Fhara: owned",
          filesChanged: 1,
          status: "pushed",
          attempts: 1,
          repoFullName: "acme/owned",
          prNumber: 3,
          prState: "open",
          createdAt: 100,
          updatedAt: 100,
        });
      });
      await ctx.db.insert("taskPushes", {
        taskId: otherTask,
        projectId: otherProjectId,
        branchName: "fhara/t/b",
        commitSha: SHA,
        commitMessage: "Fhara: b",
        filesChanged: 1,
        status: "pushed",
        attempts: 1,
        repoFullName: "acme/app",
        prNumber: 11,
        prState: "merged",
        createdAt: 100,
        updatedAt: 100,
      });
    });
    const rows = await t.query(api.pullRequests.list, {});
    expect(rows.map((r) => r.prNumber)).toEqual([11]);
  });

});
