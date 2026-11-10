/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { loadMemorySection, loadRecalledSection, recallMemories } from "./memories";
import {
  RECALL_MAX,
  RECALL_MAX_TERMS,
  formatRecalledSection,
  pickRecalled,
  recallTokens,
} from "./lib/memoryRecall";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const p1 = await ctx.db.insert("projects", { name: "P1", workspacePath: "/tmp/p1" });
    const p2 = await ctx.db.insert("projects", { name: "P2", workspacePath: "/tmp/p2" });
    const base = { tags: undefined, source: "user" as const, createdAt: now, updatedAt: now };
    await ctx.db.insert("memories", {
      ...base, scope: "project", projectId: p1, pinned: true, title: "Package manager", content: "Use pnpm, never npm.",
    });
    await ctx.db.insert("memories", {
      ...base, scope: "project", projectId: p1, pinned: false, title: "Compaction",
      content: "The compaction threshold is 80% of the context window; lower it for small models.",
    });
    await ctx.db.insert("memories", {
      ...base, scope: "project", projectId: p1, pinned: false, title: "Brand colours",
      content: "Primary brand colour is teal; buttons use the ink token.",
    });
    await ctx.db.insert("memories", {
      ...base, scope: "project", projectId: p2, pinned: false, title: "Other project",
      content: "In this project the compaction threshold is 50%.",
    });
    return { p1, p2 };
  });
}

describe("recall helpers (lib/memoryRecall.ts)", () => {
  test("tokens drop stopwords and short words, cap at 16 terms", () => {
    expect(recallTokens("How does the compaction threshold work?")).toEqual(["compaction", "threshold", "work"]);
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(recallTokens(many)).toHaveLength(RECALL_MAX_TERMS);
    expect(recallTokens("a an to of")).toEqual([]);
  });

  test("pickRecalled never returns pinned rows or non-matching rows, caps k", () => {
    const rows = [
      { id: "1", title: "a", content: "compaction here", scope: "shared" as const, pinned: true, rank: 0 },
      { id: "2", title: "b", content: "compaction compaction", scope: "shared" as const, pinned: false, rank: 1 },
      { id: "3", title: "c", content: "nothing related", scope: "shared" as const, pinned: false, rank: 0 },
    ];
    expect(pickRecalled(rows, "compaction").map((r) => r.id)).toEqual(["2"]);
    expect(pickRecalled(rows, "compaction", 50).length).toBeLessThanOrEqual(RECALL_MAX);
  });

  test("formatRecalledSection respects its budget", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, content: "x".repeat(500) }));
    const text = formatRecalledSection(rows, "x", 1500);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text.startsWith("## Recalled memory")).toBe(true);
    expect(formatRecalledSection([], "x")).toBe("");
  });
});

describe("recall over Convex search (plan L4)", () => {
  test("a request about compaction recalls the compaction memory, not the unrelated one or another project's", async () => {
    const t = convexTest(schema, modules);
    const { p1 } = await seed(t);
    const titles = await t.run(async (ctx) =>
      (await recallMemories(ctx, { projectId: p1 }, "Tune the compaction threshold for gpt-mini")).map((m) => m.title)
    );
    expect(titles).toEqual(["Compaction"]);
  });

  test("the pinned section is byte-identical with and without recall", async () => {
    const t = convexTest(schema, modules);
    const { p1 } = await seed(t);
    const { pinned, recalled } = await t.run(async (ctx) => ({
      pinned: await loadMemorySection(ctx, { projectId: p1 }),
      recalled: await loadRecalledSection(ctx, { projectId: p1 }, "compaction threshold"),
    }));
    expect(pinned).toContain("Use pnpm");
    expect(pinned).not.toContain("compaction");
    expect(recalled).toContain("compaction threshold is 80%");
    expect(recalled).not.toContain("pnpm");
    expect(recalled).not.toContain("50%");
  });

  test("getRunContext carries the recalled section beside the unchanged pinned one", async () => {
    const t = convexTest(schema, modules);
    const { p1 } = await seed(t);
    const taskId = await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle", isEnabled: true });
      await ctx.db.patch(p1, { agentIds: [agentId] } as never);
      return await ctx.db.insert("tasks", {
        projectId: p1,
        title: "Compaction",
        command: "Lower the compaction threshold",
        status: "queued",
      });
    });
    const run = await t.query(internal.orchestration.getRunContext, { taskId });
    const agent = run!.agents[0];
    expect(agent.memorySection).toContain("Use pnpm");
    expect(agent.memorySection).not.toContain("compaction");
    expect(agent.recalledMemorySection).toContain("compaction threshold is 80%");
  });

  test("an empty or stopword-only request recalls nothing and the search box returns ≤10 hits", async () => {
    const t = convexTest(schema, modules);
    const { p1 } = await seed(t);
    expect(await t.run(async (ctx) => recallMemories(ctx, { projectId: p1 }, "the and for"))).toEqual([]);
    const hits = await t.query(api.memories.search, { scope: "project", projectId: p1, text: "compaction" });
    expect(hits.map((h) => h.title)).toEqual(["Compaction"]);
    expect(hits.length).toBeLessThanOrEqual(RECALL_MAX);
  });
});
