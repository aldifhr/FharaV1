import { CAPABILITY, type AgentDefinition } from "./types";

const ROLE_CAPABILITIES: Array<{ pattern: RegExp; capabilities: string[] }> = [
  {
    pattern: /\b(frontend|front-end|ui|ux|react|web)\b/i,
    capabilities: [CAPABILITY.FRONTEND],
  },
  {
    pattern: /\b(backend|back-end|api|server|database|db)\b/i,
    capabilities: [CAPABILITY.BACKEND],
  },
  {
    pattern: /\b(qa|test|testing|quality|e2e)\b/i,
    capabilities: [CAPABILITY.BROWSER_TESTING],
  },
  {
    pattern: /\b(cto|architect|architecture|tech lead|lead|principal)\b/i,
    capabilities: [CAPABILITY.ARCHITECTURE, CAPABILITY.CODE_REVIEW],
  },
  {
    pattern: /\b(security|audit|pentest|appsec)\b/i,
    capabilities: [CAPABILITY.SECURITY, CAPABILITY.CODE_REVIEW],
  },
  {
    pattern: /\b(research|analyst|investigator)\b/i,
    capabilities: [CAPABILITY.RESEARCH],
  },
  {
    pattern: /\b(github|git|pr|pull request|issue|repo)\b/i,
    capabilities: [CAPABILITY.GITHUB, CAPABILITY.SHELL_EXECUTION],
  },
  {
    pattern: /\b(shell|terminal|exec|command|run|bash)\b/i,
    capabilities: [CAPABILITY.SHELL_EXECUTION],
  },
  {
    pattern: /\b(orchestrator|planner|manager|coordinator)\b/i,
    capabilities: [CAPABILITY.ARCHITECTURE, CAPABILITY.RESEARCH, CAPABILITY.GENERAL],
  },
];

export function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function capabilityForRole(role: string): string[] {
  const normalized = role.trim();
  if (!normalized) return [CAPABILITY.GENERAL];
  for (const entry of ROLE_CAPABILITIES) {
    if (entry.pattern.test(normalized)) return entry.capabilities;
  }
  return [normalizeCapability(normalized), CAPABILITY.GENERAL];
}

export function capabilitiesOf(agent: AgentDefinition): string[] {
  const declared = (agent.capabilities ?? [])
    .map(normalizeCapability)
    .filter((capability) => capability.length > 0);
  if (declared.length > 0) return Array.from(new Set(declared));
  return Array.from(new Set(capabilityForRole(agent.role)));
}

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
  return (
    enabled
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
