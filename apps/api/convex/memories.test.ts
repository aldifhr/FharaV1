/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  MEMORY_CONTENT_MAX,
  MEMORY_PROMPT_BUDGET,
  formatMemorySection,
  memoryFromMessage,
  selectPromptMemories,
  type MemoryLike,
} from "./lib/memory";

const modules = import.meta.glob("./**/*.ts");

const row = (over: Partial<MemoryLike>): MemoryLike => ({
  scope: "shared",
  title: "t",
  content: "c",
  pinned: true,
  createdAt: 0,
  ...over,
});

describe("memory injection helpers", () => {
  test("selects pinned shared → project → agent, oldest first, filtered by target", () => {
    const rows: MemoryLike[] = [
      row({ scope: "agent", agentId: "a1", title: "agent-mine", createdAt: 1 }),
      row({ scope: "agent", agentId: "a2", title: "agent-other", createdAt: 1 }),
      row({ scope: "project", projectId: "p1", title: "project-2", createdAt: 5 }),
      row({ scope: "project", projectId: "p1", title: "project-1", createdAt: 2 }),
      row({ scope: "project", projectId: "p2", title: "project-other", createdAt: 1 }),
      row({ scope: "shared", title: "shared-unpinned", pinned: false, createdAt: 0 }),
      row({ scope: "shared", title: "shared-1", createdAt: 9 }),
    ];
    expect(selectPromptMemories(rows, { projectId: "p1", agentId: "a1" }).map((m) => m.title)).toEqual([
      "shared-1",
      "project-1",
      "project-2",
      "agent-mine",
    ]);
    expect(selectPromptMemories(rows, {}).map((m) => m.title)).toEqual(["shared-1"]);
  });

  test("formats one section under the budget, truncating then dropping", () => {
    const big = "x".repeat(MEMORY_PROMPT_BUDGET);
    const section = formatMemorySection([
      { title: "Small", content: "ok" },
      { title: "Big", content: big },
      { title: "Dropped", content: "never" },
    ]);
    expect(section.startsWith("## Memory\n")).toBe(true);
    expect(section.length).toBeLessThanOrEqual(MEMORY_PROMPT_BUDGET);
    expect(section).toContain("### Small\nok");
    expect(section).toContain("### Big\n");
    expect(section).toContain("(truncated)");
    expect(section).not.toContain("Dropped");
    expect(formatMemorySection([])).toBe("");
  });

  test("memoryFromMessage titles from the first line and caps content", () => {
    const m = memoryFromMessage("## Use pnpm\n\nnever npm");
    expect(m.title).toBe("Use pnpm");
    expect(m.content).toBe("## Use pnpm\n\nnever npm");
    expect(memoryFromMessage("y".repeat(MEMORY_CONTENT_MAX + 50)).content.length).toBe(MEMORY_CONTENT_MAX);
  });
});

describe("memories functions", () => {
  async function setup(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", isEnabled: true, systemPrompt: "static" });
      const qa = await ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle", isEnabled: true });
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds: [fe, qa] } as never);
      const otherProject = await ctx.db.insert("projects", { name: "Q", workspacePath: "q", agentIds: [] } as never);
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "queued", assignedAgentIds: [fe] });
      return { fe, qa, projectId, otherProject, taskId };
    });
  }

  test("getRunContext injects pinned memories after skills in scope order", async () => {
    const t = convexTest(schema, modules);
    const { fe, qa, projectId, otherProject, taskId } = await setup(t);
    await t.mutation(api.memories.create, { scope: "agent", agentId: fe, title: "Mine", content: "agent note", pinned: true });
    await t.mutation(api.memories.create, { scope: "agent", agentId: qa, title: "Not mine", content: "qa note", pinned: true });
    await t.mutation(api.memories.create, { scope: "project", projectId, title: "Proj", content: "project note", pinned: true });
    await t.mutation(api.memories.create, { scope: "project", projectId: otherProject, title: "Other", content: "x", pinned: true });
    await t.mutation(api.memories.create, { scope: "shared", title: "Ref", content: "unpinned", pinned: false });
    await t.mutation(api.memories.create, { scope: "shared", title: "All", content: "shared note", pinned: true });

    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    const section = result!.agents[0].memorySection!;
    expect(section.startsWith("## Memory")).toBe(true);
    const order = ["### All", "### Proj", "### Mine"].map((h) => section.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(section).not.toContain("Not mine");
    expect(section).not.toContain("Other");
    expect(section).not.toContain("unpinned");
  });

  test("getRunContext omits memorySection when nothing is pinned", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await setup(t);
    await t.mutation(api.memories.create, { scope: "shared", title: "Ref", content: "unpinned" });
    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(result!.agents[0].memorySection).toBeUndefined();
  });

  test("chat context carries the memory section per agent", async () => {
    const t = convexTest(schema, modules);
    const { fe, projectId } = await setup(t);
    await t.mutation(api.memories.create, { scope: "project", projectId, title: "Proj", content: "project note", pinned: true });
    const data = await t.query(internal.chatContext.getContext, { projectId, preferredAgentIds: [fe] });
    expect(data.agents[0].memorySection).toContain("### Proj\nproject note");
  });

  test("validation, list ordering, pin, update and remove", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await setup(t);
    await expect(t.mutation(api.memories.create, { scope: "project", title: "x", content: "y" })).rejects.toThrow(/needs a project/);
    await expect(t.mutation(api.memories.create, { scope: "agent", title: "x", content: "y" })).rejects.toThrow(/needs an agent/);
    await expect(
      t.mutation(api.memories.create, { scope: "shared", title: "x", content: "y".repeat(MEMORY_CONTENT_MAX + 1) })
    ).rejects.toThrow(/4000/);
    const a = await t.mutation(api.memories.create, { scope: "project", projectId, title: "A", content: "a" });
    const b = await t.mutation(api.memories.create, { scope: "project", projectId, title: "B", content: "b", pinned: true });
    expect((await t.query(api.memories.list, { scope: "project", projectId })).map((m) => m.title)).toEqual(["B", "A"]);
    await t.mutation(api.memories.setPinned, { memoryId: a, pinned: true });
    await t.mutation(api.memories.update, { memoryId: b, title: "B2", tags: ["X", "x"], pinned: false });
    const listed = await t.query(api.memories.list, { scope: "project", projectId });
    expect(listed.map((m) => [m.title, m.pinned])).toEqual([["A", true], ["B2", false]]);
    expect(listed[1].tags).toEqual(["x"]);
    await t.mutation(api.memories.remove, { memoryId: a });
    expect(await t.query(api.memories.list, { scope: "project", projectId })).toHaveLength(1);
    expect(await t.query(api.memories.list, { scope: "shared" })).toHaveLength(0);
  });

  test("rememberMessage creates one pinned project memory per message text", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await setup(t);
    const messageId = await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, authorType: "agent", content: "Use pnpm\nnever npm" } as never)
    );
    const first = await t.mutation(api.memories.rememberMessage, { messageId });
    const again = await t.mutation(api.memories.rememberMessage, { messageId });
    expect(first.created).toBe(true);
    expect(again).toEqual({ memoryId: first.memoryId, created: false });
    const [memory] = await t.query(api.memories.list, { scope: "project", projectId });
    expect(memory).toMatchObject({ title: "Use pnpm", pinned: true, source: "user", scope: "project" });
  });
});
