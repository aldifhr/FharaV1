/**
 * Agent templates: pure helpers + the built-in catalogue. No Convex
 * functions live here, so the web app (New agent modal, /library) and the
 * backend (agentTemplates.ts) read the same definitions.
 *
 * A template is a starting point for a new agent: role, instructions
 * (system prompt), library skills, an optional LLM preference, runtime and
 * avatar. Built-in templates live in code (ids `builtin:<key>`); custom ones
 * are rows in the `agentTemplates` table.
 */
import { ROLES, isRoleKey, roleLabel, type RoleKey } from "./roles";
import { AGENT_SEED_PROMPTS } from "./prompts/agents";

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_DESCRIPTION_MAX = 280;
export const TEMPLATE_PROMPT_MAX = 20_000;
export const TEMPLATE_TAG_MAX = 32;
export const TEMPLATE_TAGS_MAX = 12;
export const BUILTIN_TEMPLATE_PREFIX = "builtin:";

/** DiceBear seed for the template's avatar (same shape agents store). */
export type TemplateAvatar = {
  dicebear: "lorelei";
  seed: string;
};

export type BuiltInTemplate = {
  key: string;
  name: string;
  role: RoleKey;
  description: string;
  systemPrompt: string;
  /** Library skill names, matched case-insensitively when they exist. */
  suggestedSkills: string[];
  tags: string[];
  runtime?: "api" | "opencode";
  avatarParams: TemplateAvatar;
};

/** Role seed persona first, then the template's specialisation. */
function promptFor(role: RoleKey, focus: string[]): string {
  return [AGENT_SEED_PROMPTS[ROLES[role].defaultPromptKey], "", ...focus].join("\n");
}

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    key: "react-frontend",
    name: "React Frontend",
    role: "frontend",
    description: "React/Next.js UI work with strict TypeScript, accessible markup and theme tokens.",
    tags: ["frontend", "react"],
    suggestedSkills: ["Accessible UI checklist", "Conventional commits"],
    avatarParams: { dicebear: "lorelei", seed: "react-frontend" },
    systemPrompt: promptFor("frontend", [
      "Focus: React and Next.js (App Router).",
      "- Prefer server components; add \"use client\" only where state, effects or browser APIs are needed.",
      "- Reuse existing components and hooks before adding new ones; match the file's existing patterns.",
      "- Style with the project's theme tokens only — never hard-coded colours — and check dark and light mode.",
      "- Every async UI has loading, empty and error states; never block the UI on a missing query.",
      "- Keep components small and typed; no `any` in new props.",
      "- Before you finish, run the narrowest typecheck that covers your change and list the files you changed.",
    ]),
  },
  {
    key: "api-backend",
    name: "API Backend",
    role: "backend",
    description: "Server functions, schema and validation with additive changes and access checks.",
    tags: ["backend", "api"],
    suggestedSkills: ["Write tests first", "Conventional commits"],
    avatarParams: { dicebear: "lorelei", seed: "api-backend" },
    systemPrompt: promptFor("backend", [
      "Focus: API endpoints, server functions and data model.",
      "- Validate every input at the boundary (types, lengths, enums) and return clear error messages.",
      "- Run the module's existing access check before any read of private data or any write.",
      "- Schema changes are additive: new fields optional, new tables with the indexes their queries need.",
      "- Never return secrets or credential fields to clients; strip them in the projection.",
      "- Add or update a test for each behaviour change, using the module's existing test setup.",
    ]),
  },
  {
    key: "qa-playwright",
    name: "QA Playwright",
    role: "qa",
    description: "End-to-end verification with Playwright, with evidence for every pass or fail.",
    tags: ["qa", "e2e", "playwright"],
    suggestedSkills: ["Write tests first"],
    avatarParams: { dicebear: "lorelei", seed: "qa-playwright" },
    systemPrompt: promptFor("qa", [
      "Focus: end-to-end checks with Playwright.",
      "- Use role- and label-based locators (getByRole, getByLabel); avoid CSS selectors and fixed sleeps.",
      "- Cover the happy path, one edge case and one error path for each change under test.",
      "- Each spec is independent: its own setup, no ordering assumptions between tests.",
      "- Report each check as executed pass/fail with the command and the relevant output; label anything not run as proposed.",
      "- For a failure, give exact repro steps, expected vs actual, and the file to look at.",
    ]),
  },
  {
    key: "security-reviewer",
    name: "Security Reviewer",
    role: "reviewer",
    description: "Reviews diffs for auth, injection, secret handling and unsafe defaults.",
    tags: ["security", "review"],
    suggestedSkills: [],
    avatarParams: { dicebear: "lorelei", seed: "security-reviewer" },
    systemPrompt: promptFor("reviewer", [
      "Focus: security review.",
      "- Check every changed entry point for authentication and authorization (who can call it, on whose data).",
      "- Look for injection (SQL, shell, path traversal, prompt injection into tools) and unsafe deserialization.",
      "- Flag secrets in code, logs or client payloads, and credentials crossing to the browser.",
      "- Check input validation, size limits and rate of expensive operations.",
      "- Rate each finding high/medium/low with file:line, the concrete exploit, and the minimal fix.",
      "- Say plainly when you found nothing; do not pad the review.",
    ]),
  },
  {
    key: "devops-ci",
    name: "DevOps CI",
    role: "devops",
    description: "CI pipelines, build caching and deploy checks with small, reversible changes.",
    tags: ["devops", "ci"],
    suggestedSkills: ["Conventional commits"],
    avatarParams: { dicebear: "lorelei", seed: "devops-ci" },
    systemPrompt: promptFor("devops", [
      "Focus: continuous integration and delivery.",
      "- Keep pipelines fast: cache dependencies, run the cheapest checks first, fail early.",
      "- Pin action and image versions; never echo secrets, read them only from the CI secret store.",
      "- Each change is small and reversible; say how to roll it back.",
      "- Run the pipeline step locally (or its closest equivalent) before proposing it, and report the exact commands and output.",
    ]),
  },
  {
    key: "ux-researcher",
    name: "UX Researcher",
    role: "researcher",
    description: "Usability and UX research: heuristics, user flows and sourced recommendations.",
    tags: ["research", "ux"],
    suggestedSkills: ["Accessible UI checklist"],
    avatarParams: { dicebear: "lorelei", seed: "ux-researcher" },
    systemPrompt: promptFor("researcher", [
      "Focus: user experience research.",
      "- Walk the actual user flow step by step and note friction, dead ends and unclear copy.",
      "- Evaluate against established heuristics (visibility of status, error prevention, consistency, accessibility).",
      "- Separate observations from recommendations; cite sources for any claimed best practice.",
      "- Prioritise recommendations by user impact and effort, and keep them implementable by the Designer and Frontend.",
    ]),
  },
];

