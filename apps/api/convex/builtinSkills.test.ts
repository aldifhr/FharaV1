/// <reference types="vite/client" />
/**
 * Built-in skills: the fixed-team sync seeds them into the Library once and
 * attaches each role's defaults once per agent; user deletes, detaches and
 * edits are never undone by a later sync.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { BUILTIN_SKILLS, builtinSkillKeysForRole } from "./lib/builtinSkills";
import { installedIndex, catalogKey, BUILTIN_CATALOG_REPO, builtinCatalogPath } from "./lib/skillCatalog";
import { formatSkillsSection, SKILLS_PROMPT_BUDGET } from "./lib/skills";

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);

async function agentByRole(t: ReturnType<typeof makeT>, role: string) {
  return await t.run(async (ctx) => (await ctx.db.query("agents").collect()).find((a) => a.role === role)!);
}

async function skillNames(t: ReturnType<typeof makeT>, ids: readonly string[] | undefined) {
  return await t.run(async (ctx) =>
    Promise.all((ids ?? []).map(async (id) => (await ctx.db.get(id as never) as { name: string } | null)?.name ?? "?"))
  );
}

describe("built-in skill metadata", () => {
  test("only MIT / Apache-2.0 text, every key has roles, designer gets them all", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(["MIT", "Apache-2.0"]).toContain(skill.license);
      expect(skill.roles.length).toBeGreaterThan(0);
      if (skill.upstream) expect(["MIT", "Apache-2.0"]).toContain(skill.upstream.license);
    }
    expect(builtinSkillKeysForRole("designer")).toHaveLength(BUILTIN_SKILLS.length);
    expect(builtinSkillKeysForRole("backend")).toEqual([]);
  });

  test("the Designer's full set fits the inline prompt budget whole", () => {
    const section = formatSkillsSection(BUILTIN_SKILLS.map((s) => ({ name: s.name, instructions: s.instructions })));
    expect(section.length).toBeLessThanOrEqual(SKILLS_PROMPT_BUDGET);
    expect(section).not.toContain("…(truncated)");
    for (const skill of BUILTIN_SKILLS) expect(section).toContain(`## Skill: ${skill.name}`);
  });
});

describe("built-in skill seeding", () => {
  test("seeds once, attaches by role in order, respects deletes, detaches and edits", async () => {
    const t = makeT();
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const seeded = await t.run(async (ctx) => (await ctx.db.query("skills").collect()).filter((s) => s.builtin));
    expect(seeded.map((s) => s.builtin).sort()).toEqual(BUILTIN_SKILLS.map((s) => s.key).sort());

    const designer = await agentByRole(t, "designer");
    expect(await skillNames(t, designer.skillIds)).toEqual(BUILTIN_SKILLS.map((s) => s.name));
    expect(await skillNames(t, (await agentByRole(t, "frontend")).skillIds)).toEqual([
      "design-system-detection",
      "frontend-design",
      "ui-ux-rules",
    ]);
    expect(await skillNames(t, (await agentByRole(t, "qa")).skillIds)).toEqual(["design-options-review", "accessibility-audit"]);
    expect(await skillNames(t, (await agentByRole(t, "reviewer")).skillIds)).toEqual([
      "accessibility-audit",
      "web-interface-guidelines",
    ]);
    expect((await agentByRole(t, "backend")).skillIds ?? []).toEqual([]);

    // The user edits one, deletes another and detaches a third from the Designer.
    const byKey = new Map(seeded.map((s) => [s.builtin!, s._id]));
    await t.run(async (ctx) => {
      await ctx.db.patch(byKey.get("frontend-design")!, { instructions: "my own text" });
      await ctx.db.delete(byKey.get("web-interface-guidelines")!);
      const d = (await ctx.db.query("agents").collect()).find((a) => a.role === "designer")!;
      await ctx.db.patch(d._id, {
        skillIds: (d.skillIds ?? []).filter((id) => id !== byKey.get("ui-ux-rules") && id !== byKey.get("web-interface-guidelines")),
      });
    });
    await t.mutation(internal.agents.syncFixedTeamInternal, {});

    const after = await t.run(async (ctx) => (await ctx.db.query("skills").collect()).filter((s) => s.builtin));
    expect(after).toHaveLength(BUILTIN_SKILLS.length - 1);
    expect(after.find((s) => s.builtin === "frontend-design")!.instructions).toBe("my own text");
    const designerAfter = await agentByRole(t, "designer");
    expect(designerAfter.skillIds).not.toContain(byKey.get("ui-ux-rules"));
    expect(designerAfter.builtinSkillsApplied).toEqual(expect.arrayContaining(BUILTIN_SKILLS.map((s) => s.key)));
  });

  test("a same-named library skill is adopted, not duplicated", async () => {
    const t = makeT();
    const mine = await t.run(async (ctx) =>
      ctx.db.insert("skills", { name: "frontend-design", description: "mine", instructions: "mine", createdAt: 1, updatedAt: 1 })
    );
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const rows = await t.run(async (ctx) => (await ctx.db.query("skills").collect()).filter((s) => s.name === "frontend-design"));
    expect(rows.map((r) => r._id)).toEqual([mine]);
    expect((await agentByRole(t, "designer")).skillIds).toContain(mine);
  });

  test("Browse marks a seeded built-in as installed", () => {
    const map = installedIndex([{ _id: "s1", builtin: "ui-ux-rules" }]);
    expect(map.get(catalogKey(BUILTIN_CATALOG_REPO, builtinCatalogPath("ui-ux-rules")))?._id).toBe("s1");
  });
});
