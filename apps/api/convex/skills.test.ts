/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEFAULT_SKILLS, SKILL_INSTRUCTIONS_MAX, SKILL_NAME_MAX } from "./lib/skills";

const modules = import.meta.glob("./**/*.ts");

async function agent(t: ReturnType<typeof convexTest>, role = "frontend") {
  return await t.run((ctx) =>
    ctx.db.insert("agents", { name: role, role, status: "idle", isEnabled: true })
  );
}

describe("skills library", () => {
  test("create validates name/instructions length and uniqueness", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.skills.create, { name: "x".repeat(SKILL_NAME_MAX + 1), instructions: "do" })
    ).rejects.toThrow(/60 characters/);
    await expect(
      t.mutation(api.skills.create, { name: "Big", instructions: "y".repeat(SKILL_INSTRUCTIONS_MAX + 1) })
    ).rejects.toThrow(/20000/);
    await expect(t.mutation(api.skills.create, { name: "  ", instructions: "do" })).rejects.toThrow(/required/);
    const id = await t.mutation(api.skills.create, { name: " Lint ", instructions: " run lint ", tags: ["CI", "ci", " "] });
    const row = await t.query(api.skills.get, { skillId: id });
    expect(row?.name).toBe("Lint");
    expect(row?.instructions).toBe("run lint");
    expect(row?.tags).toEqual(["ci"]);
    await expect(t.mutation(api.skills.create, { name: "Lint", instructions: "again" })).rejects.toThrow(/already exists/);
  });

  test("setAgents attaches/detaches; list reports usedBy; remove pulls the id from agents", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const be = await agent(t, "backend");
    const s1 = await t.mutation(api.skills.create, { name: "A", instructions: "a" });
    const s2 = await t.mutation(api.skills.create, { name: "B", instructions: "b" });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [s2, s1, s2] });
    expect((await t.run((ctx) => ctx.db.get(fe)))?.skillIds).toEqual([s2, s1]);

    await t.mutation(api.skills.setAgents, { skillId: s1, agentIds: [be] });
    expect((await t.run((ctx) => ctx.db.get(fe)))?.skillIds).toEqual([s2]);
    expect((await t.run((ctx) => ctx.db.get(be)))?.skillIds).toEqual([s1]);

    const listed = await t.query(api.skills.list, {});
    expect(listed.map((s) => s.name)).toEqual(["A", "B"]);
    expect(listed[0].usedBy.map((a) => a.role)).toEqual(["backend"]);

    await t.mutation(api.skills.remove, { skillId: s1 });
    expect((await t.run((ctx) => ctx.db.get(be)))?.skillIds).toBeUndefined();
    expect(await t.query(api.skills.get, { skillId: s1 })).toBeNull();
  });

  test("seedDefaults is idempotent and only seeds an empty library", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(api.skills.seedDefaults, {})).toEqual({ inserted: DEFAULT_SKILLS.length });
    expect(await t.mutation(api.skills.seedDefaults, {})).toEqual({ inserted: 0 });
    expect(await t.query(api.skills.list, {})).toHaveLength(DEFAULT_SKILLS.length);
  });

  test("getRunContext delivers attached skills in agent order", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t);
    const s1 = await t.mutation(api.skills.create, { name: "First", instructions: "one" });
    const s2 = await t.mutation(api.skills.create, { name: "Second", instructions: "two" });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [s2, s1] });
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds: [fe] } as never);
      return await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "queued", assignedAgentIds: [fe] });
    });
    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(result!.agents[0].attachedSkills).toEqual([
      { name: "Second", instructions: "two" },
      { name: "First", instructions: "one" },
    ]);
  });
});
