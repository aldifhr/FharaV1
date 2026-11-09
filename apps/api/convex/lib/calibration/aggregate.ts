/**
 * Decision Outcome Calibration — aggregation and recommendations. Pure.
 *
 * Signals (labelled decisions only; "unknown" never counts):
 *  - routing per agent × capability: good rate and its trend (first half
 *    vs second half of the window, chronological)
 *  - estimator per project × role × complexity: median actual/estimate
 *    ratio for tokens and duration (routing decisions with both numbers)
 *  - replan effectiveness: good replans / labelled replans
 *  - planner requirement-miss rate: plans whose coverage check found
 *    uncovered requirements / plans that had a coverage check
 *
 * Recommendations are suggestions only. Each names the existing setting
 * an Apply would change and its before → after value; nothing here (or
 * anywhere) applies one automatically.
 *
 * Thresholds:
 *  - routing: ≥ MIN_ROUTING_SAMPLES labelled picks and good rate ≤
 *    ROUTING_LOW_GOOD_RATE, and at least one other agent declares the
 *    capability (otherwise a priority change changes nothing) → lower the
 *    agent's priority to one below the best alternative.
 *  - estimator: ≥ MIN_ESTIMATE_SAMPLES and median ratio ≥
 *    ESTIMATE_HIGH_RATIO (under-predicts) or ≤ ESTIMATE_LOW_RATIO
 *    (over-predicts) → multiply the role × complexity multiplier by the
 *    ratio (clamped to [MULTIPLIER_MIN, MULTIPLIER_MAX], 0.1 steps).
 *  - replan: ≥ MIN_REPLAN_SAMPLES and good rate < REPLAN_LOW_GOOD_RATE
 *    (advisory; no setting to change).
 *  - planner: ≥ MIN_PLANNER_SAMPLES plans with a coverage check and miss
 *    rate ≥ PLANNER_MISS_RATE (advisory).
 * A dismissed or applied recommendation only comes back when the
 * decisions made AFTER that action meet the same threshold on their own.
 */

import type { OutcomeLabel } from "./outcome";

export const MIN_ROUTING_SAMPLES = 5;
export const ROUTING_LOW_GOOD_RATE = 0.4;
export const MIN_ESTIMATE_SAMPLES = 5;
export const ESTIMATE_HIGH_RATIO = 1.5;
export const ESTIMATE_LOW_RATIO = 0.67;
export const MULTIPLIER_MIN = 0.25;
export const MULTIPLIER_MAX = 10;
export const MIN_REPLAN_SAMPLES = 5;
export const REPLAN_LOW_GOOD_RATE = 0.5;
export const MIN_PLANNER_SAMPLES = 5;
export const PLANNER_MISS_RATE = 0.3;
/** A trend needs at least this many labelled picks (split in two halves). */
export const MIN_TREND_SAMPLES = 4;
export const TREND_DELTA = 0.2;

export interface LabelledDecision {
  id: string;
  projectId: string;
  taskId: string;
  type: string;
  decidedAt: number;
  label: OutcomeLabel;
  agentName?: string | null;
  agentId?: string | null;
  capability?: string | null;
  role?: string | null;
  complexity?: string | null;
  tokensRatio?: number | null;
  durationRatio?: number | null;
  plannerMiss?: boolean;
  hadRequirements?: boolean;
}

export interface Counts {
  good: number;
  suboptimal: number;
  bad: number;
  unknown: number;
}

export interface RoutingSignal extends Counts {
  agentName: string;
  agentId: string | null;
  capability: string;
  labelled: number;
  goodRate: number | null;
  trend: "improving" | "declining" | "flat" | null;
}

export interface EstimatorSignal {
  projectId: string;
  role: string;
  complexity: string;
  tokens: { samples: number; ratio: number | null };
  duration: { samples: number; ratio: number | null };
}

export interface RateSignal {
  samples: number;
  good?: number;
  rate: number | null;
}

