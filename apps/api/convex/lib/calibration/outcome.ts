/**
 * Decision Outcome Calibration — outcome evaluation. Given one recorded
 * decision and the deterministic evidence of its task (subtask states,
 * acceptance gates, requirement coverage, QA/review verdicts, replans,
 * human approvals, tokens and duration vs the estimate), label it
 * good / suboptimal / bad / unknown with the factors that decided it.
 *
 * Pure: `buildTaskEvidence` takes plain rows, `labelDecision` takes the
 * evidence. No Convex APIs, no LLM, nothing here may throw.
 *
 * Labelling rules (first match wins inside each type; any "bad" factor
 * makes the label bad, else any "suboptimal" factor makes it suboptimal):
 *  - routing: unknown until the subtask is terminal (skipped = unknown).
 *      bad: subtask failed/blocked · acceptance rejected/blocked · its key
 *           is in a replan's failed set · a person rejected its change
 *      suboptimal: >1 attempt · acceptance escalated · review requested
 *           changes on files it wrote · a check that passed before it
 *           failed after it (regression) · tokens or duration ≥ 3× the
 *           estimate
 *      good: completed with no factor above
 *  - plan (version V): unknown until the task is terminal.
 *      bad: the user rejected the plan · task failed on V (V final) ·
 *           V final and coverage ended completed_with_gaps
 *      suboptimal: replaced by a replan · edited by the user · the
 *           planner missed requirements (coverage uncovered > 0 while V
 *           was active) · QA failed while V was active · task tokens ≥ 3×
 *           V's estimate
 *      good: otherwise
 *  - replan (from→to): unknown until terminal.
 *      bad: task failed with `to` final · nodes it added/modified failed
 *           again in a later replan and the task failed
 *      suboptimal: a later replan re-failed the same keys (repeated
 *           strategy) · the quality check rejected a repeated strategy
 *           first · `to` itself was replaced
 *      good: otherwise
 *  - escalation: repeated → suboptimal; task done → good; failed → bad.
 *  - qa_loop / review_loop: continue → next verdict passed = good, failed
 *      then later passed = suboptimal, never passed / same output repeated
 *      = bad. stop → repeated output = good; max rounds with findings
 *      still shrinking = suboptimal; else good.
 *  - engine: dispatch actions judged by the target subtask; complete by
 *      task status + coverage; replan/ask_user by the task; step limit = bad.
 *  - delegation: APPROVE/COMPLETE by task status; REJECT/REVISE done = good
 *      else suboptimal; BLOCKED = unknown.
 */

export type OutcomeLabel = "good" | "suboptimal" | "bad" | "unknown";
export const OUTCOME_LABELS: OutcomeLabel[] = ["good", "suboptimal", "bad", "unknown"];

/** Tokens or duration at least this many times the estimate count against a routing pick. */
export const OVERRUN_RATIO = 3;
/** Ratios outside [1/NOTE_RATIO, NOTE_RATIO] are noted as a factor (no label effect). */
export const NOTE_RATIO = 2;
/** Prior labelled picks of the same agent × capability before the history factor is shown. */
export const HISTORY_MIN = 3;

const TERMINAL_TASK = new Set(["done", "failed", "rejected", "cancelled"]);
const TERMINAL_SUBTASK = new Set(["completed", "failed", "blocked", "skipped"]);

// ─── Raw rows (plain shapes of the tables read) ───────────────────────────

export interface EvidenceRows {
  task: { status: string; requirementCoverage?: { outcome?: string; uncovered?: string[] } | null };
  subtasks: Array<{
    key: string;
    status: string;
    acceptanceStatus?: string | null;
    gateResults?: Array<{ status: string }> | null;
    attempts?: number;
    origin?: string | null;
    startedAt?: number | null;
    completedAt?: number | null;
  }>;
  plans: Array<{
    version: number;
    createdAt: number;
    createdBy: string;
    estimate?: unknown;
    payload?: unknown;
  }>;
  events: Array<{ type: string; payload?: unknown; subtaskKey?: string | null; createdAt: number }>;
  approvals: Array<{ kind: string; status: string; subtaskKey?: string | null; planVersion?: number | null }>;
  fileChanges: Array<{ filePath: string; subtaskKey?: string | null }>;
  usage: Array<{ subtaskKey?: string | null; inputTokens: number; outputTokens: number }>;
}

