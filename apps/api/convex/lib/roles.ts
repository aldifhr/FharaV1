/**
 * Single source of truth for the team roles.
 *
 * Pure TypeScript (no Convex, Node or DOM APIs) so it can be imported by the
 * Convex backend (fixed-team seed, role registry), the web app (role menus,
 * labels, @mention chip colours — via the `@/api/convex/lib/roles` alias)
 * and the worker.
 *
 * The fixed team is the user-approved roster: CTO, Frontend, Backend, QA.
 * Designer is a live role available for manual agent creation but is not
 * seeded into the fixed team.
 */

/** Current roles, in display order. Every role menu reads this list. */
export const ROLE_KEYS = [
  "cto",
  "frontend",
  "backend",
  "qa",
  "designer",
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
 *   answer. Off for the fixed-team roles; Designer turns it on for mockup
 *   choices. Turn it on per role here when its prompt and planner rules are ready.
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

/**
 * Canonical successor for legacy role aliases. Stored agents and chat
 * messages may still carry old role names; this maps them to the current
 * role so the rest of the system never needs to know about the old roles.
 */
export const LEGACY_ROLE_SUCCESSORS: Readonly<Record<string, RoleKey>> = {
  "ui-ux": "designer",
  ux: "designer",
  support: "backend",
  documentation: "backend",
  "technical-writer": "backend",
  writer: "backend",
  devops: "backend",
  "dev ops": "backend",
  "devops engineer": "backend",
  reviewer: "qa",
  "code-review": "qa",
  "code review": "qa",
  researcher: "cto",
  research: "cto",
  "product-analyst": "cto",
  product: "cto",
  analyst: "cto",
  "product analyst": "cto",
  lead: "cto",
  growth: "cto",
  orchestrator: "cto",
  planner: "cto",
  architect: "cto",
};

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
    workerDescription: "Technical architecture decisions, only when the planner flags one (new dependency, schema, auth boundary, API contract, infra split).",
    // security-audit and project-coordination are not CTO capabilities:
    // security-audit lives in Backend, project-coordination is system code.
    capabilities: ["architecture", "research"],
    registryCapabilities: ["architecture", "research"],
    defaultTools: ["read_file"],
    permissions: { read: true, write: false, shell: "none", web: false, push: false, options: false },
    priority: 9,
    maxConcurrency: 2,
    hint: "Decide technical approach, architecture, and risk with brief rationale. Read-only planning and review — no code writing, no over-engineering. Report to the owner in 2-3 plain-language sentences, no bullets, headers, or terminal output.",
    chatSummary: "Technical direction, architecture, technology choices, data modelling and risk trade-offs.",
    defaultPromptKey: "cto",
    color: "bg-blue-500/10 text-blue-700 ring-blue-500/20 dark:bg-blue-500/20 dark:text-blue-300",
  },

  frontend: {
    key: "frontend",
    label: "Frontend",
    title: "Frontend Developer",
    category: "Engineering",
    description: "Frontend implementation, React, Next.js, responsive UI, design fidelity.",
    registryDescription: "Frontend implementation, React, Next.js, responsive UI.",
    workerDescription: "React and Next.js development. UI implementation.",
    capabilities: ["frontend-development", "ui-ux-design"],
    registryCapabilities: ["frontend-development", "ui-ux-design"],
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
    capabilities: ["backend-development", "code-review", "security-audit", "documentation-support"],
    registryCapabilities: ["backend-development", "code-review", "security-audit", "documentation-support"],
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
    capabilities: ["browser-testing", "code-review"],
    registryCapabilities: ["browser-testing", "code-review"],
    defaultTools: ["read_file", "run_command"],
    permissions: { read: true, write: false, shell: "verify", web: false, push: false, options: false },
    priority: 7,
    maxConcurrency: 2,
    hint: "Verify with the narrowest relevant checks and report evidence. Distinguish executed tests from proposed ones — never fabricate results. Defects go back to the implementer with a concrete repro.",
    chatSummary: "Testing and quality: test strategy, unit/integration/end-to-end tests, bug hunting and verification.",
    defaultPromptKey: "qa",
    color: "bg-orange-500/10 text-orange-700 ring-orange-500/20 dark:bg-orange-500/20 dark:text-orange-300",
  },

  designer: {
    key: "designer",
    label: "Designer",
    title: "UI/UX Designer",
    category: "Design",
    description: "UI/UX design specifications, layout, interaction states, accessibility, visual mockups.",
    registryDescription: "UI/UX design specifications, layout, interaction states, accessibility.",
    workerDescription: "Design specifications and visual mockups; hands implementation to Frontend. Read-only.",
    capabilities: ["ui-ux-design"],
    registryCapabilities: ["ui-ux-design"],
    defaultTools: ["read_file"],
    permissions: { read: true, write: false, shell: "none", web: false, push: false, options: true },
    priority: 6,
    maxConcurrency: 2,
    hint: "Produce implementation-ready design specs: layout, component hierarchy, tokens, states, responsive and accessibility notes. When more than one direction is plausible, mock 2-4 static HTML variants and ask the user to pick with show_options. Never edit project files or run commands; hand implementation to Frontend. Report only your own subtask.",
    chatSummary: "UI/UX design: layout, information hierarchy, interaction patterns, design systems, accessibility and visual mockups.",
    defaultPromptKey: "designer",
    color: "bg-fuchsia-500/10 text-fuchsia-700 ring-fuchsia-500/20 dark:bg-fuchsia-500/20 dark:text-fuchsia-300",
  },



};

