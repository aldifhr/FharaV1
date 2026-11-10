/**
 * The generated apps/api/convex/lib/builtinSkills.data.ts must match
 * skills/builtin/<key>/SKILL.md (run `npm run skills:builtin` after editing
 * a SKILL.md), and Apache-2.0 skills carry their LICENSE.txt and NOTICE.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { readBuiltinSkillSources, renderBuiltinSkillData } from "@/api/convex/lib/builtinSkillSource";

const ROOT = resolve(__dirname, "../../..");
const DIR = join(ROOT, "skills/builtin");

describe("built-in skill sources", () => {
  const files = readdirSync(DIR)
    .filter((name) => statSync(join(DIR, name)).isDirectory())
    .map((folder) => ({ folder, text: readFileSync(join(DIR, folder, "SKILL.md"), "utf8") }));
  const skills = readBuiltinSkillSources(files);

  test("generated data is up to date", () => {
    const generated = readFileSync(join(ROOT, "apps/api/convex/lib/builtinSkills.data.ts"), "utf8");
    expect(generated).toBe(renderBuiltinSkillData(skills));
  });

  test("licences: MIT or Apache-2.0, Apache folders keep LICENSE.txt + NOTICE with a modification mark", () => {
    for (const skill of skills) {
      expect(["MIT", "Apache-2.0"]).toContain(skill.license);
      expect(skill.instructions.startsWith("<!--")).toBe(true);
      if (skill.license === "Apache-2.0") {
        expect(existsSync(join(DIR, skill.key, "LICENSE.txt"))).toBe(true);
        expect(readFileSync(join(DIR, skill.key, "NOTICE"), "utf8")).toMatch(/Modified by Fhara/);
        expect(skill.instructions).toMatch(/Modified by Fhara/);
      }
    }
  });

  test("every built-in is listed in the Browse index", () => {
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    for (const skill of skills) expect(readme).toContain(`skills/builtin/${skill.key})`);
  });
});
