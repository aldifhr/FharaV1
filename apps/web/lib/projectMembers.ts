import { fixedAgentIds } from "./agentRoles";
import type { AgentRow } from "./agentIdentity";

/**
 * The agents on a project's team. An explicit member list wins. A project
 * with none runs with the fixed team (one agent per fixed role), the same
 * set the chat backend falls back to (`apps/api/convex/lib/projectTeam.ts`
 * `effectiveTeamIds`), so the header's "N agents" is the team that answers.
 */
export function projectMembers<T extends AgentRow>(
  allAgents: T[] | undefined,
  memberIds: string[] | undefined,
): T[] {
  const all = allAgents ?? [];
  if (memberIds && memberIds.length) return all.filter((agent) => memberIds.includes(agent._id));
  const fixed = fixedAgentIds(all);
  return all.filter((agent) => fixed.has(agent._id));
}