/**
 * Order the fixed-team sync seeds agents in (and appends them to a
 * project's `agentIds`). Kept as it was so existing rosters keep their order.
 * Designer is deliberately NOT seeded: it is a role a user adds manually
 * (fixedTeamSync.test).
 */
export const FIXED_TEAM_SEED_ORDER: readonly RoleKey[] = ["cto", "frontend", "backend", "qa"];

/** The fixed team as the sidebar and Team list show it, top to bottom. */
export const FIXED_TEAM_DISPLAY_ORDER: readonly RoleKey[] = ["cto", "frontend", "backend", "qa"];

/** "product-analyst" → "Product Analyst": the label for a key with no role row. */
function titleCaseRoleKey(key: string): string {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Capabilities a fixed role used to ship with and must no longer carry.
 * The sync otherwise only ever UNIONS defaults into existing rows, so a CTO
 * row seeded with `code-review` kept routing reviews to the CTO forever.
 * Only these are removed; capabilities a user added by hand are kept.
 */
export const REVOKED_DEFAULT_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  cto: ["code-review", "security-audit", "project-coordination"],
};

/** Permissions for a fixed role key (null for an unknown/custom role). */
export function rolePermissionsFor(role: string | undefined): RolePermissions | null {
  const raw = normalizeRoleKey(role);
  const key: string = LEGACY_ROLE_SUCCESSORS[raw] ?? raw;
  return isRoleKey(key) ? ROLES[key].permissions : null;
}

/**
 * Permissions for a custom role (not one of the four): derived from the
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

/**
 * Whether `permissions` let the role write `filePath` (repo-relative).
 *
 * The malformed-path check runs before the role's own grant: `write: true`
 * means "anywhere in the worktree", not "anywhere". A path that climbs above
 * the workspace root is refused for every role, writer included.
 */
export function canWritePath(permissions: RolePermissions, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").includes("..")) return false;
  if (permissions.write === true) return true;
  if (permissions.write === false) return false;
  return permissions.write.some((glob) => globToRegExp(glob).test(normalized));
}

/**
 * Whether an agent of this role writes code in tasks (Frontend or Backend;
 * a custom role with write_file). Chat write requests addressed to such an
 * agent are offered as a task routed to it.
 */
export function isCodeWritingRole(role: string | undefined, supportedTools?: readonly string[]): boolean {
  const perms = rolePermissionsFor(role) ?? (supportedTools ? permissionsFromTools(supportedTools) : null);
  return Boolean(perms && perms.write !== false);
}

/** "Product Analyst", "product_analyst", "UI/UX" → "product-analyst", "ui-ux". */
export function normalizeRoleKey(role: string | undefined): string {
  return (role ?? "").trim().toLowerCase().replace(/[\s_\/]+/g, "-");
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
  return titleCaseRoleKey(key);
}
