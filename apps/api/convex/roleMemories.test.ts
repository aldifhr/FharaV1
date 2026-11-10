/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { loadMemorySection, recallMemories } from "./memories";
import {
  ROLE_LEARNINGS_MAX,
  ROLE_MEMORY_CAP,
  cleanLearning,
  findDuplicate,
  looksLikeRawDiff,
  noteSimilarity,
  parseLearnings,
  pickEvictions,
} from "./lib/roleMemory";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "role-memory-harness-token";

async function setup(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", isEnabled: true });
    const qa = await ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle", isEnabled: true });
    const p1 = await ctx.db.insert("projects", { name: "P1", workspacePath: "/tmp/p1", agentIds: [fe, qa] } as never);
    const p2 = await ctx.db.insert("projects", { name: "P2", workspacePath: "/tmp/p2", agentIds: [fe, qa] } as never);
    return { fe, qa, p1, p2 };
  });
}

const roleRows = (t: ReturnType<typeof convexTest>, projectId: string, agentId: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("memories").collect()).filter(
      (row) => row.scope === "agent" && row.projectId === projectId && row.agentId === agentId
    )
  );

describe("role memory helpers (lib/roleMemory.ts)", () => {
  test("parseLearnings accepts an object or bare array, drops junk, caps at the max", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `Note ${i} about module${i}`, content: `Detail ${i} unique${i} words${i}`, kind: "fact" }));
    expect(parseLearnings(JSON.stringify({ learnings: many }))).toHaveLength(ROLE_LEARNINGS_MAX);
    expect(parseLearnings("```json\n[{\"title\":\"A\",\"content\":\"B\",\"kind\":\"pitfall\"}]\n```")).toEqual([
      { title: "A", content: "B", kind: "pitfall" },
    ]);
    expect(parseLearnings('{"learnings":[{"title":"","content":"x"},{"title":"T","content":"c","kind":"weird"}]}')).toEqual([
      { title: "T", content: "c", kind: "fact" },
    ]);
    expect(parseLearnings("not json")).toBeNull();
    expect(parseLearnings('{"learnings":[]}')).toEqual([]);
  });

  test("cleanLearning masks secrets and refuses raw diffs", () => {
    const secret = cleanLearning({ title: "Deploy", content: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push", kind: "fact" });
    expect(secret?.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(secret?.content).toContain("[REDACTED]");
    const diff = "diff --git a/x.ts b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new";
    expect(looksLikeRawDiff(diff)).toBe(true);
    expect(cleanLearning({ title: "Patch", content: diff })).toBeNull();
  });

  test("similarity dedupe and eviction order", () => {
    expect(noteSimilarity("Use pnpm not npm", "use PNPM, not npm!")).toBe(1);
    const rows = [{ title: "Package manager", content: "Use pnpm, never npm in this repo." }];
    expect(findDuplicate(rows, { title: "package manager!", content: "different" })).toBe(rows[0]);
    expect(findDuplicate(rows, { title: "Tooling", content: "Use pnpm never npm in this repo" })).toBe(rows[0]);
    expect(findDuplicate(rows, { title: "Colours", content: "Brand teal for buttons" })).toBeNull();
    const evict = pickEvictions(
      [
        { id: 1, pinned: true, source: "agent" as const, updatedAt: 1 },
        { id: 2, pinned: false, source: "user" as const, updatedAt: 2 },
        { id: 3, pinned: false, source: "agent" as const, updatedAt: 3 },
        { id: 4, pinned: false, source: "agent" as const, updatedAt: 4 },
      ],
      3
    );
    expect(evict.map((r) => r.id)).toEqual([3]);
  });
});

describe("role memory upsert (roleMemories.upsertLearnings)", () => {
  beforeEach(() => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  });
  afterEach(() => vi.useRealTimers());

  test("writes unpinned agent-scope rows with projectId; the worker action is token-gated", async () => {
    const t = convexTest(schema, modules);
    const { fe, p1 } = await setup(t);
    await expect(
      t.action(api.worker.recordRoleLearnings, { projectId: p1, agentId: fe, learnings: [], workerToken: "nope" })
    ).rejects.toThrow();
    const res = await t.action(api.worker.recordRoleLearnings, {
      projectId: p1,
      agentId: fe,
      workerToken: SERVICE_TOKEN,
      learnings: [{ title: "Tailwind tokens", content: "Buttons use the ink token, never raw hex.", kind: "convention" }],
    });
    expect(res).toMatchObject({ applied: true, inserted: 1, updated: 0 });
    const rows = await roleRows(t, p1, fe);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "agent", pinned: false, source: "agent", tags: ["convention"] });
  });

  test("a near-duplicate updates instead of inserting; pinned and user notes are left alone", async () => {
    const t = convexTest(schema, modules);
    const { fe, p1 } = await setup(t);
    await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1,
      agentId: fe,
      learnings: [{ title: "Package manager", content: "Use pnpm, never npm.", kind: "fact" }],
    });
    const second = await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1,
      agentId: fe,
      learnings: [{ title: "Package manager", content: "Use pnpm, never npm or yarn.", kind: "fact" }],
    });
    expect(second).toMatchObject({ inserted: 0, updated: 1 });
    const rows = await roleRows(t, p1, fe);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Use pnpm, never npm or yarn.");
    // The user pins it: the role can no longer rewrite it.
    await t.mutation(api.memories.setPinned, { memoryId: rows[0]._id, pinned: true });
    await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1,
      agentId: fe,
      learnings: [{ title: "Package manager", content: "Use npm.", kind: "fact" }],
    });
    expect((await roleRows(t, p1, fe))[0].content).toBe("Use pnpm, never npm or yarn.");
  });

  test("redacts secrets before saving", async () => {
    const t = convexTest(schema, modules);
    const { fe, p1 } = await setup(t);
    await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1,
      agentId: fe,
      learnings: [{ title: "API", content: "Call it with api_key=sk-live-SECRETVALUE1234567890 header" }],
    });
    const [row] = await roleRows(t, p1, fe);
    expect(row.content).not.toContain("SECRETVALUE1234567890");
  });

  test("caps a role at ROLE_MEMORY_CAP per project, evicting the oldest agent-written unpinned rows", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { fe, p1, p2 } = await setup(t);
    const keeper = await t.run(async (ctx) =>
      ctx.db.insert("memories", {
        scope: "agent", projectId: p1, agentId: fe, title: "Mine", content: "zzz user note", pinned: false,
        source: "user", createdAt: 0, updatedAt: 0,
      })
    );
    for (let batch = 0; batch < 11; batch++) {
      vi.advanceTimersByTime(1000);
      await t.mutation(internal.roleMemories.upsertLearnings, {
        projectId: p1,
        agentId: fe,
        learnings: Array.from({ length: 5 }, (_, i) => ({
          title: `Learning b${batch} i${i}`,
          content: `alpha${batch}x${i} beta${batch}y${i} gamma${batch}z${i}`,
        })),
      });
    }
    const rows = await roleRows(t, p1, fe);
    expect(rows).toHaveLength(ROLE_MEMORY_CAP);
    expect(rows.some((row) => row._id === keeper)).toBe(true);
    expect(rows.some((row) => row.title === "Learning b0 i0")).toBe(false);
    expect(rows.some((row) => row.title === "Learning b10 i4")).toBe(true);
    // Another project is untouched.
    expect(await roleRows(t, p2, fe)).toHaveLength(0);
  });

  test("the project toggle stops writes but keeps recall", async () => {
    const t = convexTest(schema, modules);
    const { fe, p1 } = await setup(t);
    expect(await t.query(api.roleMemories.getProjectSetting, { projectId: p1 })).toMatchObject({ enabled: true });
    await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1,
      agentId: fe,
      learnings: [{ title: "Compaction", content: "The compaction threshold lives in config/llm.ts." }],
    });
    await t.mutation(api.roleMemories.setProjectSetting, { projectId: p1, enabled: false });
    expect(await t.query(api.roleMemories.getProjectSetting, { projectId: p1 })).toMatchObject({ enabled: false });
    const res = await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1,
      agentId: fe,
      learnings: [{ title: "Other", content: "Something new about routing." }],
    });
    expect(res).toMatchObject({ applied: false, reason: "disabled", inserted: 0 });
    expect(await roleRows(t, p1, fe)).toHaveLength(1);
    const recalled = await t.run(async (ctx) =>
      (await recallMemories(ctx, { projectId: p1, agentId: fe }, "where is the compaction threshold")).map((m) => m.title)
    );
    expect(recalled).toEqual(["Compaction"]);
    await t.mutation(api.roleMemories.setProjectSetting, { projectId: p1, enabled: true });
    expect(await t.run(async (ctx) => (await ctx.db.get(p1))?.roleMemoryDisabled)).toBeFalsy();
  });
});