// ─── Evidence ──────────────────────────────────────────────────────────────

export interface SubtaskEvidence {
  key: string;
  status: string;
  terminal: boolean;
  acceptanceStatus: string | null;
  gatesFailed: number;
  attempts: number;
  origin: string | null;
  completedAt: number | null;
  tokens: number | null;
  estimateTokens: number | null;
  durationMs: number | null;
  estimateDurationMs: number | null;
  reviewFindings: number;
  rejectedChanges: number;
  regression: string | null;
}

export interface TaskEvidence {
  status: string;
  terminal: boolean;
  complexity: string | null;
  subtasks: Map<string, SubtaskEvidence>;
  finalPlanVersion: number | null;
  planVersions: Array<{ version: number; createdAt: number; createdBy: string; estimateTokens: number | null }>;
  replans: Array<{ fromVersion: number; toVersion: number; failed: string[]; changed: string[]; at: number }>;
  replanRejections: Array<{ at: number; codes: string[] }>;
  coverage: Array<{ at: number; uncovered: number; missingEvidence: number }>;
  finalCoverage: string | null;
  qa: Array<{ at: number; passed: boolean; findings: number }>;
  review: Array<{ at: number; passed: boolean; findings: number }>;
  repeatedStops: Array<{ at: number; loop: string }>;
  planRejected: boolean;
  totalTokens: number;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function count(value: unknown): number {
  return Array.isArray(value) ? value.length : typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Normalised file path for matching review findings to the subtask that wrote the file. */
function normPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

export function buildTaskEvidence(rows: EvidenceRows): TaskEvidence {
  const events = [...rows.events].sort((a, b) => a.createdAt - b.createdAt);
  const plans = [...rows.plans].sort((a, b) => a.version - b.version);

  // Latest estimate per subtask key (a key keeps its estimate across versions).
  const estimateByKey = new Map<string, { tokens: number; durationMs: number | null }>();
  const planVersions: TaskEvidence["planVersions"] = [];
  for (const plan of plans) {
    const estimate = obj(plan.estimate);
    const total = obj(estimate.tokens).total;
    planVersions.push({
      version: plan.version,
      createdAt: plan.createdAt,
      createdBy: plan.createdBy,
      estimateTokens: typeof total === "number" ? total : null,
    });
    for (const entry of Array.isArray(estimate.perSubtask) ? estimate.perSubtask : []) {
      const e = obj(entry);
      if (typeof e.key !== "string") continue;
      const tokens = (typeof e.inputTokens === "number" ? e.inputTokens : 0) + (typeof e.outputTokens === "number" ? e.outputTokens : 0);
      const mid = obj(e.durationMs).mid;
      estimateByKey.set(e.key, { tokens, durationMs: typeof mid === "number" ? mid : null });
    }
  }

  const tokensByKey = new Map<string, number>();
  let totalTokens = 0;
  for (const u of rows.usage) {
    const t = (u.inputTokens || 0) + (u.outputTokens || 0);
    totalTokens += t;
    if (u.subtaskKey) tokensByKey.set(u.subtaskKey, (tokensByKey.get(u.subtaskKey) ?? 0) + t);
  }

  // Review findings → the subtask(s) that wrote the named file.
  const writersByPath = new Map<string, Set<string>>();
  for (const change of rows.fileChanges) {
    if (!change.subtaskKey) continue;
    const p = normPath(change.filePath);
    const set = writersByPath.get(p) ?? new Set<string>();
    set.add(change.subtaskKey);
    writersByPath.set(p, set);
  }
  const reviewFindingsByKey = new Map<string, number>();
  const rejectedByKey = new Map<string, number>();
  for (const approval of rows.approvals) {
    if (approval.status === "rejected" && approval.subtaskKey && approval.kind !== "plan") {
      rejectedByKey.set(approval.subtaskKey, (rejectedByKey.get(approval.subtaskKey) ?? 0) + 1);
    }
  }

  // Check regressions: a check label that passed and later failed.
  const passedChecks = new Map<string, number>();
  const regressions: Array<{ label: string; passedAt: number; failedAt: number }> = [];

  let complexity: string | null = null;
  const replans: TaskEvidence["replans"] = [];
  const replanRejections: TaskEvidence["replanRejections"] = [];
  const coverage: TaskEvidence["coverage"] = [];
  const qa: TaskEvidence["qa"] = [];
  const review: TaskEvidence["review"] = [];
  const repeatedStops: TaskEvidence["repeatedStops"] = [];

  for (const event of events) {
    const p = obj(event.payload);
    switch (event.type) {
      case "task.classified":
        if (typeof p.complexity === "string") complexity = p.complexity;
        break;
      case "plan.replan_diff":
        if (typeof p.fromVersion === "number" && typeof p.toVersion === "number") {
          replans.push({
            fromVersion: p.fromVersion,
            toVersion: p.toVersion,
            failed: strings(p.failed),
            changed: [...strings(p.added), ...strings(p.modified)],
            at: event.createdAt,
          });
        }
        break;
      case "plan.replan_rejected":
        replanRejections.push({
          at: event.createdAt,
          codes: (Array.isArray(p.violations) ? p.violations : []).map((v) => String(obj(v).code ?? "")),
        });
        break;
      case "requirements.coverage":
        coverage.push({ at: event.createdAt, uncovered: count(p.uncovered), missingEvidence: count(p.missingEvidence) });
        break;
      case "qa.passed":
        qa.push({ at: event.createdAt, passed: true, findings: 0 });
        break;
      case "qa.failed":
        qa.push({ at: event.createdAt, passed: false, findings: count(p.findings) });
        break;
      case "review.approved":
        review.push({ at: event.createdAt, passed: true, findings: 0 });
        break;
      case "review.requested_changes": {
        const findings = Array.isArray(p.findings) ? p.findings : [];
        review.push({ at: event.createdAt, passed: false, findings: findings.length });
        for (const finding of findings) {
          const path = obj(finding).filePath;
          if (typeof path !== "string") continue;
          for (const key of writersByPath.get(normPath(path)) ?? []) {
            reviewFindingsByKey.set(key, (reviewFindingsByKey.get(key) ?? 0) + 1);
          }
        }
        break;
      }
      case "stall.repeated_output": {
        const loop = obj(p.detail).loop;
        if (typeof loop === "string") repeatedStops.push({ at: event.createdAt, loop });
        break;
      }
      case "task.check": {
        const label = typeof p.label === "string" ? p.label : null;
        if (!label) break;
        if (p.status === "passed") passedChecks.set(label, event.createdAt);
        else if (p.status === "failed" && passedChecks.has(label)) {
          regressions.push({ label, passedAt: passedChecks.get(label)!, failedAt: event.createdAt });
          passedChecks.delete(label);
        }
        break;
      }
    }
  }

  const subtasks = new Map<string, SubtaskEvidence>();
  for (const s of rows.subtasks) {
    const estimate = estimateByKey.get(s.key);
    const duration =
      typeof s.startedAt === "number" && typeof s.completedAt === "number" && s.completedAt >= s.startedAt
        ? s.completedAt - s.startedAt
        : null;
    const regression =
      typeof s.completedAt === "number"
        ? regressions.find((r) => r.passedAt <= s.completedAt! && r.failedAt >= s.completedAt!)
        : undefined;
    subtasks.set(s.key, {
      key: s.key,
      status: s.status,
      terminal: TERMINAL_SUBTASK.has(s.status),
      acceptanceStatus: s.acceptanceStatus ?? null,
      gatesFailed: (s.gateResults ?? []).filter((g) => g.status === "fail").length,
      attempts: s.attempts ?? 0,
      origin: s.origin ?? null,
      completedAt: s.completedAt ?? null,
      tokens: tokensByKey.has(s.key) ? tokensByKey.get(s.key)! : null,
      estimateTokens: estimate ? estimate.tokens : null,
      durationMs: duration,
      estimateDurationMs: estimate?.durationMs ?? null,
      reviewFindings: reviewFindingsByKey.get(s.key) ?? 0,
      rejectedChanges: rejectedByKey.get(s.key) ?? 0,
      regression: regression ? regression.label : null,
    });
  }

  return {
    status: rows.task.status,
    terminal: TERMINAL_TASK.has(rows.task.status),
    complexity,
    subtasks,
    finalPlanVersion: plans.length > 0 ? plans[plans.length - 1].version : null,
    planVersions,
    replans,
    replanRejections,
    coverage,
    finalCoverage: rows.task.requirementCoverage?.outcome ?? null,
    qa,
    review,
    repeatedStops,
    planRejected:
      rows.task.status === "rejected" || rows.approvals.some((a) => a.kind === "plan" && a.status === "rejected"),
    totalTokens,
  };
}

// ─── Labelling ─────────────────────────────────────────────────────────────

export interface DecisionForLabel {
  type: string;
  subtaskKey?: string | null;
  chosen: string;
  decidedAt: number;
  planVersion?: number | null;
  agentName?: string | null;
  capability?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface DecisionOutcome {
  label: OutcomeLabel;
  factors: string[];
  /** True once the task is terminal: the label will not change any more. */
  final: boolean;
  signals: {
    tokensRatio?: number;
    durationRatio?: number;
    role?: string | null;
    complexity?: string | null;
    plannerMiss?: boolean;
    hadRequirements?: boolean;
  };
}

/** Prior labelled picks of the same agent × capability (for the history factor). */
export interface RoutingHistory {
  bad: number;
  total: number;
}

class Verdict {
  bad: string[] = [];
  sub: string[] = [];
  notes: string[] = [];
  label(fallback: OutcomeLabel): OutcomeLabel {
    if (this.bad.length > 0) return "bad";
    if (this.sub.length > 0) return "suboptimal";
    return fallback;
  }
  factors(): string[] {
    return [...this.bad, ...this.sub, ...this.notes];
  }
}

export function ratio(actual: number | null, estimate: number | null): number | undefined {
  if (actual === null || estimate === null || estimate <= 0 || actual < 0) return undefined;
  return Math.round((actual / estimate) * 100) / 100;
}

function fmtRatio(r: number): string {
  return r >= 1 ? `${r.toFixed(1)}×` : `${(1 / r).toFixed(1)}× under`;
}

function labelRouting(d: DecisionForLabel, ev: TaskEvidence, history?: RoutingHistory): DecisionOutcome {
  const final = ev.terminal;
  const key = d.subtaskKey ?? "";
  const s = ev.subtasks.get(key);
  const v = new Verdict();
  const signals: DecisionOutcome["signals"] = { complexity: ev.complexity };
  if (history && history.total >= HISTORY_MIN && history.bad * 2 >= history.total) {
    v.notes.push(`${d.agentName ?? "agent"} failed ${d.capability ?? "this capability"} ${history.bad}/${history.total} times before`);
  }
  if (!s || !s.terminal || s.status === "skipped") {
    return { label: "unknown", factors: [s ? (s.status === "skipped" ? "subtask skipped" : "subtask not finished") : "subtask not found", ...v.notes], final, signals };
  }
  if (s.status === "failed") v.bad.push("subtask failed");
  if (s.status === "blocked") v.bad.push("subtask blocked");
  if (s.acceptanceStatus === "rejected" || s.acceptanceStatus === "blocked") v.bad.push(`acceptance ${s.acceptanceStatus}`);
  const replan = ev.replans.find((r) => r.failed.includes(key));
  if (replan) v.bad.push(`caused replan v${replan.fromVersion}→v${replan.toVersion}`);
  if (s.rejectedChanges > 0) v.bad.push(`a person rejected ${s.rejectedChanges} change(s)`);
  if (s.attempts > 1) v.sub.push(`needed ${s.attempts} attempts`);
  if (s.acceptanceStatus === "escalated") v.sub.push("escalated");
  if (s.gatesFailed > 0 && v.bad.length === 0) v.notes.push(`${s.gatesFailed} non-required gate(s) failed`);
  if (s.reviewFindings > 0) v.sub.push(`review requested changes on its files (${s.reviewFindings})`);
  if (s.regression) v.sub.push(`regression: ${s.regression} passed before and failed after`);
  const tr = ratio(s.tokens, s.estimateTokens);
  const dr = ratio(s.durationMs, s.estimateDurationMs);
  if (tr !== undefined) signals.tokensRatio = tr;
  if (dr !== undefined) signals.durationRatio = dr;
  for (const [name, r] of [["tokens", tr], ["duration", dr]] as const) {
    if (r === undefined) continue;
    if (r >= OVERRUN_RATIO) v.sub.push(`${name} ${fmtRatio(r)} the estimate`);
    else if (r >= NOTE_RATIO || r <= 1 / NOTE_RATIO) v.notes.push(`${name} estimate off by ${fmtRatio(r)}`);
  }
  return { label: v.label(s.status === "completed" ? "good" : "unknown"), factors: v.factors(), final, signals };
}

function labelPlan(d: DecisionForLabel, ev: TaskEvidence): DecisionOutcome {
  const version = d.planVersion ?? null;
  const v = new Verdict();
  const signals: DecisionOutcome["signals"] = { complexity: ev.complexity };
  const self = ev.planVersions.find((p) => p.version === version);
  const next = ev.planVersions.find((p) => version !== null && p.version > version);
  const activeFrom = self?.createdAt ?? d.decidedAt;
  const activeTo = next?.createdAt ?? Number.POSITIVE_INFINITY;
  const active = <T extends { at: number }>(rows: T[]) => rows.filter((r) => r.at >= activeFrom && r.at < activeTo);

  const checks = active(ev.coverage);
  signals.hadRequirements = checks.length > 0;
  const missed = checks.find((c) => c.uncovered > 0);
  signals.plannerMiss = Boolean(missed);
  if (!ev.terminal) {
    return { label: "unknown", factors: ["task still running"], final: false, signals };
  }
  const isFinal = version !== null && version === ev.finalPlanVersion;
  if (ev.planRejected && (isFinal || ev.status === "rejected")) v.bad.push("rejected by the user");
  if (isFinal && ev.status === "failed") v.bad.push("task failed on this plan");
  if (isFinal && ev.finalCoverage === "completed_with_gaps") v.bad.push("ended with requirement gaps");
  const replacedBy = ev.replans.find((r) => r.fromVersion === version);
  if (replacedBy) v.sub.push(`replaced by replan to v${replacedBy.toVersion}`);
  if (next && next.createdBy === "user") v.sub.push("edited by the user");
  if (missed) v.sub.push(`planner missed ${missed.uncovered} requirement(s)`);
  const qaFails = active(ev.qa).filter((q) => !q.passed).length;
  if (qaFails > 0) v.sub.push(`QA failed ${qaFails} time(s)`);
  if (isFinal) {
    const tr = ratio(ev.totalTokens, self?.estimateTokens ?? null);
    if (tr !== undefined) {
      signals.tokensRatio = tr;
      if (tr >= OVERRUN_RATIO) v.sub.push(`task tokens ${fmtRatio(tr)} the estimate`);
    }
  }
  return { label: v.label("good"), factors: v.factors(), final: true, signals };
}

function labelReplan(d: DecisionForLabel, ev: TaskEvidence): DecisionOutcome {
  const meta = d.meta ?? {};
  const from = typeof meta.fromVersion === "number" ? meta.fromVersion : null;
  const to = typeof meta.toVersion === "number" ? meta.toVersion : d.planVersion ?? null;
  const failed = strings(meta.failed);
  const changed = [...strings(meta.added), ...strings(meta.modified)];
  const v = new Verdict();
  if (!ev.terminal) return { label: "unknown", factors: ["task still running"], final: false, signals: {} };
  const later = ev.replans.filter((r) => r.fromVersion !== from && r.at > d.decidedAt);
  const repeated = later.find((r) => r.failed.some((k) => failed.includes(k)));
  const newFailed = later.find((r) => r.failed.some((k) => changed.includes(k)));
  const priorReject = ev.replanRejections.find(
    (r) => r.at <= d.decidedAt && r.codes.includes("repeated_failed_strategy")
  );
  if (ev.status !== "done" && to !== null && to === ev.finalPlanVersion) v.bad.push("task failed after this replan");
  if (newFailed && ev.status !== "done") v.bad.push(`replanned nodes failed again (v${newFailed.fromVersion}→v${newFailed.toVersion})`);
  if (repeated) v.sub.push("replan repeated strategy: the same nodes failed again");
  if (priorReject) v.sub.push("quality check rejected a repeated strategy first");
  if (!repeated && later.some((r) => r.fromVersion === to)) v.sub.push(`v${to} was replaced again`);
  return { label: v.label("good"), factors: v.factors(), final: true, signals: {} };
}

function byTask(ev: TaskEvidence, v: Verdict, fallback: OutcomeLabel = "good"): OutcomeLabel {
  if (ev.status === "done") return v.label(fallback);
  v.bad.push(ev.status === "rejected" ? "task rejected" : "task failed");
  return v.label(fallback);
}

function labelEscalation(d: DecisionForLabel, ev: TaskEvidence): DecisionOutcome {
  if (!ev.terminal) return { label: "unknown", factors: ["task still running"], final: false, signals: {} };
  const v = new Verdict();
  if (d.meta?.repeated === true) v.sub.push("repeated escalation");
  return { label: byTask(ev, v), factors: v.factors(), final: true, signals: {} };
}

function labelLoop(d: DecisionForLabel, ev: TaskEvidence): DecisionOutcome {
  const loop = d.type === "qa_loop" ? "qa" : "review";
  const verdicts = loop === "qa" ? ev.qa : ev.review;
  const v = new Verdict();
  if (d.chosen === "stop") {
    const reason = d.meta?.stopReason;
    if (reason === "repeated_output") {
      v.notes.push("stopped a loop that repeated the same output");
      return { label: "good", factors: v.factors(), final: ev.terminal, signals: {} };
    }
    const before = verdicts.filter((x) => x.at <= d.decidedAt && !x.passed);
    const last = before[before.length - 1];
    const prev = before[before.length - 2];
    if (last && prev && last.findings < prev.findings) {
      v.sub.push(`findings were still shrinking (${prev.findings}→${last.findings})`);
    } else {
      v.notes.push("no progress across fix rounds");
    }
    return { label: v.label("good"), factors: v.factors(), final: ev.terminal, signals: {} };
  }
  // continue: judged by the verdicts after the fix round started.
  const after = verdicts.filter((x) => x.at > d.decidedAt);
  const repeatedStop = ev.repeatedStops.find((x) => x.loop === loop && x.at > d.decidedAt);
  if (after.length === 0) {
    if (repeatedStop) {
      v.bad.push("same findings repeated on unchanged code");
      return { label: "bad", factors: v.factors(), final: ev.terminal, signals: {} };
    }
    return { label: "unknown", factors: [ev.terminal ? "no verdict after the fix round" : "fix round running"], final: ev.terminal, signals: {} };
  }
  if (after[0].passed) return { label: "good", factors: ["next verdict passed"], final: ev.terminal, signals: {} };
  if (after.some((x) => x.passed)) {
    v.sub.push("needed another fix round");
  } else if (ev.terminal || repeatedStop) {
    v.bad.push(repeatedStop ? "same findings repeated on unchanged code" : "fix round did not resolve the findings");
  } else {
    return { label: "unknown", factors: ["still failing; loop running"], final: false, signals: {} };
  }
  return { label: v.label("good"), factors: v.factors(), final: ev.terminal, signals: {} };
}

function labelEngine(d: DecisionForLabel, ev: TaskEvidence): DecisionOutcome {
  const meta = d.meta ?? {};
  const action = typeof meta.action === "string" ? meta.action : d.chosen;
  const v = new Verdict();
  if (meta.expectedOutcome === "decision:step_limit") {
    return { label: "bad", factors: ["hit the decision step limit"], final: true, signals: {} };
  }
  const target = typeof meta.target === "string" ? meta.target : null;
  if (["execute", "delegate", "call_agent", "parallel"].includes(action) && target) {
    const s = ev.subtasks.get(target);
    if (s && s.terminal) {
      if (s.status === "failed" || s.status === "blocked") v.bad.push(`target ${target} ${s.status}`);
      if (s.acceptanceStatus === "rejected" || s.acceptanceStatus === "blocked") v.bad.push(`target acceptance ${s.acceptanceStatus}`);
      if (s.status === "skipped") return { label: "unknown", factors: ["target skipped"], final: ev.terminal, signals: {} };
      return { label: v.label("good"), factors: v.factors(), final: ev.terminal, signals: {} };
    }
    if (!ev.terminal) return { label: "unknown", factors: ["target not finished"], final: false, signals: {} };
  }
  if (!ev.terminal) return { label: "unknown", factors: ["task still running"], final: false, signals: {} };
  if (action === "complete" && ev.finalCoverage === "completed_with_gaps") v.bad.push("completed with requirement gaps");
  return { label: byTask(ev, v), factors: v.factors(), final: true, signals: {} };
}

function labelDelegation(d: DecisionForLabel, ev: TaskEvidence): DecisionOutcome {
  if (!ev.terminal) return { label: "unknown", factors: ["task still running"], final: false, signals: {} };
  const v = new Verdict();
  if (d.chosen === "BLOCKED") return { label: "unknown", factors: ["blocked; outcome not attributable"], final: true, signals: {} };
  if (d.chosen === "REJECT" || d.chosen === "REVISE") {
    if (ev.status === "done") return { label: "good", factors: ["the correction led to a finished task"], final: true, signals: {} };
    v.sub.push("task did not finish after the correction");
    return { label: v.label("good"), factors: v.factors(), final: true, signals: {} };
  }
  return { label: byTask(ev, v), factors: v.factors(), final: true, signals: {} };
}

export function labelDecision(d: DecisionForLabel, ev: TaskEvidence, history?: RoutingHistory): DecisionOutcome {
  switch (d.type) {
    case "routing":
      return labelRouting(d, ev, history);
    case "plan":
      return labelPlan(d, ev);
    case "replan":
      return labelReplan(d, ev);
    case "escalation":
      return labelEscalation(d, ev);
    case "qa_loop":
    case "review_loop":
      return labelLoop(d, ev);
    case "engine":
      return labelEngine(d, ev);
    case "delegation":
      return labelDelegation(d, ev);
  }
  return { label: "unknown", factors: ["unknown decision type"], final: ev.terminal, signals: {} };
}
