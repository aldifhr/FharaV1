/// <reference types="vite/client" />
// GOAT G5: checkpoint rows (record idempotency and file cap, forTask order,
// refsDeleted) and the N..M diff context. The git side is covered by the
// worker's tests/gitCheckpoint.test.ts on real temp repos.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { CHECKPOINT_FILES_LIMIT } from "./lib/checkpointValidators";

const modules = import.meta.glob("./**/*.ts");
const HEAD = "a".repeat(40);
const sha = (n: number) => String(n).repeat(40).slice(0, 40);

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "add dark mode",
      status: "running",
      branchName: "fhara/t/add-dark-mode",
      worktreePath: "/tmp/p/.moagent-worktrees/P/fhara/t/add-dark-mode",
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

function row(taskId: any, n: number, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    n,
    ref: `refs/fhara/checkpoints/${taskId}/${n}`,
    commitSha: sha(n),
    treeSha: "b".repeat(40),
    headSha: HEAD,
    kind: "subtask" as const,
    subtaskKey: `s${n}`,
    files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
    filesChanged: 1,
    additions: 2,
    deletions: 1,
    ...extra,
  };
}

describe("checkpoints rows", () => {
  test("record is idempotent per (task, n) and caps stored files", async () => {
    const { t, taskId, projectId } = await setup();
    const first = await t.mutation(internal.checkpoints.recordInternal, row(taskId, 1));
    const again = await t.mutation(internal.checkpoints.recordInternal, row(taskId, 1, { commitSha: sha(9) }));
    expect(again).toBe(first);
    const files = Array.from({ length: CHECKPOINT_FILES_LIMIT + 3 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 0 }));
    await t.mutation(internal.checkpoints.recordInternal, row(taskId, 2, { files, filesChanged: files.length, kind: "apply" }));
    const view = await t.query(api.checkpoints.forTask, { taskId });
    expect(view?.map((c) => [c.n, c.kind, c.commitSha])).toEqual([
      [1, "subtask", sha(1)],
      [2, "apply", sha(2)],
    ]);
    expect(view?.[0]?.projectId).toBe(projectId);
    expect(view?.[1]?.files).toHaveLength(CHECKPOINT_FILES_LIMIT);
    expect(view?.[1]?.filesTruncated).toBe(true);
    expect(view?.[1]?.filesChanged).toBe(CHECKPOINT_FILES_LIMIT + 3);
  });

  test("diff context: N..M, 0..M from the captured HEAD, missing and swept refs", async () => {
    const { t, taskId } = await setup();
    await t.mutation(internal.checkpoints.recordInternal, row(taskId, 1));
    await t.mutation(internal.checkpoints.recordInternal, row(taskId, 2));
    expect(await t.query(internal.checkpoints.diffContext, { taskId, from: 1, to: 2 })).toMatchObject({
      status: "ok",
      repoPath: "/tmp/p",
      fromSha: sha(1),
      toSha: sha(2),
    });
    expect(await t.query(internal.checkpoints.diffContext, { taskId, from: 0, to: 1 })).toMatchObject({
      status: "ok",
      fromSha: HEAD,
      toSha: sha(1),
    });
    expect(await t.query(internal.checkpoints.diffContext, { taskId, from: 1, to: 7 })).toEqual({ status: "not-found" });
    expect(await t.mutation(internal.checkpoints.refsDeleted, { taskId })).toBe(2);
    expect(await t.query(internal.checkpoints.diffContext, { taskId, from: 1, to: 2 })).toEqual({ status: "refs-gone" });
    const view = await t.query(api.checkpoints.forTask, { taskId });
    expect(view?.every((c) => typeof c.refDeletedAt === "number")).toBe(true);
  });

  test("diff action refuses bad numbers before touching git", async () => {
    const { t, taskId } = await setup();
    expect(await t.action(api.checkpoints.diff, { taskId, from: 2, to: 0 })).toEqual({ status: "not-found" });
    expect(await t.action(api.checkpoints.diff, { taskId, from: 1, to: 2 })).toEqual({ status: "not-found" });
  });
});
