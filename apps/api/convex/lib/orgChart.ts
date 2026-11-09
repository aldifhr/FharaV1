/**
 * Org chart: the fixed roles as a tree (CTO at the top, every other fixed
 * role under it, in the role registry's display order), plus one node per
 * agent whose stored role is not a fixed role. Pure (no Convex APIs).
 *
 * A fixed role with no agent shows as a vacant node. Retired, disabled
 * agents (syncFixedTeam's retired roles) are left out; a retired agent
 * that was re-enabled by hand is kept under its successor role.
 */
import { ROLES, ROLE_KEYS, type RoleKey } from "./roles";
import { roleBucket } from "./workload";

export interface OrgAgentInput {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  retired: boolean;
  model: string;
  runtime: "api" | "opencode";
  skills: number;
  tools: string[];
  capabilities: string[];
  priority?: number | null;
  maxConcurrency?: number | null;
}

export interface OrgRegistryInput {
  key: string;
  name: string;
  enabled: boolean;
}

export interface OrgNode {
  /** Agent id, or `role:<key>` for a vacant fixed role. */
  key: string;
  parent: string | null;
  roleKey: string;
  label: string;
  /** One of the nine fixed roles. */
  fixed: boolean;
  agentId: string | null;
  enabled: boolean;
  model: string | null;
  runtime: "api" | "opencode" | null;
  skills: number;
  tools: string[];
  capabilities: string[];
  maxConcurrency: number | null;
  /** Registry row title (roleDefinitions.name) and whether the role is enabled there. */
  registryName: string | null;
  registryEnabled: boolean | null;
}

export interface OrgChart {
  nodes: OrgNode[];
  rootKey: string;
  counts: { agents: number; enabled: number; vacant: number; custom: number };
}

export function buildOrgChart(agents: OrgAgentInput[], registry: OrgRegistryInput[]): OrgChart {
  const registryByKey = new Map(registry.map((r) => [r.key, r]));
  const visible = agents.filter((a) => !(a.retired && !a.enabled));
  const byRole = new Map<string, OrgAgentInput[]>();
  for (const a of visible) {
    const bucket = roleBucket(a.role);
    const list = byRole.get(bucket.key) ?? [];
    list.push(a);
    byRole.set(bucket.key, list);
  }
  // Enabled agents first, then by name, so a role's main node is stable.
  for (const list of byRole.values()) list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));

  const nodes: OrgNode[] = [];
  const agentNode = (a: OrgAgentInput, roleKey: string, fixed: boolean, parent: string | null): OrgNode => {
    const reg = registryByKey.get(roleKey);
    return {
      key: a.id,
      parent,
      roleKey,
      label: fixed ? ROLES[roleKey as RoleKey].label : roleBucket(a.role).label,
      fixed,
      agentId: a.id,
      enabled: a.enabled,
      model: a.model,
      runtime: a.runtime,
      skills: a.skills,
      tools: a.tools,
      capabilities: a.capabilities,
      maxConcurrency: a.maxConcurrency ?? null,
      registryName: reg?.name ?? null,
      registryEnabled: reg ? reg.enabled : null,
    };
  };
  const vacantNode = (roleKey: RoleKey, parent: string | null): OrgNode => {
    const reg = registryByKey.get(roleKey);
    return {
      key: `role:${roleKey}`,
      parent,
      roleKey,
      label: ROLES[roleKey].label,
      fixed: true,
      agentId: null,
      enabled: false,
      model: null,
      runtime: null,
      skills: 0,
      tools: [...ROLES[roleKey].defaultTools],
      capabilities: [...ROLES[roleKey].capabilities],
      maxConcurrency: null,
      registryName: reg?.name ?? null,
      registryEnabled: reg ? reg.enabled : null,
    };
  };

  const ctoAgents = byRole.get("cto") ?? [];
  const root = ctoAgents[0] ? agentNode(ctoAgents[0], "cto", true, null) : vacantNode("cto", null);
  nodes.push(root);
  // A second CTO agent reports to the first.
  for (const extra of ctoAgents.slice(1)) nodes.push(agentNode(extra, "cto", true, root.key));

  for (const key of ROLE_KEYS) {
    if (key === "cto") continue;
    const list = byRole.get(key) ?? [];
    if (list.length === 0) nodes.push(vacantNode(key, root.key));
    for (const a of list) nodes.push(agentNode(a, key, true, root.key));
  }
  const fixedKeys = new Set<string>(ROLE_KEYS);
  const custom = [...byRole.entries()]
    .filter(([key]) => !fixedKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [key, list] of custom) for (const a of list) nodes.push(agentNode(a, key, false, root.key));

  return {
    nodes,
    rootKey: root.key,
    counts: {
      agents: nodes.filter((n) => n.agentId).length,
      enabled: nodes.filter((n) => n.agentId && n.enabled).length,
      vacant: nodes.filter((n) => !n.agentId).length,
      custom: nodes.filter((n) => !n.fixed).length,
    },
  };
}
