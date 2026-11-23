/**
 * Agent Performance Intelligence (plan 027). Pure: builds per-subtask
 * samples from recorded rows and scores each (agent, capability) pair over a
 * window, with Bayesian smoothing toward a prior and a minimum sample size
 * so a new agent starts at the neutral prior instead of being punished.
 * Shared by the backend (worker-facing scores, /team profile) and tested
 * directly.
 *
 * Factors (each a rate in [0,1]):
 *   success     done ÷ (done + failed)                         prior 0.80
 *   acceptance  accepted ÷ judged (acceptance status, gate results,
 *               requirement coverage of the subtask's requirements) prior 0.80
 *   retry/fix   retried (attempt > 1) or followed by a fix subtask   prior 0.20
 *   regression  a later fix / review fix touched files it wrote      prior 0.10
 *   efficiency  median duration and tokens per accepted result vs the
 *               capability's peers (0.5 = typical)                  prior 0.50
 *
 * Smoothed rate = (hits + prior × strength) ÷ (n + strength).
 * Below `minSamples` finished samples the score IS the prior score.
 */

export const PERFORMANCE_DEFAULTS = {
  windowDays: 30,
  minSamples: 3,
  priorStrength: 4,
  priors: { success: 0.8, acceptance: 0.8, retry: 0.2, regression: 0.1, efficiency: 0.5 },
  weights: { success: 0.35, acceptance: 0.25, retry: 0.15, regression: 0.15, efficiency: 0.1 },
} as const;

export type PerformanceOptions = {
  minSamples?: number;
  priorStrength?: number;
};

const FIX_ORIGINS = new Set(["fix", "review_fix"]);

export interface PerfSubtaskInput {
  taskId: string;
  key: string;
  capability: string;
  kind: string;
  status: string;
  origin: string | null;
  agentId: string | null;
  attempts: number;
  dependencies: string[];
  startedAt: number | null;
  completedAt: number | null;
  at: number;
  acceptanceStatus: string | null;
  gates: { pass: number; fail: number };
  requirementIds: string[];
}

export interface PerfExecutionInput {
  taskId: string;
  subtaskKey: string | null;
  agentId: string | null;
  attempt: number;
  filePaths: string[];
}

export interface PerfUsageInput {
  taskId: string;
  subtaskKey: string | null;
  agentId: string | null;
  tokens: number;
}

export interface PerfTaskInput {
  taskId: string;
  /** Requirement ids left uncovered / without evidence at the last coverage check. */
  gaps: string[];
}

export interface PerformanceSample {
  agentId: string;
  capability: string;
  taskId: string;
  subtaskKey: string;
  finished: boolean;
  success: boolean;
  /** null = no acceptance evidence. */
  accepted: boolean | null;
  retriedOrFixed: boolean;
  regression: boolean;
  durationMs: number | null;
  tokens: number | null;
  at: number;
}

export function normalizeCapabilityKey(capability: string): string {
  return capability.trim().toLowerCase().replace(/\s+/g, "-");
}

const FINISHED = new Set(["done", "completed", "failed"]);
const SUCCESS = new Set(["done", "completed"]);

