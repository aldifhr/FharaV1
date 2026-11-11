/**
 * Builds apps/api/convex/lib/prompts/rolePrompts.data.ts from
 * apps/api/convex/lib/prompts/roles/<ROLE>.md.
 *
 *   npm run prompts:roles
 *
 * Convex and the worker cannot read files at run time, so the role prompt
 * templates are bundled as a generated module. The worker test
 * tests/rolePromptsSource.test.ts fails when it drifts from the markdown.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_KEYS, type RoleKey } from "../apps/api/convex/lib/roles";
import { ROLE_PROMPT_FILES, renderRolePromptData } from "../apps/api/convex/lib/prompts/rolePromptSource";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "apps/api/convex/lib/prompts/roles");
const OUT = join(ROOT, "apps/api/convex/lib/prompts/rolePrompts.data.ts");

const sources = Object.fromEntries(
  ROLE_KEYS.map((key) => [key, readFileSync(join(DIR, ROLE_PROMPT_FILES[key]), "utf8")])
) as Record<RoleKey, string>;
writeFileSync(OUT, renderRolePromptData(sources));
console.log(`wrote ${OUT} (${ROLE_KEYS.length} roles)`);
