/**
 * Task Estimator. A pure, deterministic estimate of what a plan will cost
 * before it runs — no LLM call. Shared by the worker (which computes it
 * right after planning, when it knows each subtask's routed role and the
 * resolver's model per agent) and the backend (which recomputes it after a
 * user edits the plan).
 *
 * Inputs: the plan's subtasks (key, kind, role, dependencies), recent
 * per-subtask usage samples from this project, and the expected model (with
 * registry pricing, when known) per role. Per subtask:
 *   tokens   = median input / output tokens of samples with the same
 *              kind + role (≥ MIN_SAMPLES), else the same kind, else
 *              DEFAULT_TOKENS[kind]
 *   duration = p25 / p50 / p75 of matching sample durations, else a
 *              default with a fixed spread
 *   cost     = tokens × the expected model's registry price, when priced
 * Totals: tokens and cost are sums; the duration range is the DAG critical
 * path (low) to max(critical path, serial sum / maxConcurrency) (high).
 *
 * It is an estimate, not a guarantee: review/QA/fix rounds the runner adds
 * later, retries and the planner's own call are not in it.
 */

export interface EstimateSample {
  kind: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number | null;
}

export interface EstimateSubtaskInput {
  key: string;
  kind: string;
  /** Role the subtask is (or would be) routed to; null when unroutable. */
  role: string | null;
  dependencies: string[];
}

export interface EstimateModel {
  model: string;
  inputPricePer1k?: number | null;
  outputPricePer1k?: number | null;
}

export type EstimateSource = "role" | "kind" | "default";

export interface PlanEstimate {
  version: 1;
  subtaskCount: number;
  agentCount: number;
  roles: Array<{ role: string; model: string | null; subtasks: number }>;
  /** The expected model (and pricing) per role the estimate used; reused when a user edit recomputes it. */
  models: Record<string, EstimateModel>;
  tokens: { input: number; output: number; total: number };
  /** Summed priced cost (USD); null when no subtask's model has pricing. */
  cost: number | null;
  /** True when some subtasks had no pricing (cost covers only the priced ones). */
  costPartial: boolean;
  durationMs: { low: number; high: number };
  basis: { fromRole: number; fromKind: number; fromDefault: number; samples: number };
  perSubtask: Array<{
    key: string;
    kind: string;
    role: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    durationMs: { low: number; mid: number; high: number };
    source: EstimateSource;
  }>;
  computedAt: number;
}

/** Fewer matching samples than this and the estimate widens to the next tier. */
export const MIN_SAMPLES = 3;
/** How many recent usage rows per project the history is built from. */
export const HISTORY_ROWS = 400;

export const DEFAULT_TOKENS: Record<string, { input: number; output: number }> = {
  code_change: { input: 30_000, output: 6_000 },
  review: { input: 15_000, output: 2_000 },
  qa: { input: 12_000, output: 2_000 },
  research: { input: 20_000, output: 3_000 },
  analysis: { input: 12_000, output: 2_000 },
  audit: { input: 15_000, output: 2_500 },
  shell: { input: 6_000, output: 1_000 },
};
const FALLBACK_TOKENS = { input: 15_000, output: 2_500 };

export const DEFAULT_DURATION_MS: Record<string, number> = {
  code_change: 180_000,
  review: 90_000,
  qa: 120_000,
  research: 120_000,
  analysis: 90_000,
  audit: 120_000,
  shell: 30_000,
};
const FALLBACK_DURATION_MS = 90_000;
/** Spread applied to a default duration (no history): low / high factors. */
const DEFAULT_SPREAD = { low: 0.6, high: 1.6 };

/** Quantile of a sorted copy (nearest-rank on the lower median for p50). */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

function costOf(model: EstimateModel | undefined, input: number, output: number): number | null {
  if (!model) return null;
  const inPrice = model.inputPricePer1k;
  const outPrice = model.outputPricePer1k;
  if (typeof inPrice !== "number" || typeof outPrice !== "number") return null;
  return (input / 1000) * inPrice + (output / 1000) * outPrice;
}

