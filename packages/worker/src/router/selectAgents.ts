import { isAgentAvailable, routeCapability } from "../orchestrator/capabilities";
import type { AgentDefinition } from "../orchestrator/types";

export interface AgentSelection {
  agentIds: string[];
  agentNames: string[];
  reasons: string[];
}

/**
 * Capability-scored agent selection for chat replies (plan 006 Phase 1).
 *
 * Never falls back to an unrelated agent (`allowFallback: false`): when no
 * agent serves a capability it is simply skipped. A multi-agent reply only
 * happens when >=2 agents serve *distinct* capabilities and `maxAgents`
 * allows it. When nothing matches, the general-capability agent answers, or
 * the first enabled agent — the CTO/orchestrator is never forced.
 */
export function selectAgentsForChat(
  agents: AgentDefinition[],
  suggestedCapabilities: string[],
  maxAgents: number
): AgentSelection {
  const enabled = agents.filter(isAgentAvailable);
  const reasons: string[] = [];
  if (enabled.length === 0) {
    reasons.push("no enabled agents");
    return { agentIds: [], agentNames: [], reasons };
  }

  const picked: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const capability of suggestedCapabilities) {
    const agent = routeCapability(capability, enabled, { allowFallback: false });
    if (agent && !seen.has(agent._id)) {
      seen.add(agent._id);
      picked.push(agent);
      reasons.push(`${agent.name} serves ${capability}`);
    }
  }

  if (picked.length === 0) {
    const fallback =
      enabled.find((agent) => (agent.capabilities ?? []).includes("general")) ??
      enabled[0];
    picked.push(fallback);
    reasons.push(`${fallback.name} is the general fallback`);
  }

  const capped = picked.slice(0, Math.max(1, maxAgents));
  return {
    agentIds: capped.map((agent) => agent._id),
    agentNames: capped.map((agent) => agent.name),
    reasons,
  };
}
