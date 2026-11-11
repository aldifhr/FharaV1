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

/**
 * What a role may do, enforced by the worker executor (plan 040), not only
 * by its prompt.
 *
 * - `write`: `true` = stage file changes anywhere in its subtask scope;
 *   an array = only paths matching one of these globs (`*` within a path
 *   segment, a trailing `/**` for a whole directory); `false` = never.
 * - `shell`: `"allowlist"` = any command on the worker's exact-argv
 *   allowlist; `"verify"` = only the verification commands on it (tests,
 *   typecheck, build, read-only git); `"none"` = no commands.
 * - `web`: the read-only Agent Reach web tool (`web_reach`).
 * - `push`: always false. Push / PR stay user-approved runtime steps.
 * - `options`: the `show_options` tool (lib/optionsReview.ts): ask the
 *   user to pick between options (html mockups, images, markdown
 *   trade-offs). Read-only for the repository; the subtask waits for the
 *   answer. On for Designer; turn it on per role here when its prompt and
 *   planner rules are ready (CTO, Backend, Researcher, DevOps next).
 *
 * Destructive or push-like commands always ask for approval for every role
 * (lib/commandRules.ts); nothing here relaxes that.
 */
export interface RolePermissions {
  read: true;
  write: boolean | readonly string[];
  shell: "none" | "verify" | "allowlist";
  web: boolean;
  push: false;
  options: boolean;
}

/** D7: the only paths DevOps may write (CI, containers, infra). */
export const DEVOPS_WRITE_PATHS: readonly string[] = [
  ".github/**",
  "Dockerfile*",
  "**/Dockerfile*",
  "docker-compose*",
  "**/docker-compose*",
  "infra/**",
];

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
  /** Enforced permissions (plan 040). `defaultTools` mirrors them. */
  permissions: RolePermissions;
  /** Fixed-team scheduling defaults. */
  priority: number;
  maxConcurrency: number;
  /** One-line responsibilities hint (mirrors the worker's systemPromptHint). */
  hint: string;
  /**
   * Stack-neutral area of expertise for conversation (personal chat). The
   * `hint` and seed prompt name this product's own stack (e.g. Convex) for
   * task execution; in chat the role talks about any stack the user uses.
   */
  chatSummary: string;
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
    workerDescription: "Technical architecture, technical decisions, risk evaluation, project coordination.",
    // Plan 040 (D3): security-audit moved to the Reviewer. project-coordination
    // takes over conversation replies from Support's retired "general" (D2).
    capabilities: ["architecture", "project-coordination"],
    registryCapabilities: ["architecture", "project-coordination"],
    defaultTools: ["read_file"],
    permissions: { read: true, write: false, shell: "none", web: false, push: false, options: false },
    priority: 9,
    maxConcurrency: 2,
    hint: "Decide technical approach, architecture, and risk with brief rationale. Read-only planning and review — no code writing, no over-engineering. Report to the owner in 2-3 plain-language sentences, no bullets, headers, or terminal output.",
    chatSummary: "Technical direction, architecture, technology choices, data modelling and risk trade-offs.",
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
    defaultTools: ["read_file"],
    permissions: { read: true, write: false, shell: "none", web: false, push: false, options: true },
    priority: 8,
    maxConcurrency: 1,
    hint: "Produce implementable design specs (layout, components, tokens, states, responsive) with accessibility considered, inside the app's existing design system. When more than one direction is plausible, mock 2-4 static HTML variants and ask the user with show_options. Design only — no code edits.",
    chatSummary: "UI/UX design, layout, design systems, components, accessibility and user flows.",
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
    permissions: { read: true, write: true, shell: "allowlist", web: false, push: false, options: false },
    priority: 8,
    maxConcurrency: 2,
    hint: "Implement exactly the assigned frontend subtask, reusing UI primitives; strict TypeScript, accessible markup, English copy. Report changed files and limits. Never mark the global task complete.",
    chatSummary: "Frontend development: UI frameworks, components, state, styling, responsive layout and accessibility.",
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
    permissions: { read: true, write: true, shell: "allowlist", web: false, push: false, options: false },
    priority: 8,
    maxConcurrency: 2,
    hint: "Implement exactly the assigned backend subtask (Convex functions, schema, validation), keeping security invariants and additive schema changes. Report changed files and limits. Never mark the global task complete.",
    chatSummary: "Backend development: APIs, business logic, databases, auth, data validation and integrations.",
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
    permissions: { read: true, write: false, shell: "verify", web: false, push: false, options: false },
    priority: 7,
    maxConcurrency: 2,
    hint: "Verify with the narrowest relevant checks and report evidence. Distinguish executed tests from proposed ones — never fabricate results. Defects go back to the implementer with a concrete repro.",
    chatSummary: "Testing and quality: test strategy, unit/integration/end-to-end tests, bug hunting and verification.",
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
    // Plan 040 (D2): no "general" catch-all; Support is not the default owner.
    capabilities: ["documentation-support"],
    registryCapabilities: ["documentation-support"],
    defaultTools: ["read_file"],
    permissions: { read: true, write: false, shell: "none", web: false, push: false, options: false },
    priority: 6,
    maxConcurrency: 1,
    hint: "Answer the actual question first, then the how. Never invent features or behavior — check the code or say it is unknown. Docs and guidance only, no code changes.",
    chatSummary: "Documentation, troubleshooting, how-to guidance and explaining how things work.",
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
    defaultTools: ["read_file", "write_file", "run_command"],
    permissions: { read: true, write: DEVOPS_WRITE_PATHS, shell: "allowlist", web: false, push: false, options: false },
    priority: 7,
    maxConcurrency: 2,
    hint: "Changes are policy-gated. Prefer minimal, reversible infra changes; report exact commands run and their output.",
    chatSummary: "DevOps: CI/CD, containers, deployment, infrastructure, monitoring and reliability.",
    defaultPromptKey: "devops",
    color: "bg-cyan-500/10 text-cyan-700 ring-cyan-500/20 dark:bg-cyan-500/20 dark:text-cyan-300",
  },
  reviewer: {
    key: "reviewer",
    label: "Reviewer",
    title: "Reviewer",
    category: "Quality",
    description: "Independent code review and security audit. Evaluates implementation quality.",
    registryDescription: "Independent code review and security audit.",
    // Plan 040 (D3): security audits run on the Reviewer (chat already did).
    capabilities: ["code-review", "security-audit"],
    registryCapabilities: ["code-review", "security-audit"],
    defaultTools: ["read_file"],
    permissions: { read: true, write: false, shell: "none", web: false, push: false, options: false },
    priority: 7,
    maxConcurrency: 2,
    hint: "Review diffs independently with file references. Never silently modify code or approve your own work.",
    chatSummary: "Code review and security: code quality, defects, risks and secure practices.",
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
    permissions: { read: true, write: false, shell: "none", web: true, push: false, options: false },
    priority: 6,
    maxConcurrency: 2,
    hint: "Prefer official docs; distinguish facts from assumptions with sources. Read-only research — no file modifications.",
    chatSummary: "Technical research: comparing tools and approaches, reading docs, separating facts from assumptions.",
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
  cto: ["code-review", "security-audit"],
  support: ["general"],
};

