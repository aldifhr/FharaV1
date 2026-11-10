/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { loadMemorySection, loadRecalledSection } from "./memories";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "suggest-harness-token";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const other = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "done" });
    const old = await ctx.db.insert("memories", {
      scope: "project", projectId, title: "Test command", content: "Run npm test", pinned: true,
      source: "user", createdAt: now, updatedAt: now,
    });
    const foreign = await ctx.db.insert("memories", {
      scope: "project", projectId: other, title: "Elsewhere", content: "Other project", pinned: false,
      source: "user", createdAt: now, updatedAt: now,
    });
    return { projectId, taskId, old, foreign };
  });
}

const record = (t: ReturnType<typeof convexTest>, taskId: unknown, suggestions: unknown[]) =>
  t.action(api.worker.recordMemorySuggestions, {
    taskId: taskId as never,
    tag: "suggested",
    suggestions: suggestions as never,
    workerToken: SERVICE_TOKEN,
  });

describe("memory suggestions (plan L5)", () => {
  test("token-gated, idempotent per task, drops invalid and foreign targets", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const t = convexTest(schema, modules);
    const { projectId, taskId, old, foreign } = await seed(t);
    await expect(
      t.action(api.worker.recordMemorySuggestions, { taskId, tag: "x", suggestions: [], workerToken: "nope" })
    ).rejects.toThrow("Worker authentication required");
    const first = await record(t, taskId, [
      { op: "add", scope: "project", title: "Compaction", content: "Threshold is 80% of the window" },
      { op: "update", memoryId: old, scope: "project", title: "Test command", content: "Run pnpm test" },
      { op: "forget", memoryId: foreign, scope: "project", title: "Elsewhere", content: "" },
      { op: "update", memoryId: "not-an-id", scope: "project", title: "x", content: "y" },
      { op: "add", scope: "project", title: "", content: "no title" },
    ]);
    expect(first).toMatchObject({ applied: true, inserted: 2 });
    const again = await record(t, taskId, [{ op: "add", scope: "project", title: "Dup", content: "dup" }]);
    expect(again).toMatchObject({ applied: false, reason: "already_reconciled" });
    const ctxAfter = await t.action(api.worker.getMemoryReconcileContext, { taskId, workerToken: SERVICE_TOKEN });
    expect(ctxAfter?.reconciled).toBe(true);
    const listed = await t.query(api.memorySuggestions.list, { scope: "project", projectId });
    expect(listed.map((row) => row.title).sort()).toEqual(["Compaction", "Test command"]);
  });

  test("nothing reaches a prompt until accepted; accept add makes an unpinned agent memory that recall finds", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seed(t);
    await record(t, taskId, [{ op: "add", scope: "project", title: "Compaction", content: "The compaction threshold is 80%" }]);
    const before = await t.run(async (ctx) => ({
      pinned: await loadMemorySection(ctx, { projectId }),
      recalled: await loadRecalledSection(ctx, { projectId }, "compaction threshold"),
    }));
    expect(before.pinned).not.toContain("compaction");
    expect(before.recalled).toBe("");
    const [row] = await t.query(api.memorySuggestions.list, { scope: "project", projectId });
    const { memoryId } = await t.mutation(api.memorySuggestions.accept, { suggestionId: row._id, content: "The compaction threshold is 75%" });
    const mem = await t.run(async (ctx) => ctx.db.get(memoryId!));
    expect(mem).toMatchObject({ pinned: false, source: "agent", scope: "project", content: "The compaction threshold is 75%" });
    const after = await t.run(async (ctx) => ({
      pinned: await loadMemorySection(ctx, { projectId }),
      recalled: await loadRecalledSection(ctx, { projectId }, "compaction threshold"),
    }));
    expect(after.pinned).toBe(before.pinned);
    expect(after.recalled).toContain("75%");
    expect(await t.query(api.memorySuggestions.list, { scope: "project", projectId })).toHaveLength(0);
    await expect(t.mutation(api.memorySuggestions.accept, { suggestionId: row._id })).rejects.toThrow("already decided");
  });

  test("accept update keeps the pin; accept forget deletes; reject writes nothing", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const t = convexTest(schema, modules);
    const { projectId, taskId, old } = await seed(t);
    await record(t, taskId, [
      { op: "update", memoryId: old, scope: "project", title: "Test command", content: "Run pnpm test" },
      { op: "add", scope: "shared", title: "Rejected", content: "noise" },
    ]);
    const [update] = await t.query(api.memorySuggestions.list, { scope: "project", projectId });
    await t.mutation(api.memorySuggestions.accept, { suggestionId: update._id });
    expect(await t.run(async (ctx) => ctx.db.get(old))).toMatchObject({ content: "Run pnpm test", pinned: true });

    const [shared] = await t.query(api.memorySuggestions.list, { scope: "shared" });
    await t.mutation(api.memorySuggestions.reject, { suggestionId: shared._id });
    expect(await t.run(async (ctx) => (await ctx.db.query("memories").collect()).some((m) => m.title === "Rejected"))).toBe(false);

    const task2 = await t.run(async (ctx) => ctx.db.insert("tasks", { projectId, title: "T2", command: "c", status: "done" }));
    await record(t, task2, [{ op: "forget", memoryId: old, scope: "project", title: "Test command", content: "" }]);
    const [forget] = await t.query(api.memorySuggestions.list, { scope: "project", projectId });
    await t.mutation(api.memorySuggestions.accept, { suggestionId: forget._id });
    expect(await t.run(async (ctx) => ctx.db.get(old))).toBeNull();
  });
});
