/**
 * Plan 040: enforced role permissions in the worker.
 *
 * The permission table lives in the shared role registry
 * (apps/api/convex/lib/roles.ts `ROLES[k].permissions`). This module maps a
 * stored agent (free-text role, declared tools) onto it, so the executor
 * refuses a write, a command or a web call the role may not make, whatever
 * the row's `supportedTools` or prompt say.
 *
 * A custom role (not one of the nine, no alias) keeps what its declared
 * tools allowed before plan 040 (`permissionsFromTools`).
 */
import {
  canWritePath,
  permissionsFromTools,
  ROLES,
  ROLE_KEYS,
  type RoleKey,
  type RolePermissions,
} from "@/api/convex/lib/roles";

type AgentRole = RoleKey;


export type { RolePermissions } from "@/api/convex/lib/roles";
export { canWritePath } from "@/api/convex/lib/roles";

/** Free-text role names (legacy rows, LLM output) that are not a key or title. */
const ROLE_ALIASES: Readonly<Record<string, AgentRole>> = {
  orchestrator: "cto",
  planner: "cto",
  architect: "cto",
  "ui-ux": "designer",
  ux: "designer",
  "ui/ux": "designer",
  "ui/ux designer": "designer",
  "frontend-developer": "frontend",
  developer: "frontend",
  "backend-developer": "backend",
  tester: "qa",
  documentation: "support",
  "technical-writer": "support",
  writer: "support",
  "dev ops": "devops",
  "code-review": "reviewer",
  "code review": "reviewer",
  research: "researcher",
  "product-analyst": "researcher",
  product: "researcher",
  analyst: "researcher",
  "product analyst": "researcher",
  security: "backend",
  "security auditor": "backend",
  "security engineer": "backend",
  database: "backend",
  "database engineer": "backend",
  db: "backend",
};

const ROLE_BY_NAME: ReadonlyMap<string, AgentRole> = new Map<string, AgentRole>([
  ...ROLE_KEYS.flatMap((key): Array<[string, AgentRole]> => [
    [key, key],
    [ROLES[key].title.toLowerCase(), key],
  ]),
  ...Object.entries(ROLE_ALIASES),
]);

/** Free-text role → fixed role (key, title or alias), or null when unknown. */
export function resolveRoleKey(role: string): AgentRole | null {
  const raw = role.trim().toLowerCase();
  return ROLE_BY_NAME.get(raw) ?? ROLE_BY_NAME.get(raw.replace(/[\s_\/]+/g, "-")) ?? null;
}

export function permissionsForAgent(agent: { role?: string; supportedTools?: readonly string[] }): RolePermissions {
  const key = resolveRoleKey(agent.role ?? "");
  return key ? ROLES[key].permissions : permissionsFromTools(agent.supportedTools);
}

/** Whether the role may stage any file change at all. */
export function canWriteAny(permissions: RolePermissions): boolean {
  return permissions.write === true || (Array.isArray(permissions.write) && permissions.write.length > 0);
}

/**
 * Commands a `"verify"` shell role (QA) may run: tests, typecheck, build
 * and read-only git. Anything that changes the workspace (git pull/fetch)
 * is refused. Always checked after the exact-argv allowlist.
 */
const VERIFY_COMMANDS: ReadonlyArray<readonly string[]> = [
  ["npm", "run", "test"],
  ["npm", "run", "typecheck"],
  ["npm", "run", "build"],
  ["npx", "tsc", "--noEmit"],
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
  ["git", "branch", "--show-current"],
  ["node", "--version"],
];

export function isVerifyCommand(command: string, args: readonly string[]): boolean {
  const argv = [command, ...args];
  return VERIFY_COMMANDS.some((prefix) => prefix.every((part, index) => argv[index] === part));
}

/** Null when the role may run this (already allowlisted) command, else why not. */
export function shellDenial(roleLabel: string, permissions: RolePermissions, command: string, args: readonly string[]): string | null {
  if (permissions.shell === "none") return `the ${roleLabel} role may not run commands`;
  if (permissions.shell === "verify" && !isVerifyCommand(command, args)) {
    return `the ${roleLabel} role may only run tests, typecheck, build and read-only git`;
  }
  return null;
}

/** Null when the role may write `filePath`, else why not. */
export function writeDenial(roleLabel: string, permissions: RolePermissions, filePath: string): string | null {
  if (canWritePath(permissions, filePath)) return null;
  if (permissions.write === false) return `the ${roleLabel} role is read-only`;
  return `the ${roleLabel} role may only write ${(permissions.write as readonly string[]).join(", ")}`;
}
