import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { FIXED_TEAM_SEED_ORDER, isRetiredRole, normalizeRoleKey } from "./roles";

/**
 * The project's team as every surface sees it. An explicit `agentIds` list
 * wins. A project with none (created without a roster, e.g. through the API)
 * runs with the fixed team that `syncFixedTeam` seeds: the oldest agent of each
 * fixed (not retired) role, in seed order. The web mirrors
 * this in `apps/web/lib/projectMembers.ts`, so the chat header's "N agents"
 * and the chat backend never disagree.
 */
export function effectiveTeamIds(
  projectAgentIds: readonly Id<"agents">[] | undefined,
  allAgents: readonly Pick<Doc<"agents">, "_id" | "_creationTime" | "role">[],
): Id<"agents">[] {
  if (projectAgentIds && projectAgentIds.length > 0) return [...projectAgentIds];
  // One agent per fixed role, the oldest: the row syncFixedTeam matches and
  // would add to the project (and `fixedAgentIds` in apps/web/lib/agentRoles.ts).
  const order = FIXED_TEAM_SEED_ORDER as readonly string[];
  const byRole = new Map<string, Id<"agents">>();
  for (const agent of [...allAgents].sort((a, b) => a._creationTime - b._creationTime)) {
    const role = normalizeRoleKey(agent.role);
    if (!order.includes(role) || isRetiredRole(agent.role) || byRole.has(role)) continue;
    byRole.set(role, agent._id);
  }
  return order.flatMap((role) => (byRole.has(role) ? [byRole.get(role)!] : []));
}

/** `effectiveTeamIds` for a project row; reads the agents table only when the project has no roster. */
export async function projectTeamIds(
  ctx: Pick<QueryCtx, "db">,
  project: Pick<Doc<"projects">, "agentIds"> | null | undefined,
): Promise<Id<"agents">[]> {
  if (!project) return [];
  if (project.agentIds && project.agentIds.length > 0) return [...project.agentIds];
  return effectiveTeamIds(undefined, await ctx.db.query("agents").take(500));
}
