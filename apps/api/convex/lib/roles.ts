/**
 * Single source of truth for the team roles.
 *
 * Pure TypeScript (no Convex, Node or DOM APIs) so it can be imported by the
 * Convex backend (fixed-team seed, role registry), the web app (role menus,
 * labels, @mention chip colours — via the `@/api/convex/lib/roles` alias)
 * and the worker.
 *
 * The fixed team is nine roles. Retired roles (Lead, Growth, Product
 * Analyst, UI/UX) are no longer seeded; agents still stored with one are
 * disabled by the fixed-team sync and displayed as their successor.
 */

/** Current roles, in display order. Every role menu reads this list. */
export const ROLE_KEYS = [
  "cto",
  "designer",
  "frontend",
  "backend",
  "qa",
  "support",
  "devops",
  "reviewer",
  "researcher",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleDefinition {
  key: RoleKey;
  /** Short label shown in the UI and used as the seeded agent's name. */
  label: string;
  /** Long title stored on the role registry row (`roleDefinitions.name`). */
  title: string;
  category: string;
  /** Description seeded onto the fixed-team agent. */
  description: string;
  /** Description stored on the role registry row. */
  registryDescription: string;
  /**
   * Description the worker uses in planner/router prompts, when it differs
   * from `description` (falls back to `description`).
   */
  workerDescription?: string;
  /** Default capabilities seeded onto the fixed-team agent. */
  capabilities: readonly string[];
  /** Capabilities stored on the role registry row. */
  registryCapabilities: readonly string[];
  /** Default tools (agent `supportedTools` and registry `defaultTools`). */
  defaultTools: readonly string[];
  /** Fixed-team scheduling defaults. */
  priority: number;
  maxConcurrency: number;
  /** One-line responsibilities hint (mirrors the worker's systemPromptHint). */
  hint: string;
  /** Key into `AGENT_SEED_PROMPTS` (lib/prompts/agents.ts). */
  defaultPromptKey: RoleKey;
  /** @mention chip classes (full strings so Tailwind picks them up). */
  color: string;
}

export const ROLES: Record<RoleKey, RoleDefinition> = {
  cto: {
    key: "cto",
    label: "CTO",
    title: "CTO",
    category: "Leadership",
    description: "Technical architecture, technical decisions, risk evaluation.",
    registryDescription: "Technical architecture, technical decisions, risk evaluation.",
    workerDescription: "Technical architecture, technical decisions, security audit, risk evaluation.",
    capabilities: ["architecture", "security-audit"],
    registryCapabilities: ["architecture", "security-audit"],
    defaultTools: ["read_file"],
    priority: 9,
    maxConcurrency: 2,
    hint: "Decide technical approach, architecture, and risk with brief rationale. Read-only planning and review — no code writing, no over-engineering. Report to the owner in 2-3 plain-language sentences, no bullets, headers, or terminal output.",
    defaultPromptKey: "cto",
    color: "bg-blue-500/10 text-blue-700 ring-blue-500/20 dark:bg-blue-500/20 dark:text-blue-300",
  },
  designer: {
    key: "designer",
    label: "Designer",
    title: "Designer",
    category: "Product",
    description: "UI/UX, wireframes, design system, component specifications.",
    registryDescription: "UI/UX, wireframes, design system, component specifications.",
    capabilities: ["ui-ux-design"],
    registryCapabilities: ["ui-ux-design"],
    defaultTools: ["read_file", "write_file"],
    priority: 8,
    maxConcurrency: 1,
    hint: "Produce implementable design specs (layout, components, tokens, states, responsive) with accessibility considered. Design only — no code edits.",
    defaultPromptKey: "designer",
    color: "bg-pink-500/10 text-pink-700 ring-pink-500/20 dark:bg-pink-500/20 dark:text-pink-300",
  },
  frontend: {
    key: "frontend",
    label: "Frontend",
    title: "Frontend Developer",
    category: "Engineering",
    description: "Frontend implementation, React, Next.js, responsive UI, design fidelity.",
    registryDescription: "Frontend implementation, React, Next.js, responsive UI.",
    workerDescription: "React and Next.js development. UI implementation.",
    capabilities: ["frontend-development"],
    registryCapabilities: ["frontend-development"],
    defaultTools: ["read_file", "write_file", "run_command"],
    priority: 8,
    maxConcurrency: 2,
    hint: "Implement exactly the assigned frontend subtask, reusing UI primitives; strict TypeScript, accessible markup, English copy. Report changed files and limits. Never mark the global task complete.",
    defaultPromptKey: "frontend",
    color: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-300",
  },
  backend: {
    key: "backend",
    label: "Backend",
    title: "Backend Developer",
    category: "Engineering",
    description: "Backend, API, database implementation, server-side business logic.",
    registryDescription: "Backend, API, database, server-side logic.",
    workerDescription: "API development and server-side business logic.",
    capabilities: ["backend-development"],
    registryCapabilities: ["backend-development"],
    defaultTools: ["read_file", "write_file", "run_command"],
    priority: 8,
    maxConcurrency: 2,
    hint: "Implement exactly the assigned backend subtask (Convex functions, schema, validation), keeping security invariants and additive schema changes. Report changed files and limits. Never mark the global task complete.",
    defaultPromptKey: "backend",
    color: "bg-amber-500/10 text-amber-800 ring-amber-500/20 dark:bg-amber-500/20 dark:text-amber-300",
  },
  qa: {
    key: "qa",
    label: "QA",
    title: "QA Engineer",
    category: "Quality",
    description: "Testing, bug detection, quality assurance, verification.",
    registryDescription: "Testing, bug detection, quality assurance, verification.",
    workerDescription: "Test planning, execution, bug detection, quality verification.",
    capabilities: ["browser-testing"],
    registryCapabilities: ["browser-testing"],
    defaultTools: ["read_file", "run_command"],
    priority: 7,
    maxConcurrency: 2,
    hint: "Verify with the narrowest relevant checks and report evidence. Distinguish executed tests from proposed ones — never fabricate results. Defects go back to the implementer with a concrete repro.",
    defaultPromptKey: "qa",
    color: "bg-orange-500/10 text-orange-700 ring-orange-500/20 dark:bg-orange-500/20 dark:text-orange-300",
  },
  support: {
    key: "support",
    label: "Support",
    title: "Support Specialist",
    category: "Operations",
    description: "Documentation, user support, operational assistance, troubleshooting.",
    registryDescription: "Documentation, user support, operational assistance, troubleshooting.",
    capabilities: ["documentation-support", "general"],
    registryCapabilities: ["documentation-support"],
    defaultTools: ["read_file", "write_file"],
    priority: 6,
    maxConcurrency: 1,
    hint: "Answer the actual question first, then the how. Never invent features or behavior — check the code or say it is unknown. Docs and guidance only, no code changes.",
    defaultPromptKey: "support",
    color: "bg-indigo-500/10 text-indigo-700 ring-indigo-500/20 dark:bg-indigo-500/20 dark:text-indigo-300",
  },
  devops: {
    key: "devops",
    label: "DevOps",
    title: "DevOps Engineer",
    category: "Engineering",
    description: "Docker, CI/CD, deployment, infrastructure.",
    registryDescription: "Docker, CI/CD, deployment, infrastructure.",
    capabilities: ["github", "shell-execution"],
    registryCapabilities: ["github", "shell-execution"],
    defaultTools: ["read_file", "run_command"],
    priority: 7,
    maxConcurrency: 2,
    hint: "Changes are policy-gated. Prefer minimal, reversible infra changes; report exact commands run and their output.",
    defaultPromptKey: "devops",
    color: "bg-cyan-500/10 text-cyan-700 ring-cyan-500/20 dark:bg-cyan-500/20 dark:text-cyan-300",
  },
  reviewer: {
    key: "reviewer",
    label: "Reviewer",
    title: "Reviewer",
    category: "Quality",
    description: "Independent code review. Evaluates implementation quality.",
    registryDescription: "Independent code review.",
    capabilities: ["code-review"],
    registryCapabilities: ["code-review"],
    defaultTools: ["read_file"],
    priority: 7,
    maxConcurrency: 2,
    hint: "Review diffs independently with file references. Never silently modify code or approve your own work.",
    defaultPromptKey: "reviewer",
    color: "bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:bg-violet-500/20 dark:text-violet-300",
  },
  researcher: {
    key: "researcher",
    label: "Researcher",
    title: "Researcher",
    category: "Research",
    description: "Technical research and information gathering.",
    registryDescription: "Technical research.",
    capabilities: ["research"],
    registryCapabilities: ["research"],
    // Plan 036: `web_reach` is the read-only Agent Reach web tool (public
    // channels only). The researcher is the role that needs it.
    defaultTools: ["read_file", "web_reach"],
    priority: 6,
    maxConcurrency: 2,
    hint: "Prefer official docs; distinguish facts from assumptions with sources. Read-only research — no file modifications.",
    defaultPromptKey: "researcher",
    color: "bg-teal-500/10 text-teal-700 ring-teal-500/20 dark:bg-teal-500/20 dark:text-teal-300",
  },
};

/**
 * Order the fixed-team sync seeds agents in (and appends them to a
 * project's `agentIds`). Kept as it was so existing rosters keep their order.
 */
export const FIXED_TEAM_SEED_ORDER: readonly RoleKey[] = [
  "cto",
  "designer",
  "frontend",
  "backend",
  "qa",
  "support",
  "reviewer",
  "researcher",
  "devops",
];

/** Roles removed from the fixed team (matched on the normalized role key). */
export const RETIRED_ROLE_KEYS = ["lead", "growth", "product-analyst", "ui-ux"] as const;

/** Retired role keys still stored on old agents, shown as their successor. */
export const LEGACY_ROLE_SUCCESSORS: Readonly<Record<string, RoleKey>> = {
  "ui-ux": "designer",
  "product-analyst": "researcher",
};

/**
 * Capabilities a fixed role used to ship with and must no longer carry.
 * The sync otherwise only ever UNIONS defaults into existing rows, so a CTO
 * row seeded with `code-review` kept routing reviews to the CTO forever.
 * Only these are removed; capabilities a user added by hand are kept.
 */
export const REVOKED_DEFAULT_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  cto: ["code-review"],
};

