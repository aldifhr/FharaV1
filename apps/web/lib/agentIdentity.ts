/**
 * Agent display helpers, kept pure (no "@/" imports) for node:test.
 */

export type AgentLike = { name?: string | null; role?: string | null };
export type AgentRow = AgentLike & { _id: string; _creationTime?: number };

/** The agent's own name ("Reviewer 2"), falling back to its role label. */
export function agentDisplayName(agent: AgentLike, label: (role: string) => string = (r) => r): string {
  const name = (agent.name ?? "").trim();
  return name || label(agent.role ?? "");
}

/**
 * Secondary text for an agent row: the role label, or null when it would
 * just repeat the name (a fixed agent named after its role).
 */
export function agentRoleCaption(agent: AgentLike, label: (role: string) => string = (r) => r): string | null {
  const role = label(agent.role ?? "");
  return role && role.toLowerCase() !== agentDisplayName(agent, label).toLowerCase() ? role : null;
}

function normalizeRole(role: string | null | undefined): string {
  return (role ?? "").trim().toLowerCase().replace(/[\s_/]+/g, "-");
}

/**
 * Ids of the fixed-team agents: for each fixed role, the oldest agent with
 * that role (what the backend's fixed-team sync matches on). Every other
 * agent — a second "Reviewer 2", or a custom role — is custom and removable.
 */
export function fixedAgentIds(
  agents: readonly AgentRow[] | null | undefined,
  fixedRoles: readonly string[],
  retiredRoles: readonly string[] = []
): Set<string> {
  const fixed = new Set(fixedRoles.map(normalizeRole));
  const retired = new Set(retiredRoles.map(normalizeRole));
  const ordered = [...(agents ?? [])].sort((a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0));
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const agent of ordered) {
    const role = normalizeRole(agent.role);
    if (!fixed.has(role) || retired.has(role) || seen.has(role)) continue;
    seen.add(role);
    ids.add(agent._id);
  }
  return ids;
}
