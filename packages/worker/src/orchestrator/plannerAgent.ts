/**
 * Who the planner's LLM call runs on, and who answers a conversation-only
 * task. O1 (Orchestrator/CTO split): the planner is system code with no
 * persona. The CTO (or the global fallback CTO) is only a MODEL SOURCE for
 * the planner call; with neither, any enabled agent's model chain plans, so
 * LLM planning works without a CTO in the team.
 */
import { CAPABILITY, type AgentDefinition } from "@/types";
import { capabilitiesOf, isAgentEnabled } from "./capabilities";
import { DOMAIN_ROLES, matchDomains } from "@/api/convex/lib/chat/dispatch";

const isRole = (agent: AgentDefinition, role: string) => agent.role.trim().toLowerCase() === role;

/** The run's CTO (or a custom "orchestrator" role), the preferred planner model source. */
export function pickOrchestrator(agents: AgentDefinition[]): AgentDefinition | null {
  const enabled = agents.filter(isAgentEnabled);
  if (enabled.length === 0) return null;
  return enabled.find((agent) => isRole(agent, "cto")) ?? enabled.find((agent) => isRole(agent, "orchestrator")) ?? null;
}

/**
 * The run's own CTO/orchestrator, else the global fallback CTO (it stays
 * out of `agents`, so routing never assigns it an executor subtask).
 */
export function pickPlanner(agents: AgentDefinition[], fallback?: AgentDefinition | null): AgentDefinition | null {
  return pickOrchestrator(agents) ?? (fallback && isAgentEnabled(fallback) ? fallback : null);
}

/**
 * The agent whose model chain serves the (persona-free) planner call:
 * pickPlanner, else the highest-priority enabled agent of the run. Null
 * only when the run has no enabled agent at all.
 */
export function pickPlannerModelSource(
  agents: AgentDefinition[],
  fallback?: AgentDefinition | null
): { agent: AgentDefinition; viaTeamMember: boolean } | null {
  const planner = pickPlanner(agents, fallback);
  if (planner) return { agent: planner, viaTeamMember: false };
  const enabled = agents.filter(isAgentEnabled).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return enabled[0] ? { agent: enabled[0], viaTeamMember: true } : null;
}

/**
 * The capability of the reply node of a conversation-only task: the routing
 * hint's role (chat already routed it, P1a), else the topic owner by the
 * chat domain rules, else Support (greetings / how-to), else any enabled
 * non-CTO role, else the CTO.
 */
export function conversationReplyCapability(command: string, agents: AgentDefinition[], hintRole?: string): string {
  const enabled = agents.filter(isAgentEnabled);
  const firstCapability = (agent: AgentDefinition | undefined) => (agent ? capabilitiesOf(agent)[0] : undefined);
  const hinted = hintRole ? firstCapability(enabled.find((agent) => isRole(agent, hintRole))) : undefined;
  if (hinted) return hinted;
  for (const domain of matchDomains(command)) {
    for (const role of DOMAIN_ROLES[domain]) {
      const capability = firstCapability(enabled.find((agent) => isRole(agent, role)));
      if (capability) return capability;
    }
  }
  const support = enabled.find((agent) => capabilitiesOf(agent).includes(CAPABILITY.DOCUMENTATION));
  if (support) return CAPABILITY.DOCUMENTATION;
  return (
    firstCapability(enabled.find((agent) => !isRole(agent, "cto") && capabilitiesOf(agent).length > 0)) ??
    firstCapability(enabled.find((agent) => capabilitiesOf(agent).length > 0)) ??
    CAPABILITY.DOCUMENTATION
  );
}