export interface AgentSetting {
  id: string;
  name: string;
  role: string;
  priority: number;
  capabilities: string[];
  enabled: boolean;
}

export interface MultiplierSetting {
  role: string;
  complexity?: string;
  tokens?: number;
  duration?: number;
}

export type RecommendationApply =
  | { kind: "agent_priority"; agentId: string; agentName: string; from: number; to: number }
  | {
      kind: "estimator_multiplier";
      projectId: string;
      role: string;
      complexity: string;
      metric: "tokens" | "duration";
      from: number;
      to: number;
    };

export interface Recommendation {
  /** Stable id: same group → same id, so Dismiss / Apply stick. */
  id: string;
  kind: "routing" | "estimator" | "replan" | "planner";
  title: string;
  detail: string;
  samples: number;
  apply: RecommendationApply | null;
}

export interface ActionRecord {
  recId: string;
  action: "applied" | "dismissed";
  at: number;
}

function emptyCounts(): Counts {
  return { good: 0, suboptimal: 0, bad: 0, unknown: 0 };
}
function labelled(c: Counts): number {
  return c.good + c.suboptimal + c.bad;
}
function rate(good: number, n: number): number | null {
  return n > 0 ? Math.round((good / n) * 100) / 100 : null;
}
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

// ─── Signals ───────────────────────────────────────────────────────────────

export function routingSignals(decisions: LabelledDecision[]): RoutingSignal[] {
  const groups = new Map<string, { agentName: string; agentId: string | null; capability: string; rows: LabelledDecision[] }>();
  for (const d of decisions) {
    if (d.type !== "routing" || !d.agentName || !d.capability) continue;
    const key = `${d.agentName}::${norm(d.capability)}`;
    const g = groups.get(key) ?? { agentName: d.agentName, agentId: d.agentId ?? null, capability: norm(d.capability), rows: [] };
    if (!g.agentId && d.agentId) g.agentId = d.agentId;
    g.rows.push(d);
    groups.set(key, g);
  }
  const out: RoutingSignal[] = [];
  for (const g of groups.values()) {
    const c = emptyCounts();
    for (const d of g.rows) c[d.label] += 1;
    const known = g.rows.filter((d) => d.label !== "unknown").sort((a, b) => a.decidedAt - b.decidedAt);
    let trend: RoutingSignal["trend"] = null;
    if (known.length >= MIN_TREND_SAMPLES) {
      const half = Math.floor(known.length / 2);
      const first = known.slice(0, half);
      const second = known.slice(known.length - half);
      const r1 = first.filter((d) => d.label === "good").length / first.length;
      const r2 = second.filter((d) => d.label === "good").length / second.length;
      trend = r2 - r1 >= TREND_DELTA ? "improving" : r1 - r2 >= TREND_DELTA ? "declining" : "flat";
    }
    const n = labelled(c);
    out.push({ ...c, agentName: g.agentName, agentId: g.agentId, capability: g.capability, labelled: n, goodRate: rate(c.good, n), trend });
  }
  return out.sort((a, b) => (a.goodRate ?? 2) - (b.goodRate ?? 2) || b.labelled - a.labelled);
}

