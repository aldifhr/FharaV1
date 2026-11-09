/**
 * Organization role registry (Plan 008) — exactly the roles in the
 * Organization spec §2–§3:
 *  - cto (Leadership, mandatory Orchestrator)
 *  - frontend, backend, devops (Engineering)
 *  - qa, reviewer (Quality)
 *  - researcher (Research)
 *  - designer (Product)
 *  - support (Operations)
 *
 * The role list, titles, capabilities, tools and hints come from the shared
 * registry apps/api/convex/lib/roles.ts (also read by the Convex seed and the
 * web app); this module only adds worker-side lookup and selection.
 *
 * Roles are configuration (capabilities + tool defaults) executed by the
 * Agent Runtime on demand — never permanent workers. `architecture` etc.
 * are capabilities, not extra roles.
 * Deleted: lead (duplicates orchestrator/CTO planning), growth (SEO-only,
 * never suggested for dev tasks), product-analyst (same research capability
 * as researcher, router tie-break always picked it first), ui-ux (duplicate
 * of designer — normalizeRole maps ui-ux to designer).
 */
import { ROLES, ROLE_KEYS, type RoleKey } from "@/api/convex/lib/roles";
import { capabilitiesOf } from "./capabilities";
import type { AgentDefinition } from "@/types";

/** The nine fixed-team roles — the shared `RoleKey` (apps/api/convex/lib/roles.ts). */
export type AgentRole = RoleKey;

export interface RoleDefinition {
  role: AgentRole;
  displayName: string;
  category: string;
  description: string;
  defaultCapabilities: string[];
  defaultTools: string[];
  systemPromptHint: string;
}

/**
 * Worker view of the shared role registry. Derived, never hand-edited: change
 * a role in apps/api/convex/lib/roles.ts and the web, Convex seed and worker
 * all follow.
 */
export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = Object.fromEntries(
  ROLE_KEYS.map((key) => {
    const role = ROLES[key];
    const definition: RoleDefinition = {
      role: key,
      displayName: role.title,
      category: role.category,
      description: role.workerDescription ?? role.description,
      defaultCapabilities: [...role.capabilities],
      defaultTools: [...role.defaultTools],
      systemPromptHint: role.hint,
    };
    return [key, definition];
  }),
) as Record<AgentRole, RoleDefinition>;

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

/** Free-text role → fixed role; unknown and empty fall back to frontend. */
export function normalizeRole(role: string): AgentRole {
  return ROLE_BY_NAME.get(role.trim().toLowerCase()) ?? "frontend";
}

export function roleForAgent(agent: AgentDefinition): AgentRole {
  return normalizeRole(agent.role);
}

export function defaultToolsForRole(role: AgentRole): string[] {
  return ROLE_DEFINITIONS[role]?.defaultTools ?? ["read_file"];
}

export function canSelect(role: AgentRole, required: string[]): boolean {
  const caps = new Set(ROLE_DEFINITIONS[role]?.defaultCapabilities ?? []);
  return required.every((c) => caps.has(c.trim().toLowerCase()));
}

export function selectAgentsForTask(input: {
  agents: AgentDefinition[];
  requiredCapabilities: string[];
  taskComplexity?: "simple" | "complex";
}): AgentDefinition[] {
  const enabled = input.agents.filter((a) => a.isEnabled !== false);
  if (enabled.length === 0) return [];
  const required = input.requiredCapabilities.map((c) => c.trim().toLowerCase());
  if (required.length <= 1 && input.taskComplexity !== "complex") {
    const first = enabled.find((a) =>
      required.every((c) => capabilitiesOf(a).includes(c))
    );
    return first ? [first] : [];
  }
  const picked: AgentDefinition[] = [];
  for (const cap of required.slice(0, 5)) {
    const agent = enabled.find(
      (a) => capabilitiesOf(a).includes(cap) && !picked.includes(a)
    );
    if (agent) picked.push(agent);
  }
  return picked;
}
