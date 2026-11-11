/**
 * Built-in skills Fhara ships with (pure; no Convex APIs).
 *
 * The text lives in skills/builtin/<key>/SKILL.md and is bundled through
 * the generated builtinSkills.data.ts. This module adds what the files do
 * not say: which fixed-team roles get each skill by default, the order
 * they are attached in (the inline prompt budget drops the last skills
 * first), and where adapted text came from.
 *
 * Seeding (agents.ts `syncFixedTeam` → skills.ts `seedBuiltinSkills`):
 *  - a built-in is inserted into the Library once; deleting it is final
 *    (`builtinSkillSeeds` remembers it was seeded);
 *  - each enabled fixed-team agent of a default role gets it attached
 *    once; detaching it is final too (`agents.builtinSkillsApplied`).
 * User edits to a seeded skill are never overwritten.
 */
import { BUILTIN_SKILL_SOURCES } from "./builtinSkills.data";
import type { BuiltinSkillSource } from "./builtinSkillSource";
import type { RoleKey } from "./roles";

export type BuiltinSkillMeta = {
  key: string;
  /** Fixed-team roles that get the skill attached by default. */
  roles: readonly RoleKey[];
  /** Tags stored on the Library row. */
  tags: readonly string[];
  /** Upstream the text was adapted from; unset for Fhara-written skills. */
  upstream?: { repo: string; path: string; license: string; sha?: string };
};

/** Attach order matters: inline skills share one budget (lib/skills.ts). */
export const BUILTIN_SKILL_META: readonly BuiltinSkillMeta[] = [
  { key: "design-system-detection", roles: ["designer", "frontend"], tags: ["design", "frontend", "builtin"] },
  {
    key: "design-options-review",
    roles: ["designer", "qa"],
    tags: ["design", "review", "builtin"],
    upstream: { repo: "mikecann/threadbear", path: "AGENTS.md (show_options rules)", license: "MIT", sha: "b697f32" },
  },
  {
    key: "frontend-design",
    roles: ["designer", "frontend"],
    tags: ["design", "frontend", "builtin"],
    upstream: {
      repo: "anthropics/skills",
      path: "skills/frontend-design/SKILL.md",
      license: "Apache-2.0",
      sha: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
    },
  },
  {
    key: "ui-ux-rules",
    roles: ["designer", "frontend"],
    tags: ["design", "ux", "builtin"],
    upstream: {
      repo: "nextlevelbuilder/ui-ux-pro-max-skill",
      path: "src/ui-ux-pro-max (rules + data)",
      license: "MIT",
      sha: "6ae86f61f520d6ca229d2f40e070410638c908c5",
    },
  },
  {
    key: "accessibility-audit",
    roles: ["designer", "qa", "reviewer"],
    tags: ["a11y", "review", "builtin"],
    upstream: {
      repo: "khasky/awesome-agent-skills",
      path: "skills/awesome-accessibility-audit/SKILL.md",
      license: "MIT",
      sha: "58ea4e8915de64907d04cc909a1b8c6e5cf0fcb7",
    },
  },
  {
    key: "web-interface-guidelines",
    roles: ["designer", "reviewer"],
    tags: ["design", "review", "builtin"],
    upstream: {
      repo: "vercel-labs/agent-skills",
      path: "skills/web-design-guidelines/SKILL.md",
      license: "MIT",
      sha: "1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62",
    },
  },
  {
    // Last, so a code role's design skills keep their place in the budget.
    key: "fhara-discipline",
    roles: ["frontend", "backend", "devops"],
    tags: ["discipline", "verification", "builtin"],
    upstream: {
      repo: "goat-si/goat",
      path: "packages/provider-core/src/server/builtinSkills/goatDiscipline.ts",
      license: "MIT",
      sha: "718f5b11",
    },
  },
  {
    // After the discipline skill: the code roles' budget drops it first.
    key: "review-checklist",
    roles: ["reviewer", "frontend", "backend", "qa"],
    tags: ["review", "testing", "builtin"],
    upstream: {
      repo: "deepseek-ai/deepseek-harness",
      path: "docs/defensive-patterns/general.md, docs/testing.md, .agents/skills (code-review, error-handling, ci-test-reliability)",
      license: "MIT",
      sha: "e8f7b93",
    },
  },
];

export type BuiltinSkill = BuiltinSkillSource & BuiltinSkillMeta;

/** Built-ins in attach order, text joined with metadata. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = BUILTIN_SKILL_META.map((meta) => {
  const source = BUILTIN_SKILL_SOURCES.find((s) => s.key === meta.key);
  if (!source) throw new Error(`Built-in skill "${meta.key}" has no skills/builtin/${meta.key}/SKILL.md`);
  return { ...source, ...meta };
});

/** Built-in keys a role gets by default, in attach order. */
export function builtinSkillKeysForRole(role: string | undefined): string[] {
  const key = (role ?? "").trim().toLowerCase();
  return BUILTIN_SKILLS.filter((s) => (s.roles as readonly string[]).includes(key)).map((s) => s.key);
}