/** One sample per agent-assigned, finished subtask. */
export function buildPerformanceSamples(input: {
  subtasks: PerfSubtaskInput[];
  executions: PerfExecutionInput[];
  usage: PerfUsageInput[];
  tasks?: PerfTaskInput[];
}): PerformanceSample[] {
  const filesByKey = new Map<string, Set<string>>();
  const attemptsByKey = new Map<string, number>();
  for (const e of input.executions) {
    if (!e.subtaskKey) continue;
    const key = `${e.taskId}::${e.subtaskKey}`;
    const set = filesByKey.get(key) ?? new Set<string>();
    for (const f of e.filePaths) set.add(f);
    filesByKey.set(key, set);
    attemptsByKey.set(key, Math.max(attemptsByKey.get(key) ?? 0, e.attempt));
  }
  const tokensByKey = new Map<string, number>();
  for (const u of input.usage) {
    if (!u.subtaskKey) continue;
    const key = `${u.taskId}::${u.subtaskKey}`;
    tokensByKey.set(key, (tokensByKey.get(key) ?? 0) + Math.max(0, u.tokens));
  }
  const gapsByTask = new Map((input.tasks ?? []).map((t) => [t.taskId, new Set(t.gaps)]));
  const byTask = new Map<string, PerfSubtaskInput[]>();
  for (const s of input.subtasks) {
    const list = byTask.get(s.taskId) ?? [];
    list.push(s);
    byTask.set(s.taskId, list);
  }

  const samples: PerformanceSample[] = [];
  for (const s of input.subtasks) {
    if (!s.agentId) continue;
    const key = `${s.taskId}::${s.key}`;
    const finished = FINISHED.has(s.status);
    const myFiles = filesByKey.get(key) ?? new Set<string>();
    const doneAt = s.completedAt ?? s.at;
    const fixes = (byTask.get(s.taskId) ?? []).filter(
      (other) => other.key !== s.key && other.origin !== null && FIX_ORIGINS.has(other.origin) && (other.startedAt ?? other.at) >= doneAt
    );
    const regression =
      myFiles.size > 0 &&
      fixes.some((fix) => [...(filesByKey.get(`${fix.taskId}::${fix.key}`) ?? [])].some((f) => myFiles.has(f)));
    const followedByFix = fixes.some((fix) => fix.dependencies.includes(s.key));
    const attempts = Math.max(s.attempts, attemptsByKey.get(key) ?? 0);

    let accepted: boolean | null = null;
    if (s.acceptanceStatus === "accepted") accepted = true;
    else if (s.acceptanceStatus === "rejected" || s.acceptanceStatus === "escalated") accepted = false;
    if (s.gates.fail > 0) accepted = false;
    else if (accepted === null && s.gates.pass > 0) accepted = true;
    const gaps = gapsByTask.get(s.taskId);
    if (gaps && s.requirementIds.some((id) => gaps.has(id))) accepted = false;

    const durationMs =
      s.startedAt !== null && s.completedAt !== null && s.completedAt >= s.startedAt ? s.completedAt - s.startedAt : null;
    samples.push({
      agentId: s.agentId,
      capability: normalizeCapabilityKey(s.capability),
      taskId: s.taskId,
      subtaskKey: s.key,
      finished,
      success: SUCCESS.has(s.status),
      accepted,
      retriedOrFixed: attempts > 1 || followedByFix,
      regression,
      durationMs,
      tokens: tokensByKey.has(key) ? tokensByKey.get(key)! : null,
      at: s.at,
    });
  }
  return samples;
}

export interface RateFactor {
  /** Smoothed rate used in the score. */
  rate: number;
  /** Unsmoothed rate (null = no evidence). */
  raw: number | null;
  /** Evidence count behind it. */
  n: number;
}