describe("role memory recall isolation", () => {
  test("a role recalls its own rows in this project + its global rows; never another role's or another project's", async () => {
    const t = convexTest(schema, modules);
    const { fe, qa, p1, p2 } = await setup(t);
    await t.run(async (ctx) => {
      const base = { scope: "agent" as const, pinned: false, source: "agent" as const, createdAt: 1, updatedAt: 1 };
      await ctx.db.insert("memories", { ...base, projectId: p1, agentId: fe, title: "FE P1", content: "compaction note frontend p1" });
      await ctx.db.insert("memories", { ...base, projectId: p2, agentId: fe, title: "FE P2", content: "compaction note frontend p2" });
      await ctx.db.insert("memories", { ...base, projectId: p1, agentId: qa, title: "QA P1", content: "compaction note qa p1" });
      await ctx.db.insert("memories", { ...base, agentId: fe, source: "user", title: "FE global", content: "compaction note frontend global" });
    });
    const recall = (projectId: typeof p1 | undefined, agentId: typeof fe) =>
      t.run(async (ctx) =>
        (await recallMemories(ctx, { ...(projectId ? { projectId } : {}), agentId }, "compaction note")).map((m) => m.title).sort()
      );
    expect(await recall(p1, fe)).toEqual(["FE P1", "FE global"]);
    expect(await recall(p2, fe)).toEqual(["FE P2", "FE global"]);
    expect(await recall(p1, qa)).toEqual(["QA P1"]);
    // Personal chat (no project): only the global rows.
    expect(await recall(undefined, fe)).toEqual(["FE global"]);
  });

  test("pinned section: own pinned rows in this project + global, never another project's", async () => {
    const t = convexTest(schema, modules);
    const { fe, qa, p1, p2 } = await setup(t);
    await t.run(async (ctx) => {
      const base = { scope: "agent" as const, pinned: true, source: "user" as const, createdAt: 1, updatedAt: 1 };
      await ctx.db.insert("memories", { ...base, projectId: p1, agentId: fe, title: "Pinned FE P1", content: "a" });
      await ctx.db.insert("memories", { ...base, projectId: p2, agentId: fe, title: "Pinned FE P2", content: "b" });
      await ctx.db.insert("memories", { ...base, agentId: fe, title: "Pinned FE global", content: "c" });
      await ctx.db.insert("memories", { ...base, projectId: p1, agentId: qa, title: "Pinned QA P1", content: "d" });
    });
    const section = await t.run((ctx) => loadMemorySection(ctx, { projectId: p1, agentId: fe }));
    expect(section).toContain("Pinned FE P1");
    expect(section).toContain("Pinned FE global");
    expect(section).not.toContain("Pinned FE P2");
    expect(section).not.toContain("Pinned QA P1");
    const personal = await t.run((ctx) => loadMemorySection(ctx, { agentId: fe }));
    expect(personal).toContain("Pinned FE global");
    expect(personal).not.toContain("Pinned FE P1");
  });

  test("/memory list: agent scope with a project lists that role@project; without, the global rows", async () => {
    const t = convexTest(schema, modules);
    const { fe, p1 } = await setup(t);
    await t.mutation(api.memories.create, { scope: "agent", agentId: fe, projectId: p1, title: "Role P1", content: "x" });
    await t.mutation(api.memories.create, { scope: "agent", agentId: fe, title: "Global", content: "y" });
    const scoped = await t.query(api.memories.list, { scope: "agent", agentId: fe, projectId: p1 });
    expect(scoped.map((m) => m.title)).toEqual(["Role P1"]);
    const global = await t.query(api.memories.list, { scope: "agent", agentId: fe });
    expect(global.map((m) => m.title)).toEqual(["Global"]);
  });
});

describe("role memory in the project cascade", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("deleting a project deletes its role notes and keeps the role's global and other-project notes", async () => {
    const t = convexTest(schema, modules);
    const { fe, p1, p2 } = await setup(t);
    await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p1, agentId: fe, learnings: [{ title: "Doomed", content: "goes with the project" }],
    });
    await t.mutation(internal.roleMemories.upsertLearnings, {
      projectId: p2, agentId: fe, learnings: [{ title: "Kept", content: "other project" }],
    });
    await t.mutation(api.memories.create, { scope: "agent", agentId: fe, title: "Global", content: "every project" });
    await t.mutation(api.projects.remove, { projectId: p1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const titles = await t.run(async (ctx) => (await ctx.db.query("memories").collect()).map((m) => m.title).sort());
    expect(titles).toEqual(["Global", "Kept"]);
  });
});
