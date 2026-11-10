import type { AgentDefinition } from "@/types";

import { capabilitiesOf, normalizeCapability } from "@/utils/agentCapabilities";
import { canWriteAny, permissionsForAgent, resolveRoleKey } from "@/utils/rolePolicy";

// Pure capability resolution lives in `@/utils/agentCapabilities` (the
// execution layer needs it too); re-exported for existing importers.
export { normalizeCapability, capabilityForRole, capabilitiesOf } from "@/utils/agentCapabilities";

export function isAgentEnabled(agent: AgentDefinition): boolean {
  return agent.isEnabled !== false;
}

/**
 * Availability for routing/delegation: the isEnabled gate PLUS the agent's
 * status field. The persisted status union is a presence signal
 * ("idle" | "working" | "queued" | "needs_you") — none of those take an
 * agent out of rotation — but explicit offline/disabled markers, if a
 * writer ever sets them, must be honored instead of routing work to an
 * agent that has signalled it cannot take it.
 */
// Plan 040: design and documentation are read-only roles' work now
// (Designer / Support never write), so only implementation capabilities
// count as code-writing.
const WRITE_CAPABILITIES = new Set([
  "frontend-development",
  "backend-development",
]);

const UNAVAILABLE_STATUSES = new Set(["offline", "disabled", "unavailable"]);

export function isAgentAvailable(agent: AgentDefinition): boolean {
  if (!isAgentEnabled(agent)) return false;
  if (agent.status && UNAVAILABLE_STATUSES.has(agent.status.trim().toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * Agents that serve a capability, best first: score 100 = declares it,
 * 70 = substring match, 50 = shared token. Ties go to priority, then name.
 * `routeCapability` takes the first; the load-aware router
 * (`loadAwareRouting.ts`) may pick another agent of the same top score.
 */
export function rankCapability(
  capability: string,
  agents: AgentDefinition[]
): Array<{ agent: AgentDefinition; score: number }> {
  const normalized = normalizeCapability(capability);
  return agents
    .filter(isAgentAvailable)
    .map((agent) => {
      const capabilities = capabilitiesOf(agent);
      let score = 0;
      if (capabilities.includes(normalized)) score = 100;
      else if (
        capabilities.some(
          (candidate) =>
            normalized.includes(candidate) || candidate.includes(normalized)
        )
      ) {
        score = 70;
      } else if (
        capabilities.some((candidate) => {
          const candidateTokens = new Set(candidate.split(/[-_]/));
          return normalized.split(/[-_]/).some((token) => candidateTokens.has(token));
        })
      ) {
        score = 50;
      }
      return { agent, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.agent.priority ?? 0) - (a.agent.priority ?? 0) ||
        a.agent.name.localeCompare(b.agent.name)
    );
}

/**
 * Best agent for a capability, or null when no enabled agent serves it.
 *
 * Plan 040 (D8): no silent fallback. Unmatched work is BLOCKED with a reason
 * by the caller instead of landing on the highest-priority agent (the CTO).
 * `allowFallback: true` (only from ORCHESTRATOR_ALLOW_FALLBACK=true) keeps
 * the old last resort for one release, and even then never picks the CTO
 * or, for a code-writing capability, an agent whose role may not write.
 */
export function routeCapability(
  capability: string,
  agents: AgentDefinition[],
  options: { allowFallback?: boolean } = {}
): AgentDefinition | null {
  const normalized = normalizeCapability(capability);
  const enabled = agents.filter(isAgentAvailable);
  if (enabled.length === 0) return null;

  const scored = rankCapability(capability, enabled);
  // A code-writing capability goes only to an agent that may write.
  const eligible = WRITE_CAPABILITIES.has(normalized)
    ? scored.filter((entry) => canWriteAny(permissionsForAgent(entry.agent)))
    : scored;
  if (eligible.length > 0) return eligible[0].agent;
  if (options.allowFallback !== true) return null;
  const pool = enabled.filter((agent) => resolveRoleKey(agent.role ?? "") !== "cto");
  const writers = WRITE_CAPABILITIES.has(normalized)
    ? pool.filter((agent) => canWriteAny(permissionsForAgent(agent)))
    : pool;
  if (WRITE_CAPABILITIES.has(normalized) && writers.length === 0) return null;
  return (
    writers
      .slice()
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name)
      )[0] ?? null
  );
}

/** Why `routeCapability` found nobody, for BLOCKED reasons / events. */
export function unroutedReason(capability: string, agents: AgentDefinition[]): string {
  const enabled = agents.filter(isAgentAvailable);
  if (enabled.length === 0) return `No agent available for capability "${capability}": no enabled agents`;
  const normalized = normalizeCapability(capability);
  if (WRITE_CAPABILITIES.has(normalized) && rankCapability(capability, enabled).length > 0) {
    return `No agent available for capability "${capability}": the agents that declare it may not write files`;
  }
  return `No agent available for capability "${capability}": no enabled agent declares it (no fallback; add or enable an agent with this capability)`;
}

export function describeCapabilities(agents: AgentDefinition[]): string {
  return agents
    .filter(isAgentAvailable)
    .map((agent) => `${agent.name} (role: ${agent.role}; capabilities: ${capabilitiesOf(agent).join(", ")})`)
    .join("\n");
}
