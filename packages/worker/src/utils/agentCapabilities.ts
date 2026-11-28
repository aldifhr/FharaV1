import { resolveRoleKey, ROLES } from "@/api/functions/lib/roles";
import { CAPABILITY, type AgentDefinition } from "@/types";

/**
 * Pure agent → capability resolution (declared capabilities, else the
 * role-name heuristic). No routing or availability logic: that stays in
 * orchestrator/capabilities, which re-exports these.
 *
 * Fixed roles take their capabilities from the shared role registry
 * (apps/api/functions/lib/roles.ts `registryCapabilities`), through the same
 * `resolveRoleKey` the backend and the executor use — no second regex table.
 * Only roles that are not one of the seven keep the worker-only heuristics
 * below (security, github, shell), matched on whole tokens.
 */

const WORKER_ONLY_CAPABILITIES: ReadonlyArray<{
  tokens: readonly string[];
  capabilities: readonly string[];
}> = [
  { tokens: ["security", "audit", "pentest", "appsec"], capabilities: [CAPABILITY.SECURITY] },
  {
    tokens: ["github", "git", "pr", "pull", "request", "issue", "repo"],
    capabilities: [CAPABILITY.GITHUB, CAPABILITY.SHELL_EXECUTION],
  },
  {
    tokens: ["shell", "terminal", "exec", "command", "run", "bash", "cmd", "powershell"],
    capabilities: [CAPABILITY.SHELL_EXECUTION],
  },
];

/** Lowercase whole tokens: "Dev-Ops / CI" → ["dev", "ops", "ci"]. */
function splitTokens(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of value.toLowerCase()) {
    const isWord = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isWord) current += ch;
    else if (current) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

/** Collapse whitespace runs to a single dash: "UI  UX" → "ui-ux". */
export function normalizeCapability(value: string): string {
  const parts: string[] = [];
  let current = "";
  for (const ch of value.trim().toLowerCase()) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.join("-");
}

export function capabilityForRole(role: string): string[] {
  const normalized = role.trim();
  if (!normalized) return [CAPABILITY.GENERAL];
  const key = resolveRoleKey(normalized);
  if (key) return [...ROLES[key].registryCapabilities];
  const tokens = new Set(splitTokens(normalized));
  for (const entry of WORKER_ONLY_CAPABILITIES) {
    if (entry.tokens.some((token) => tokens.has(token))) return [...entry.capabilities];
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