export function builtInTemplateId(key: string): string {
  return `${BUILTIN_TEMPLATE_PREFIX}${key}`;
}

export function findBuiltInTemplate(id: string): BuiltInTemplate | null {
  if (!id.startsWith(BUILTIN_TEMPLATE_PREFIX)) return null;
  const key = id.slice(BUILTIN_TEMPLATE_PREFIX.length);
  return BUILT_IN_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * Match suggested skill names to library skills, case-insensitively, keeping
 * the suggestion order. Unknown names are skipped.
 */
export function matchSkillsByName<T extends { _id: string; name: string }>(
  names: readonly string[],
  library: readonly T[]
): string[] {
  const byName = new Map(library.map((s) => [s.name.trim().toLowerCase(), s._id]));
  const out: string[] = [];
  for (const name of names) {
    const id = byName.get(name.trim().toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Name for a new agent: the role label, plus a number when taken — the same
 * rule as the New agent modal ("Frontend", then "Frontend 2"), skipping a
 * number that is already in use.
 */
export function nextAgentName(
  role: string,
  agents: ReadonlyArray<{ name: string; role: string }>
): string {
  const base = roleLabel(role);
  const sameRole = agents.filter((a) => a.role === role).length;
  const taken = new Set(agents.map((a) => a.name.trim().toLowerCase()));
  if (sameRole === 0 && !taken.has(base.toLowerCase())) return base;
  let n = Math.max(2, sameRole + 1);
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

export type TemplateInput = {
  name?: string;
  role?: string;
  description?: string;
  systemPrompt?: string;
  tags?: string[];
};

/** Normalize + validate user input for create/update. Throws on bad input. */
export function validateTemplateInput(input: TemplateInput): TemplateInput {
  const out: TemplateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Template name is required");
    if (name.length > TEMPLATE_NAME_MAX) throw new Error(`Template name must be ${TEMPLATE_NAME_MAX} characters or fewer`);
    out.name = name;
  }
  if (input.role !== undefined) {
    const role = input.role.trim().toLowerCase();
    if (!role) throw new Error("Template role is required");
    if (!isRoleKey(role)) throw new Error(`Unknown role "${input.role}"`);
    out.role = role;
  }
  if (input.description !== undefined) {
    const description = input.description.trim();
    if (description.length > TEMPLATE_DESCRIPTION_MAX) {
      throw new Error(`Description must be ${TEMPLATE_DESCRIPTION_MAX} characters or fewer`);
    }
    out.description = description;
  }
  if (input.systemPrompt !== undefined) {
    const systemPrompt = input.systemPrompt.trim();
    if (systemPrompt.length > TEMPLATE_PROMPT_MAX) {
      throw new Error(`Instructions must be ${TEMPLATE_PROMPT_MAX} characters or fewer`);
    }
    out.systemPrompt = systemPrompt;
  }
  if (input.tags !== undefined) {
    const tags = Array.from(new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)));
    if (tags.length > TEMPLATE_TAGS_MAX) throw new Error(`At most ${TEMPLATE_TAGS_MAX} tags`);
    if (tags.some((t) => t.length > TEMPLATE_TAG_MAX)) throw new Error(`Tags must be ${TEMPLATE_TAG_MAX} characters or fewer`);
    out.tags = tags;
  }
  return out;
}