export function estimatorSignals(decisions: LabelledDecision[]): EstimatorSignal[] {
  const groups = new Map<string, { projectId: string; role: string; complexity: string; tokens: number[]; duration: number[] }>();
  for (const d of decisions) {
    if (d.type !== "routing" || !d.role) continue;
    const role = norm(d.role);
    const complexity = norm(d.complexity) || "any";
    const key = `${d.projectId}::${role}::${complexity}`;
    const g = groups.get(key) ?? { projectId: d.projectId, role, complexity, tokens: [], duration: [] };
    if (typeof d.tokensRatio === "number" && d.tokensRatio > 0) g.tokens.push(d.tokensRatio);
    if (typeof d.durationRatio === "number" && d.durationRatio > 0) g.duration.push(d.durationRatio);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.tokens.length + g.duration.length > 0)
    .map((g) => ({
      projectId: g.projectId,
      role: g.role,
      complexity: g.complexity,
      tokens: { samples: g.tokens.length, ratio: round2(median(g.tokens)) },
      duration: { samples: g.duration.length, ratio: round2(median(g.duration)) },
    }));
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function replanSignal(decisions: LabelledDecision[]): RateSignal {
  const rows = decisions.filter((d) => d.type === "replan" && d.label !== "unknown");
  const good = rows.filter((d) => d.label === "good").length;
  return { samples: rows.length, good, rate: rate(good, rows.length) };
}

export function plannerMissSignal(decisions: LabelledDecision[]): RateSignal {
  const rows = decisions.filter((d) => d.type === "plan" && d.hadRequirements);
  const missed = rows.filter((d) => d.plannerMiss).length;
  return { samples: rows.length, rate: rate(missed, rows.length) };
}

export function labelCounts(decisions: LabelledDecision[]): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const d of decisions) {
    const c = (out[d.type] ??= emptyCounts());
    c[d.label] += 1;
  }
  return out;
}

// ─── Recommendations ───────────────────────────────────────────────────────

export function roundMultiplier(value: number): number {
  return Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, Math.round(value * 10) / 10));
}

/** The multiplier currently set for role × complexity (exact entry only; unset = 1). */
export function currentMultiplier(
  settings: MultiplierSetting[] | undefined,
  role: string,
  complexity: string,
  metric: "tokens" | "duration"
): number {
  const entry = (settings ?? []).find(
    (m) => norm(m.role) === norm(role) && (norm(m.complexity) || "any") === (norm(complexity) || "any")
  );
  const value = entry?.[metric];
  return typeof value === "number" && value > 0 ? value : 1;
}

function percent(r: number): string {
  return `${Math.round(r * 100)}%`;
}

function routingRecs(decisions: LabelledDecision[], agents: AgentSetting[]): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const s of routingSignals(decisions)) {
    if (s.labelled < MIN_ROUTING_SAMPLES || s.goodRate === null || s.goodRate > ROUTING_LOW_GOOD_RATE) continue;
    const agent = agents.find((a) => (s.agentId && a.id === s.agentId) || a.name === s.agentName);
    const id = `routing:${s.agentName}:${s.capability}`;
    const title = `Lower ${s.agentName} priority for capability ${s.capability}: ${s.good}/${s.labelled} good`;
    const alternatives = agents.filter(
      (a) => a.enabled && a !== agent && a.capabilities.map(norm).includes(s.capability)
    );
    if (!agent || alternatives.length === 0) {
      recs.push({
        id,
        kind: "routing",
        title,
        detail: agent
          ? `No other enabled agent declares ${s.capability}, so a priority change would not change routing. Consider adding the capability to another agent.`
          : `${s.agentName} no longer exists.`,
        samples: s.labelled,
        apply: null,
      });
      continue;
    }
    const best = Math.max(...alternatives.map((a) => a.priority));
    const to = Math.min(agent.priority - 1, best - 1);
    recs.push({
      id,
      kind: "routing",
      title,
      detail: `${s.bad} bad, ${s.suboptimal} suboptimal${s.trend ? `, trend ${s.trend}` : ""}. Priority breaks ties between agents that declare the capability; ${alternatives
        .map((a) => `${a.name} (${a.priority})`)
        .join(", ")} would be picked first. Priority is per agent, so it applies to all of ${agent.name}'s capabilities.`,
      samples: s.labelled,
      apply: { kind: "agent_priority", agentId: agent.id, agentName: agent.name, from: agent.priority, to },
    });
  }
  return recs;
}

