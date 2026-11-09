import type { AgentDefinition } from "@/types";

import { capabilitiesOf, normalizeCapability } from "@/utils/agentCapabilities";

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
const WRITE_CAPABILITIES = new Set([
  "frontend-development",
  "backend-development",
  "ui-ux-design",
  "documentation-support",
]);

const UNAVAILABLE_STATUSES = new Set(["offline", "disabled", "unavailable"]);

export function isAgentAvailable(agent: AgentDefinition): boolean {
  if (!isAgentEnabled(agent)) return false;
  if (agent.status && UNAVAILABLE_STATUSES.has(agent.status.trim().toLowerCase())) {
    return false;
  }
  return true;
}

export function routeCapability(
  capability: string,
  agents: AgentDefinition[],
  options: { allowFallback?: boolean } = {}
): AgentDefinition | null {
  const normalized = normalizeCapability(capability);
  const enabled = agents.filter(isAgentAvailable);
  if (enabled.length === 0) return null;

  const scored = enabled
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

  if (scored.length > 0) return scored[0].agent;
  if (options.allowFallback === false) return null;
  // Code-writing capabilities fall back only to an agent that can write
  // files: a read-only QA/Researcher/Reviewer handed "frontend-development"
  // cannot do the work (seen when a task's pool had no Frontend).
  const writers = WRITE_CAPABILITIES.has(normalized)
    ? enabled.filter((agent) => (agent.supportedTools ?? []).includes("write_file"))
    : [];
  return (
    (writers.length > 0 ? writers : enabled)
      .slice()
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name)
      )[0] ?? null
  );
}

export function describeCapabilities(agents: AgentDefinition[]): string {
  return agents
    .filter(isAgentAvailable)
    .map((agent) => `${agent.name} (role: ${agent.role}; capabilities: ${capabilitiesOf(agent).join(", ")})`)
    .join("\n");
}
