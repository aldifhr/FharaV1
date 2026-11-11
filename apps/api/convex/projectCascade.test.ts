/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { PROJECT_CASCADE, PROJECT_CASCADE_BATCH, PROJECT_CASCADE_EXEMPT } from "./projects";

const modules = import.meta.glob("./**/*.ts");

type AnyTable = { validator: { fields?: Record<string, unknown> }; " indexes"(): Array<{ indexDescriptor: string; fields: string[] }> };
const tables = (schema as unknown as { tables: Record<string, AnyTable> }).tables;

describe("project cascade covers the schema", () => {
  test("every table with a projectId is cascaded or explicitly exempt", () => {
    const withProjectId = Object.entries(tables)
      .filter(([, def]) => def.validator.fields && "projectId" in def.validator.fields)
      .map(([name]) => name)
      .sort();
    const covered = new Set<string>([...PROJECT_CASCADE.map((entry) => entry.table), ...Object.keys(PROJECT_CASCADE_EXEMPT)]);
    expect(withProjectId.filter((name) => !covered.has(name))).toEqual([]);
    // Nothing stale either: every listed table still has a projectId.
    expect([...covered].filter((name) => !withProjectId.includes(name))).toEqual([]);
    expect(withProjectId.length).toBeGreaterThanOrEqual(30);
  });

  test("each cascade index exists and leads with projectId", () => {
    for (const { table, index } of PROJECT_CASCADE) {
      const found = tables[table][" indexes"]().find((i) => i.indexDescriptor === index);
      expect(found, `${table}.${index}`).toBeDefined();
      expect(found!.fields[0], `${table}.${index}`).toBe("projectId");
    }
  });

  test("children are emptied before tasks", () => {
    const order = PROJECT_CASCADE.map((entry) => entry.table as string);
    const tasksAt = order.indexOf("tasks");
    for (const child of ["subtasks", "plans", "executions", "taskEvents", "messages", "approvals", "subtaskLive", "optionReviews"]) {
      expect(order.indexOf(child)).toBeLessThan(tasksAt);
    }
  });
});

describe("projects.remove cascade", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function seed(t: ReturnType<typeof convexTest>, name: string, events: number) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const projectId = await ctx.db.insert("projects", { name, workspacePath: `/tmp/${name}` });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "queued", updatedAt: now });
      await ctx.db.insert("messages", { projectId, authorType: "user", content: "hi" });
      for (let i = 0; i < events; i++) await ctx.db.insert("taskEvents", { taskId, projectId, type: `e${i}` });
      await ctx.db.insert("subtaskLive", { taskId, projectId, key: "k", text: "x", updatedAt: now });
      await ctx.db.insert("diffComments", {
        taskId, projectId, path: "a.ts", side: "additions", startLine: 1, endLine: 1, body: "b",
        source: "proposed", status: "draft", createdAt: now, updatedAt: now,
      });
      const imageStorageId = await ctx.storage.store(new Blob(["png"]));
      await ctx.db.insert("optionReviews", {
        taskId,
        projectId,
        role: "designer",
        purpose: "design",
        title: "Pick one",
        options: [{ id: "a", title: "A", kind: "image", imageStorageId }],
        status: "pending",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoToolCalls", { projectId, tool: "read", args: "{}", status: "done", createdAt: now });
      const snapshotId = await ctx.db.insert("contextSnapshots", {
        projectId,
        callRole: "executor",
        source: "worker",
        sectionStats: [],
        promptTokens: 0,
        toolNames: [],
        skillNames: [],
        memoryIncluded: false,
        historyMessages: 0,
        truncated: false,
        bytes: 0,
        createdAt: now,
      });
      await ctx.db.insert("contextSnapshotBodies", { snapshotId, sections: [], response: "" });
      await ctx.db.insert("memories", {
        projectId,
        scope: "project",
        title: "m",
        content: "c",
        pinned: false,
        source: "user",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("checkpoints", {
        taskId, projectId, n: 1, ref: `refs/fhara/checkpoints/${taskId}/1`, commitSha: "c".repeat(40), treeSha: "d".repeat(40),
        kind: "subtask", files: [], filesChanged: 0, additions: 0, deletions: 0, createdAt: now,
      });
      await ctx.db.insert("calibrationActions", { projectId, recId: "r", action: "applied", title: "t", actor: "u", createdAt: now });
      await ctx.db.insert("audit", { projectId, actor: "u", tool: "t", action: "a", decision: "recorded", createdAt: now });
      return { projectId, taskId };
    });
  }

  async function countFor(t: ReturnType<typeof convexTest>, projectId: string) {
    return await t.run(async (ctx) => {
      let total = 0;
      for (const { table } of PROJECT_CASCADE) {
        const rows = await ctx.db.query(table as any).collect();
        total += rows.filter((row: any) => row.projectId === projectId).length;
      }
      return total;
    });
  }

  test("removes every project row in batches and leaves other projects alone", async () => {
    const t = convexTest(schema, modules);
    // More events than one batch, so the cascade must reschedule itself.
    const doomed = await seed(t, "doomed", PROJECT_CASCADE_BATCH + 75);
    const kept = await seed(t, "kept", 3);
    const keptBefore = await countFor(t, kept.projectId);

    const result = await t.mutation(api.projects.remove, { projectId: doomed.projectId });
    expect(result).toEqual({ deletedTasks: 1 });
    // The project row is gone at once; children follow via the scheduler.
    expect(await t.run(async (ctx) => await ctx.db.get(doomed.projectId))).toBeNull();

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countFor(t, doomed.projectId)).toBe(0);
    expect(await countFor(t, kept.projectId)).toBe(keptBefore);
    const leftovers = await t.run(async (ctx) => ({
      bodies: (await ctx.db.query("contextSnapshotBodies").collect()).length,
      files: (await ctx.db.system.query("_storage").collect()).length,
      snapshots: (await ctx.db.query("contextSnapshots").collect()).length,
      detachedAudit: (await ctx.db.query("audit").collect()).filter((row) => row.action === "a" && row.projectId === undefined).length,
      removeAudit: (await ctx.db.query("audit").collect()).filter((row) => row.action === "project.remove").length,
    }));
    // Only the kept project's snapshot (and its body) survive.
    expect(leftovers.snapshots).toBe(1);
    expect(leftovers.bodies).toBe(1);
    // Only the kept project's option image is still stored.
    expect(leftovers.files).toBe(1);
    // The doomed project's audit trail stays, detached from the project.
    expect(leftovers.detachedAudit).toBe(1);
    expect(leftovers.removeAudit).toBe(1);
  });

  test("one cascade step touches at most a batch and reports where it stopped", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t, "big", PROJECT_CASCADE_BATCH * 2);
    await t.run(async (ctx) => {
      await ctx.db.delete(projectId);
    });
    const first = await t.mutation(internal.projects.cascadeDelete, { projectId, step: 0, deleted: 0 });
    expect(first.done).toBe(false);
    expect(first.deleted).toBe(PROJECT_CASCADE_BATCH);
    // Rerunning from the reported step is safe and finishes the job.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await countFor(t, projectId)).toBe(0);
  });
});