function estimatorRecs(
  decisions: LabelledDecision[],
  multipliersByProject: Map<string, MultiplierSetting[] | undefined>
): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const s of estimatorSignals(decisions)) {
    for (const metric of ["tokens", "duration"] as const) {
      const m = s[metric];
      if (m.samples < MIN_ESTIMATE_SAMPLES || m.ratio === null) continue;
      const under = m.ratio >= ESTIMATE_HIGH_RATIO;
      const over = m.ratio <= ESTIMATE_LOW_RATIO;
      if (!under && !over) continue;
      const from = currentMultiplier(multipliersByProject.get(s.projectId), s.role, s.complexity, metric);
      const to = roundMultiplier(from * m.ratio);
      if (to === from) continue;
      const scope = `${s.complexity === "any" ? "" : `${s.complexity.toUpperCase()} `}${s.role}`;
      recs.push({
        id: `estimator:${s.projectId}:${s.role}:${s.complexity}:${metric}`,
        kind: "estimator",
        title: under
          ? `Estimator under-predicts ${scope} ${metric} by ${m.ratio.toFixed(1)}x`
          : `Estimator over-predicts ${scope} ${metric} by ${(1 / m.ratio).toFixed(1)}x`,
        detail: `Median actual/estimate over ${m.samples} subtask(s). Sets the ${metric} multiplier for ${scope} from ${from} to ${to}.`,
        samples: m.samples,
        apply: { kind: "estimator_multiplier", projectId: s.projectId, role: s.role, complexity: s.complexity, metric, from, to },
      });
    }
  }
  return recs;
}

function replanRecs(decisions: LabelledDecision[]): Recommendation[] {
  const s = replanSignal(decisions);
  if (s.samples < MIN_REPLAN_SAMPLES || s.rate === null || s.rate >= REPLAN_LOW_GOOD_RATE) return [];
  return [
    {
      id: "replan:effectiveness",
      kind: "replan",
      title: `Replans recover the run ${s.good}/${s.samples} times (${percent(s.rate)})`,
      detail: "Advisory: there is no setting to change. Open the bad replans on their runs and review the failure feedback and the planner instructions yourself.",
      samples: s.samples,
      apply: null,
    },
  ];
}

function plannerRecs(decisions: LabelledDecision[]): Recommendation[] {
  const s = plannerMissSignal(decisions);
  if (s.samples < MIN_PLANNER_SAMPLES || s.rate === null || s.rate < PLANNER_MISS_RATE) return [];
  return [
    {
      id: "planner:requirement-miss",
      kind: "planner",
      title: `Planner misses requirements in ${percent(s.rate)} of plans (${Math.round(s.rate * s.samples)}/${s.samples})`,
      detail: "Advisory: no setting to change. Project instructions can list the requirement types the planner keeps dropping.",
      samples: s.samples,
      apply: null,
    },
  ];
}

/**
 * All recommendations for the decisions in scope. A recommendation that
 * was dismissed or applied is recomputed from the decisions made after
 * that action only, so it returns only on fresh evidence.
 */
export function recommendations(input: {
  decisions: LabelledDecision[];
  agents: AgentSetting[];
  multipliersByProject: Map<string, MultiplierSetting[] | undefined>;
  actions: ActionRecord[];
}): Recommendation[] {
  const compute = (decisions: LabelledDecision[]) => [
    ...routingRecs(decisions, input.agents),
    ...estimatorRecs(decisions, input.multipliersByProject),
    ...replanRecs(decisions),
    ...plannerRecs(decisions),
  ];
  const latest = new Map<string, ActionRecord>();
  for (const a of input.actions) {
    const prev = latest.get(a.recId);
    if (!prev || a.at > prev.at) latest.set(a.recId, a);
  }
  const out: Recommendation[] = [];
  for (const rec of compute(input.decisions)) {
    const action = latest.get(rec.id);
    if (!action) {
      out.push(rec);
      continue;
    }
    const fresh = compute(input.decisions.filter((d) => d.decidedAt > action.at)).find((r) => r.id === rec.id);
    if (fresh) out.push(fresh);
  }
  return out;
}
