import type { AgentDefinition } from "@/types";
import { capabilitiesOf, normalizeCapability } from "@/utils/agentCapabilities";
import { PRIOR_SCORE, type PerformanceScore } from "@/api/convex/lib/agentPerformance";
import { rankCapability } from "./capabilities";
import { concurrencyLimit } from "./loadAwareRouting";

/**
 * Performance routing (plan 027). Off by default: the project setting
 * `performanceRouting` turns it on, else the env fallback
 * ORCHESTRATOR_PERFORMANCE_ROUTING. Deterministic; no LLM call.
 *
 * Like load-aware routing it only chooses BETWEEN agents that declare the
 * subtask's capability exactly, and only when the normal pick is itself an
 * exact match — fallback picks are never changed, so it can never route to
 * an agent lacking the capability. Order of factors:
 *
 *   1. capability fit     exact declaration only (a filter, not a score)
 *   2. availability       below its concurrency limit (live load, as the
 *                         load-aware router reads it); a full agent is
 *                         never picked while another candidate has room
 *   3. performance score  smoothed score (lib/agentPerformance.ts); scores
 *                         within SCORE_TOLERANCE count as a tie
 *   4. model fit          the agent's model satisfies the subtask's
 *                         capability needs (model registry)
 *   5. budget fit         expected tokens (its tokens per accepted result)
 *                         fit the task's remaining token budget
 *   6. original order     the normal pick first, then rankCapability order
 */

export const SCORE_TOLERANCE = 0.02;

export interface PerformanceCandidate {
  agent: string;
  role: string;
  score: number;
  samples: number;
  insufficient: boolean;
  available: boolean;
  load: { running: number; limit: number };
  modelFit: boolean | null;
  budgetFit: boolean | null;
  expectedTokens: number | null;
}

export interface PerformanceDecision {
  from: string;
  to: string;
  fromRole: string;
  toRole: string;
  changed: boolean;
  reason: string;
  scores: PerformanceCandidate[];
}

export interface PerformancePickInput {
  loadOf: (agent: AgentDefinition) => number;
  scoreOf: (agent: AgentDefinition, capability: string) => PerformanceScore | undefined;
  /** Model registry check for this subtask's needs; null = unknown. */
  modelFits?: (agent: AgentDefinition) => boolean | null;
  /** Task tokens left; null/undefined = no budget signal. */
  remainingTokens?: number | null;
}

export function pickByPerformance(
  defaultAgent: AgentDefinition | null,
  capability: string,
  agents: AgentDefinition[],
  input: PerformancePickInput
): { agent: AgentDefinition | null; performance?: PerformanceDecision } {
  if (!defaultAgent) return { agent: null };
  const normalized = normalizeCapability(capability);
  if (!capabilitiesOf(defaultAgent).includes(normalized)) return { agent: defaultAgent };
  const exact = rankCapability(capability, agents)
    .filter((entry) => entry.score === 100)
    .map((entry) => entry.agent)
    .filter((agent) => capabilitiesOf(agent).includes(normalized));
  const ordered = [defaultAgent, ...exact.filter((agent) => agent._id !== defaultAgent._id)];

  const remaining = typeof input.remainingTokens === "number" ? input.remainingTokens : null;
  const rows = ordered.map((agent) => {
    const running = Math.max(0, input.loadOf(agent));
    const limit = concurrencyLimit(agent);
    const score = input.scoreOf(agent, normalized);
    const expectedTokens = score?.factors.efficiency.tokensPerAccepted ?? null;
    const candidate: PerformanceCandidate = {
      agent: agent.name,
      role: agent.role,
      score: score?.score ?? round(PRIOR_SCORE),
      samples: score?.samples ?? 0,
      insufficient: score ? score.insufficient : true,
      available: running < limit,
      load: { running, limit },
      modelFit: input.modelFits ? input.modelFits(agent) : null,
      budgetFit: remaining === null || expectedTokens === null ? null : expectedTokens <= remaining,
      expectedTokens,
    };
    return { agent, candidate };
  });

  const decision = (to: (typeof rows)[number], reason: string): PerformanceDecision => ({
    from: defaultAgent.name,
    to: to.agent.name,
    fromRole: defaultAgent.role,
    toRole: to.agent.role,
    changed: to.agent._id !== defaultAgent._id,
    reason,
    scores: rows.map((row) => row.candidate),
  });

  if (rows.length < 2) {
    return { agent: defaultAgent, performance: decision(rows[0], "only agent declaring the capability") };
  }
  const open = rows.filter((row) => row.candidate.available);
  if (open.length === 0) {
    return { agent: defaultAgent, performance: decision(rows[0], "every capable agent is at capacity; kept the usual pick") };
  }

  // Stable selection in original order: a later candidate replaces the
  // best only on a real score gap, or — within the tolerance — on model
  // fit, then budget fit. Equal on all of them keeps the earlier one.
  const fitRank = (value: boolean | null) => (value === true ? 1 : value === null ? 0 : -1);
  let best = open[0];
  let why = "highest score";
  for (const row of open.slice(1)) {
    const a = best.candidate;
    const b = row.candidate;
    if (b.score > a.score + SCORE_TOLERANCE) {
      best = row;
      why = "higher performance score";
      continue;
    }
    if (Math.abs(b.score - a.score) > SCORE_TOLERANCE) continue;
    if (fitRank(b.modelFit) > fitRank(a.modelFit)) {
      best = row;
      why = "scores tied; its model fits the subtask's needs";
      continue;
    }
    if (fitRank(b.modelFit) < fitRank(a.modelFit)) continue;
    if (fitRank(b.budgetFit) > fitRank(a.budgetFit)) {
      best = row;
      why = "scores tied; its expected tokens fit the remaining budget";
    }
  }

  const def = rows[0].candidate;
  const chosen = best.candidate;
  let reason: string;
  if (best.agent._id === defaultAgent._id) {
    reason = open.length === 1 ? "only capable agent with spare capacity" : `kept: ${why === "highest score" ? "no candidate beats it by more than the tie margin" : why}`;
  } else if (!def.available) {
    reason = `usual pick at capacity (${def.load.running}/${def.load.limit}); ${why} among the rest (${chosen.score.toFixed(2)})`;
  } else {
    reason = `${why}: ${chosen.score.toFixed(2)} vs ${def.score.toFixed(2)}`;
  }
  return { agent: best.agent, performance: decision(best, reason) };
}

/** Project setting wins; unset falls back to the env/policy default (off). */
export function performanceRoutingEnabled(
  project: { performanceRouting?: unknown } | null | undefined,
  policyDefault: boolean | undefined
): boolean {
  const setting = project?.performanceRouting;
  if (typeof setting === "boolean") return setting;
  return policyDefault === true;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