/** Longest dependency path, by per-node weight. Unknown deps are ignored. */
export function criticalPath(
  subtasks: Array<{ key: string; dependencies: string[] }>,
  weight: (key: string) => number
): number {
  const byKey = new Map(subtasks.map((s) => [s.key, s]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const finish = (key: string): number => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return 0; // cycle guard (validated plans have none)
    visiting.add(key);
    let start = 0;
    for (const dep of byKey.get(key)?.dependencies ?? []) {
      if (byKey.has(dep)) start = Math.max(start, finish(dep));
    }
    visiting.delete(key);
    const value = start + weight(key);
    memo.set(key, value);
    return value;
  };
  let longest = 0;
  for (const s of subtasks) longest = Math.max(longest, finish(s.key));
  return longest;
}

export function estimatePlan(input: {
  subtasks: EstimateSubtaskInput[];
  samples: EstimateSample[];
  /** Expected model per role (from the resolver assignment). */
  models: Record<string, EstimateModel | undefined>;
  maxConcurrency?: number;
  now: number;
}): PlanEstimate {
  const perSubtask: PlanEstimate["perSubtask"] = [];
  const basis = { fromRole: 0, fromKind: 0, fromDefault: 0, samples: input.samples.length };
  const roleNorm = (role: string | null) => (role ?? "").trim().toLowerCase();

  for (const subtask of input.subtasks) {
    const role = roleNorm(subtask.role);
    const byRole = input.samples.filter((s) => s.kind === subtask.kind && roleNorm(s.role) === role && role !== "");
    const byKind = input.samples.filter((s) => s.kind === subtask.kind);
    let source: EstimateSource;
    let pool: EstimateSample[];
    if (byRole.length >= MIN_SAMPLES) {
      source = "role";
      pool = byRole;
    } else if (byKind.length >= MIN_SAMPLES) {
      source = "kind";
      pool = byKind;
    } else {
      source = "default";
      pool = [];
    }
    let inputTokens: number;
    let outputTokens: number;
    if (pool.length > 0) {
      inputTokens = Math.round(median(pool.map((s) => s.inputTokens)));
      outputTokens = Math.round(median(pool.map((s) => s.outputTokens)));
    } else {
      const fallback = DEFAULT_TOKENS[subtask.kind] ?? FALLBACK_TOKENS;
      inputTokens = fallback.input;
      outputTokens = fallback.output;
    }
    const durations = pool
      .map((s) => s.durationMs)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d > 0);
    let durationMs: { low: number; mid: number; high: number };
    if (durations.length >= MIN_SAMPLES) {
      durationMs = {
        low: Math.round(quantile(durations, 0.25)),
        mid: Math.round(quantile(durations, 0.5)),
        high: Math.round(quantile(durations, 0.75)),
      };
    } else {
      const base = DEFAULT_DURATION_MS[subtask.kind] ?? FALLBACK_DURATION_MS;
      durationMs = {
        low: Math.round(base * DEFAULT_SPREAD.low),
        mid: base,
        high: Math.round(base * DEFAULT_SPREAD.high),
      };
    }
    const model = role ? input.models[role] : undefined;
    if (source === "role") basis.fromRole += 1;
    else if (source === "kind") basis.fromKind += 1;
    else basis.fromDefault += 1;
    perSubtask.push({
      key: subtask.key,
      kind: subtask.kind,
      role: subtask.role,
      model: model?.model ?? null,
      inputTokens,
      outputTokens,
      cost: costOf(model, inputTokens, outputTokens),
      durationMs,
      source,
    });
  }

  const tokensIn = perSubtask.reduce((sum, s) => sum + s.inputTokens, 0);
  const tokensOut = perSubtask.reduce((sum, s) => sum + s.outputTokens, 0);
  const priced = perSubtask.filter((s) => s.cost !== null);
  const cost = priced.length > 0 ? priced.reduce((sum, s) => sum + (s.cost ?? 0), 0) : null;

  const byKey = new Map(perSubtask.map((s) => [s.key, s]));
  const low = criticalPath(input.subtasks, (key) => byKey.get(key)?.durationMs.low ?? 0);
  const highPath = criticalPath(input.subtasks, (key) => byKey.get(key)?.durationMs.high ?? 0);
  const serialHigh = perSubtask.reduce((sum, s) => sum + s.durationMs.high, 0);
  const concurrency = Math.max(1, Math.floor(input.maxConcurrency ?? 2));
  const high = Math.max(highPath, Math.round(serialHigh / concurrency));

  const roles = new Map<string, { role: string; model: string | null; subtasks: number }>();
  for (const s of perSubtask) {
    const role = roleNorm(s.role) || "unassigned";
    const entry = roles.get(role) ?? { role, model: s.model, subtasks: 0 };
    entry.subtasks += 1;
    roles.set(role, entry);
  }

  return {
    version: 1,
    subtaskCount: perSubtask.length,
    agentCount: [...roles.keys()].filter((role) => role !== "unassigned").length,
    roles: [...roles.values()],
    models: Object.fromEntries(
      Object.entries(input.models).filter((entry): entry is [string, EstimateModel] => entry[1] !== undefined)
    ),
    tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
    cost,
    costPartial: cost !== null && priced.length < perSubtask.length,
    durationMs: { low, high },
    basis,
    perSubtask,
    computedAt: input.now,
  };
}

/**
 * Build samples from rows (already joined): one sample per (task, subtask)
 * with summed tokens. Rows without a subtask kind or role are skipped.
 */
export function samplesFromUsage(
  rows: Array<{
    taskId: string;
    subtaskKey: string;
    kind: string | null;
    role: string | null;
    inputTokens: number;
    outputTokens: number;
    durationMs?: number | null;
  }>
): EstimateSample[] {
  const grouped = new Map<string, EstimateSample>();
  for (const row of rows) {
    if (!row.kind || !row.role) continue;
    const key = `${row.taskId}::${row.subtaskKey}`;
    const current = grouped.get(key);
    if (current) {
      current.inputTokens += row.inputTokens;
      current.outputTokens += row.outputTokens;
      if (typeof row.durationMs === "number") current.durationMs = Math.max(current.durationMs ?? 0, row.durationMs);
    } else {
      grouped.set(key, {
        kind: row.kind,
        role: row.role,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        durationMs: row.durationMs ?? null,
      });
    }
  }
  return [...grouped.values()];
}

/** "Est. ~120k tokens · ~$0.42 · ~4–9m" — the one-line label. */
export function formatEstimateLine(estimate: Pick<PlanEstimate, "tokens" | "cost" | "costPartial" | "durationMs">): string {
  const tokens = estimate.tokens.total;
  const tokenText =
    tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
  const parts = [`Est. ~${tokenText} tokens`];
  if (estimate.cost !== null) {
    const cost = estimate.cost < 0.01 ? "<$0.01" : `$${estimate.cost.toFixed(2)}`;
    parts.push(`~${cost}${estimate.costPartial ? "+" : ""}`);
  }
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  const lo = minutes(estimate.durationMs.low);
  const hi = minutes(estimate.durationMs.high);
  parts.push(lo === hi ? `~${lo}m` : `~${lo}–${hi}m`);
  return parts.join(" · ");
}
