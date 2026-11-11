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
import { ROLE_KEYS } from "./lib/roles";

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
  test("only MIT / Apache-2.0 text, every key has roles; code roles get the discipline skill", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(["MIT", "Apache-2.0"]).toContain(skill.license);
      expect(skill.roles.length).toBeGreaterThan(0);
      if (skill.upstream) expect(["MIT", "Apache-2.0"]).toContain(skill.upstream.license);
    }
    expect(builtinSkillKeysForRole("designer")).toEqual(
      BUILTIN_SKILLS.filter((s) => s.key !== "fhara-discipline" && s.key !== "review-checklist").map((s) => s.key)
    );
    expect(builtinSkillKeysForRole("backend")).toEqual(["fhara-discipline", "review-checklist"]);
    expect(builtinSkillKeysForRole("devops")).toEqual(["fhara-discipline"]);
    expect(builtinSkillKeysForRole("frontend").slice(-2)).toEqual(["fhara-discipline", "review-checklist"]);
  });

  test("review-checklist goes to Reviewer, Frontend, Backend and QA only, and names no upstream product", () => {
    const holders = ROLE_KEYS.filter((role) => builtinSkillKeysForRole(role).includes("review-checklist"));
    expect([...holders].sort()).toEqual(["backend", "frontend", "qa", "reviewer"]);
    const skill = BUILTIN_SKILLS.find((s) => s.key === "review-checklist")!;
    expect(skill.license).toBe("MIT");
    expect(skill.upstream?.repo).toBe("deepseek-ai/deepseek-harness");
    // The attribution lives in the front matter, which is not part of the prompt text.
    expect(`${skill.name}\n${skill.description}\n${skill.instructions}`).not.toMatch(/deepseek|\bdsh\b/i);
  });

  test("every role's default set fits the inline prompt budget whole", () => {
    for (const role of ROLE_KEYS) {
      const keys = builtinSkillKeysForRole(role);
      const skills = BUILTIN_SKILLS.filter((s) => keys.includes(s.key));
      const section = formatSkillsSection(skills.map((s) => ({ name: s.name, instructions: s.instructions })));
      expect(section.length).toBeLessThanOrEqual(SKILLS_PROMPT_BUDGET);
      expect(section).not.toContain("…(truncated)");
      for (const skill of skills) expect(section).toContain(`## Skill: ${skill.name}`);
    }
  });
});

describe("built-in skill seeding", () => {
  test("seeds once, attaches by role in order, respects deletes, detaches and edits", async () => {
    const t = makeT();
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const seeded = await t.run(async (ctx) => (await ctx.db.query("skills").collect()).filter((s) => s.builtin));
    expect(seeded.map((s) => s.builtin).sort()).toEqual(BUILTIN_SKILLS.map((s) => s.key).sort());

    const designer = await agentByRole(t, "designer");
    expect(await skillNames(t, designer.skillIds)).toEqual(
      BUILTIN_SKILLS.filter((s) => s.key !== "fhara-discipline" && s.key !== "review-checklist").map((s) => s.name)
    );
    expect(await skillNames(t, (await agentByRole(t, "frontend")).skillIds)).toEqual([
      "design-system-detection",
      "frontend-design",
      "ui-ux-rules",
      "fhara-discipline",
      "review-checklist",
    ]);
    expect(await skillNames(t, (await agentByRole(t, "qa")).skillIds)).toEqual([
      "design-options-review",
      "accessibility-audit",
      "review-checklist",
    ]);
    expect(await skillNames(t, (await agentByRole(t, "reviewer")).skillIds)).toEqual([
      "accessibility-audit",
      "web-interface-guidelines",
      "review-checklist",
    ]);
    expect(await skillNames(t, (await agentByRole(t, "backend")).skillIds)).toEqual(["fhara-discipline", "review-checklist"]);
    expect(await skillNames(t, (await agentByRole(t, "devops")).skillIds)).toEqual(["fhara-discipline"]);

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
    expect(designerAfter.builtinSkillsApplied).toEqual(expect.arrayContaining(builtinSkillKeysForRole("designer")));
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