/**
 * Default tools added to EXISTING fixed-team rows by the sync (plan 040).
 * Only these are unioned in, never the whole default list, so a tool a
 * user removed from a row by hand stays removed.
 */
export const ADDED_DEFAULT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  researcher: ["web_reach"],
  devops: ["write_file"],
};

/**
 * Default tools a fixed role used to ship with and must no longer carry
 * (plan 040: Designer and Support are read-only). The executor enforces the
 * role's `permissions` either way; this keeps the stored rows honest.
 */
export const REVOKED_DEFAULT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  designer: ["write_file"],
  support: ["write_file"],
};

/** Permissions for a fixed role key (null for an unknown/custom role). */
export function rolePermissionsFor(role: string | undefined): RolePermissions | null {
  const raw = normalizeRoleKey(role);
  const key: string = LEGACY_ROLE_SUCCESSORS[raw] ?? raw;
  return isRoleKey(key) ? ROLES[key].permissions : null;
}

/**
 * Permissions for a custom role (not one of the nine): derived from the
 * row's declared tools, which is what such an agent could do before
 * plan 040. Never grants push.
 */
export function permissionsFromTools(supportedTools: readonly string[] | undefined): RolePermissions {
  const tools = new Set(supportedTools ?? []);
  return {
    read: true,
    write: tools.has("write_file"),
    shell: tools.has("run_command") ? "allowlist" : "none",
    web: tools.has("web_reach"),
    push: false,
    options: tools.has("show_options"),
  };
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more directories; a trailing "**" anything.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether `permissions` let the role write `filePath` (repo-relative). */
export function canWritePath(permissions: RolePermissions, filePath: string): boolean {
  if (permissions.write === true) return true;
  if (permissions.write === false) return false;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").includes("..")) return false;
  return permissions.write.some((glob) => globToRegExp(glob).test(normalized));
}

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

/** Stack-neutral chat area for a role (null for an unknown/custom role). */
export function roleChatSummary(role: string | undefined): string | null {
  const raw = normalizeRoleKey(role);
  const key: string = LEGACY_ROLE_SUCCESSORS[raw] ?? raw;
  if (isRoleKey(key)) return ROLES[key].chatSummary;
  const byLabel = ROLE_KEYS.find((k) => ROLES[k].label.toLowerCase() === raw);
  return byLabel ? ROLES[byLabel].chatSummary : null;
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