export interface PerformanceScore {
  agentId: string;
  capability: string;
  /** Finished samples in the window. */
  samples: number;
  /** Below the minimum sample size: score = prior. */
  insufficient: boolean;
  score: number;
  prior: number;
  factors: {
    success: RateFactor;
    acceptance: RateFactor;
    retry: RateFactor;
    regression: RateFactor;
    efficiency: { value: number; medianDurationMs: number | null; tokensPerAccepted: number | null };
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function smooth(hits: number, n: number, prior: number, strength: number): number {
  return (hits + prior * strength) / (n + strength);
}

function rateFactor(hits: number, n: number, prior: number, strength: number): RateFactor {
  return { rate: smooth(hits, n, prior, strength), raw: n > 0 ? hits / n : null, n };
}

/** 0.5 at parity with peers, 1 at twice as good, 0 at half. */
function relativeEfficiency(peer: number | null, mine: number | null): number | null {
  if (peer === null || mine === null || peer <= 0 || mine <= 0) return null;
  return Math.min(1, Math.max(0, Math.log2(peer / mine) / 2 + 0.5));
}

export const PRIOR_SCORE = (() => {
  const { priors: p, weights: w } = PERFORMANCE_DEFAULTS;
  return w.success * p.success + w.acceptance * p.acceptance + w.retry * (1 - p.retry) + w.regression * (1 - p.regression) + w.efficiency * p.efficiency;
})();

/** Score every (agent, capability) pair present in the samples. */
export function scorePerformance(samples: PerformanceSample[], options: PerformanceOptions = {}): PerformanceScore[] {
  const minSamples = options.minSamples ?? PERFORMANCE_DEFAULTS.minSamples;
  const strength = options.priorStrength ?? PERFORMANCE_DEFAULTS.priorStrength;
  const { priors, weights } = PERFORMANCE_DEFAULTS;
  const groups = new Map<string, PerformanceSample[]>();
  for (const s of samples) {
    if (!s.finished) continue;
    const key = `${s.agentId}::${s.capability}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  // Per-agent medians first, then each capability's peer median of those.
  const stats = new Map<string, { dur: number | null; tpa: number | null }>();
  for (const [key, list] of groups) {
    const dur = median(list.filter((s) => s.success && s.durationMs !== null).map((s) => s.durationMs!));
    const acceptedList = list.filter((s) => s.success && s.accepted !== false);
    const tokenSum = acceptedList.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
    const tpa = acceptedList.length > 0 && acceptedList.some((s) => s.tokens !== null) ? tokenSum / acceptedList.length : null;
    stats.set(key, { dur, tpa });
  }
  const peer = new Map<string, { dur: number | null; tpa: number | null }>();
  for (const key of stats.keys()) {
    const capability = key.slice(key.indexOf("::") + 2);
    if (peer.has(capability)) continue;
    const mates = [...stats.entries()].filter(([k]) => k.slice(k.indexOf("::") + 2) === capability).map(([, v]) => v);
    peer.set(capability, {
      dur: median(mates.map((m) => m.dur).filter((x): x is number => x !== null)),
      tpa: median(mates.map((m) => m.tpa).filter((x): x is number => x !== null)),
    });
  }

  const out: PerformanceScore[] = [];
  for (const [key, list] of groups) {
    const [agentId, capability] = [key.slice(0, key.indexOf("::")), key.slice(key.indexOf("::") + 2)];
    const n = list.length;
    const success = rateFactor(list.filter((s) => s.success).length, n, priors.success, strength);
    const judged = list.filter((s) => s.accepted !== null);
    const acceptance = rateFactor(judged.filter((s) => s.accepted === true).length, judged.length, priors.acceptance, strength);
    const retry = rateFactor(list.filter((s) => s.retriedOrFixed).length, n, priors.retry, strength);
    const regression = rateFactor(list.filter((s) => s.regression).length, n, priors.regression, strength);
    const st = stats.get(key)!;
    const pc = peer.get(capability)!;
    const effParts = [relativeEfficiency(pc.dur, st.dur), relativeEfficiency(pc.tpa, st.tpa)].filter((x): x is number => x !== null);
    const effRaw = effParts.length > 0 ? effParts.reduce((a, b) => a + b, 0) / effParts.length : priors.efficiency;
    // Efficiency is relative and noisy: shrink it toward 0.5 like a rate.
    const efficiency = smooth(effRaw * n, n, priors.efficiency, strength);
    const insufficient = n < minSamples;
    const computed =
      weights.success * success.rate +
      weights.acceptance * acceptance.rate +
      weights.retry * (1 - retry.rate) +
      weights.regression * (1 - regression.rate) +
      weights.efficiency * efficiency;
    out.push({
      agentId,
      capability,
      samples: n,
      insufficient,
      score: round(insufficient ? PRIOR_SCORE : computed),
      prior: round(PRIOR_SCORE),
      factors: {
        success,
        acceptance,
        retry,
        regression,
        efficiency: { value: efficiency, medianDurationMs: st.dur, tokensPerAccepted: st.tpa === null ? null : Math.round(st.tpa) },
      },
    });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.capability.localeCompare(b.capability));
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** A compact lookup the router consumes: `${agentId}::${capability}` → score. */
export function scoreIndex(scores: PerformanceScore[]): Record<string, PerformanceScore> {
  return Object.fromEntries(scores.map((s) => [`${s.agentId}::${s.capability}`, s]));
}
