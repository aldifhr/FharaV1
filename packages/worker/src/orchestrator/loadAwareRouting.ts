import type { AgentDefinition } from "@/types";
import { capabilitiesOf, normalizeCapability } from "@/utils/agentCapabilities";
import { rankCapability } from "./capabilities";

/**
 * Load-aware routing (Workload Manager). Off by default: the project
 * setting `loadAwareRouting` turns it on, else the env fallback
 * ORCHESTRATOR_LOAD_AWARE_ROUTING.
 *
 * It only ever chooses BETWEEN agents that declare the subtask's capability
 * exactly, and only when the normal pick is itself an exact match. Among
 * those it prefers spare capacity: the lowest running / maxConcurrency
 * ratio among agents below their limit, ties to the normal order
 * (score, priority, name). Fallback and partial-match picks are never
 * changed, so it can never route to an agent lacking the capability.
 */

export interface LoadAwareDecision {
  from: string;
  to: string;
  fromRole: string;
  toRole: string;
  reason: string;
  load: { from: { running: number; limit: number }; to: { running: number; limit: number } };
}

export interface LoadAwarePick {
  agent: AgentDefinition | null;
  /** Set only when the load-aware rule changed the pick. */
  loadAware?: LoadAwareDecision;
}

/** Concurrency limit as the scheduler's start gate reads it (unset = 1). */
export function concurrencyLimit(agent: AgentDefinition): number {
  const raw = agent.maxConcurrency;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

export function pickLoadAware(
  defaultAgent: AgentDefinition | null,
  capability: string,
  agents: AgentDefinition[],
  loadOf: (agent: AgentDefinition) => number
): LoadAwarePick {
  if (!defaultAgent) return { agent: null };
  const normalized = normalizeCapability(capability);
  if (!capabilitiesOf(defaultAgent).includes(normalized)) return { agent: defaultAgent };
  const candidates = rankCapability(capability, agents)
    .filter((entry) => entry.score === 100)
    .map((entry) => entry.agent)
    .filter((agent) => capabilitiesOf(agent).includes(normalized));
  // The default pick leads the order when it is a candidate (ties keep it).
  const ordered = [defaultAgent, ...candidates.filter((agent) => agent._id !== defaultAgent._id)];
  if (ordered.length < 2) return { agent: defaultAgent };

  let best: { agent: AgentDefinition; ratio: number } | null = null;
  for (const agent of ordered) {
    const running = Math.max(0, loadOf(agent));
    const limit = concurrencyLimit(agent);
    if (running >= limit) continue;
    const ratio = running / limit;
    if (!best || ratio < best.ratio) best = { agent, ratio };
  }
  if (!best || best.agent._id === defaultAgent._id) return { agent: defaultAgent };

  const fromLoad = { running: Math.max(0, loadOf(defaultAgent)), limit: concurrencyLimit(defaultAgent) };
  const toLoad = { running: Math.max(0, loadOf(best.agent)), limit: concurrencyLimit(best.agent) };
  const full = fromLoad.running >= fromLoad.limit;
  return {
    agent: best.agent,
    loadAware: {
      from: defaultAgent.name,
      to: best.agent.name,
      fromRole: defaultAgent.role,
      toRole: best.agent.role,
      reason: `${full ? "at capacity" : "busier"} (${fromLoad.running}/${fromLoad.limit} running) vs ${toLoad.running}/${toLoad.limit}`,
      load: { from: fromLoad, to: toLoad },
    },
  };
}

/** Project setting wins; unset falls back to the env/policy default (off). */
export function loadAwareRoutingEnabled(
  project: { loadAwareRouting?: unknown } | null | undefined,
  policyDefault: boolean | undefined
): boolean {
  const setting = project?.loadAwareRouting;
  if (typeof setting === "boolean") return setting;
  return policyDefault === true;
}