/** "Product Analyst", "product_analyst", "UI/UX" → "product-analyst", "ui-ux". */
export function normalizeRoleKey(role: string | undefined): string {
  return (role ?? "").trim().toLowerCase().replace(/[\s_\/]+/g, "-");
}

export function isRetiredRole(role: string | undefined): boolean {
  return (RETIRED_ROLE_KEYS as readonly string[]).includes(normalizeRoleKey(role));
}

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/** Role key for a mention like "@QA" / "@frontend", or null if unknown. */
export function roleKeyForMention(mention: string): RoleKey | null {
  const raw = mention.replace(/^@/, "").trim().toLowerCase();
  if (!raw) return null;
  if (isRoleKey(raw)) return raw;
  if (LEGACY_ROLE_SUCCESSORS[raw]) return LEGACY_ROLE_SUCCESSORS[raw];
  const byLabel = ROLE_KEYS.find((key) => ROLES[key].label.toLowerCase() === raw);
  return byLabel ?? null;
}

/** Role label for a role key, e.g. "frontend" -> "Frontend". */
export function roleLabel(role: string | null | undefined): string {
  const raw = (role ?? "").trim().toLowerCase();
  if (!raw) return "Agent";
  const key: string = LEGACY_ROLE_SUCCESSORS[raw] ?? raw;
  if (isRoleKey(key)) return ROLES[key].label;
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
