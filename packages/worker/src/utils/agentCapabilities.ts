import { ROLES } from "@/api/convex/lib/roles";
import { CAPABILITY, type AgentDefinition } from "@/types";

/**
 * Pure agent → capability resolution (declared capabilities, else the
 * role-name heuristic). No routing or availability logic: that stays in
 * orchestrator/capabilities, which re-exports these.
 *
 * Role patterns take their capabilities from the shared role registry
 * (apps/api/convex/lib/roles.ts `registryCapabilities`); the non-role
 * patterns (security, github, shell) are worker-only heuristics.
 */

const ROLE_CAPABILITIES: Array<{ pattern: RegExp; capabilities: string[] }> = [
  {
    pattern: /\b(cto|architect|architecture|tech lead|principal)\b/i,
    capabilities: [...ROLES.cto.registryCapabilities],
  },
  {
    pattern: /\b(designer|design|wireframe|ui-ux|figma)\b/i,
    capabilities: [...ROLES.designer.registryCapabilities],
  },
  {
    pattern: /\b(frontend|front-end|ui|ux|react|web)\b/i,
    capabilities: [...ROLES.frontend.registryCapabilities],
  },
  {
    pattern: /\b(backend|back-end|api|server|database|db)\b/i,
    capabilities: [...ROLES.backend.registryCapabilities],
  },
  {
    pattern: /\b(qa|test|testing|quality|e2e)\b/i,
    capabilities: [...ROLES.qa.registryCapabilities],
  },
  {
    pattern: /\b(reviewer|code-?review)\b/i,
    capabilities: [...ROLES.reviewer.registryCapabilities],
  },
  {
    pattern: /\b(support|documentation|docs|technical-writer|writer)\b/i,
    capabilities: [...ROLES.support.registryCapabilities],
  },
  {
    pattern: /\b(security|audit|pentest|appsec)\b/i,
    capabilities: [CAPABILITY.SECURITY],
  },
  {
    pattern: /\b(research|analyst|investigator)\b/i,
    capabilities: [...ROLES.researcher.registryCapabilities],
  },
  {
    pattern: /\b(github|git|pr|pull request|issue|repo)\b/i,
    capabilities: [CAPABILITY.GITHUB, CAPABILITY.SHELL_EXECUTION],
  },
  {
    pattern: /\b(shell|terminal|exec|command|run|bash)\b/i,
    capabilities: [CAPABILITY.SHELL_EXECUTION],
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
