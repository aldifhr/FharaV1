/**
 * Builds apps/api/convex/lib/builtinSkills.data.ts from skills/builtin/<name>/SKILL.md.
 *
 *   npm run skills:builtin
 *
 * Convex cannot read files at run time, so the built-in skill text is
 * bundled as a generated module. builtinSkills.test.ts fails when the
 * generated file and the SKILL.md sources drift apart.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBuiltinSkillData, readBuiltinSkillSources } from "../apps/api/convex/lib/builtinSkillSource";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "skills/builtin");
const OUT = join(ROOT, "apps/api/convex/lib/builtinSkills.data.ts");

const files = readdirSync(DIR)
  .filter((name) => statSync(join(DIR, name)).isDirectory())
  .map((name) => ({ folder: name, text: readFileSync(join(DIR, name, "SKILL.md"), "utf8") }));
const skills = readBuiltinSkillSources(files);
writeFileSync(OUT, renderBuiltinSkillData(skills));
console.log(`wrote ${OUT} (${skills.length} skills)`);
