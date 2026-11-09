/**
 * Agent performance profile: workload.byRole narrowed to ONE agent, plus
 * outcome measures. Pure (no Convex APIs); `orgIntel.agentProfile` loads
 * the rows with bounded index reads. Every number is a count or sum of
 * stored fields:
 *
 *  - subtasks by status, success rate = done / (done + failed).
 *  - duration: completed executions (start → end), else the subtask's own
 *    start/end when it never had an execution row.
 *  - tokens / cost: tokenUsage rows attributed to the agent.
 *  - fixes: fix subtasks it ran (origin fix / review_fix, or a fix_ key).
 *  - review / QA of its work: in tasks where it ran implementation work,
 *    whether the FIRST review (QA) verdict was approved (passed).
 *  - verdicts given: review / QA verdict events in tasks where it ran the
 *    review (QA) subtask.
 *  - evals: the latest evaluation of each task it worked on.
 */
import { DAY_MS } from "./workload";

const FIX_ORIGINS = new Set(["fix", "review_fix"]);

export interface ProfileSubtaskInput {
  taskId: string;
  taskTitle?: string | null;
  key: string;
  title: string;
  kind: string;
  status: string;
  origin?: string | null;
  at: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ProfileExecutionInput {
  taskId: string;
  subtaskKey?: string | null;
  status: string;
  attempt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  at: number;
}

export interface ProfileUsageInput {
  inputTokens: number;
  outputTokens: number;
  estimatedCost?: number | null;
  estimated?: boolean | null;
  at: number;
}

/** review.approved | review.requested_changes | qa.passed | qa.failed | qa.blocked */
export interface ProfileVerdictInput {
  taskId: string;
  type: string;
  at: number;
}

export interface ProfileEvaluationInput {
  taskId: string;
  verdict: "passed" | "failed" | "inconclusive";
  at: number;
}

export interface AgentProfile {
  sinceDays: number;
  since: number;
  subtasks: {
    total: number;
    status: { done: number; failed: number; blocked: number; running: number; pending: number; skipped: number };
    successRate: number | null;
  };
  duration: { timedRuns: number; medianMs: number | null; avgMs: number | null; totalMs: number };
  executions: { total: number; retries: number };
  tokens: { input: number; output: number; total: number; cost: number | null; estimated: boolean; calls: number };
  fixes: number;
  reviewRuns: number;
  qaRuns: number;
  workReviewed: { tasks: number; firstPass: number; rate: number | null };
  workQaed: { tasks: number; firstPass: number; rate: number | null };
  verdictsGiven: {
    review: { approved: number; changesRequested: number };
    qa: { passed: number; failed: number; blocked: number };
  };
  evals: { tasks: number; passed: number; failed: number; inconclusive: number };
  chatReplies: number;
  recent: Array<{
    taskId: string;
    taskTitle: string | null;
    key: string;
    title: string;
    kind: string;
    status: string;
    at: number;
    durationMs: number | null;
  }>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
}

function statusSlot(status: string): keyof AgentProfile["subtasks"]["status"] {
  switch (status) {
    case "completed":
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "running":
    case "waiting_approval":
      return "running";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

const isRound = (kind: string) => kind === "review" || kind === "qa";

export function aggregateAgentProfile(input: {
  now: number;
  sinceDays: number;
  subtasks: ProfileSubtaskInput[];
  executions: ProfileExecutionInput[];
  usage: ProfileUsageInput[];
  /** Verdict events of every task in `subtasks` (any agent's tasks are filtered here). */
  verdicts: ProfileVerdictInput[];
  evaluations: ProfileEvaluationInput[];
  chatReplies: number;
  recentLimit?: number;
}): AgentProfile {
  const since = input.now - input.sinceDays * DAY_MS;
  const inWindow = (at: number) => at >= since;
  const subtasks = input.subtasks.filter((s) => inWindow(s.at));
  const executions = input.executions.filter((e) => inWindow(e.at));
  const id = (taskId: string, key: string | null | undefined) => `${taskId}::${key ?? ""}`;

  const status = { done: 0, failed: 0, blocked: 0, running: 0, pending: 0, skipped: 0 };
  let fixes = 0;
  let reviewRuns = 0;
  let qaRuns = 0;
  const durations: number[] = [];
  const durationById = new Map<string, number>();
  const executedIds = new Set(executions.filter((e) => e.subtaskKey).map((e) => id(e.taskId, e.subtaskKey)));

  for (const e of executions) {
    if (typeof e.startedAt === "number" && typeof e.completedAt === "number" && e.completedAt >= e.startedAt) {
      const d = e.completedAt - e.startedAt;
      durations.push(d);
      durationById.set(id(e.taskId, e.subtaskKey), (durationById.get(id(e.taskId, e.subtaskKey)) ?? 0) + d);
    }
  }
  const kindById = new Map(subtasks.map((s) => [id(s.taskId, s.key), s.kind]));
  for (const e of executions) {
    const kind = kindById.get(id(e.taskId, e.subtaskKey));
    if (kind === "review") reviewRuns += 1;
    if (kind === "qa") qaRuns += 1;
  }

  const implTasks = new Set<string>();
  const reviewTasks = new Set<string>();
  const qaTasks = new Set<string>();
  for (const s of subtasks) {
    status[statusSlot(s.status)] += 1;
    if (!isRound(s.kind) && (FIX_ORIGINS.has(s.origin ?? "") || /^(review_)?fix[_-]/.test(s.key))) fixes += 1;
    if (s.kind === "review") reviewTasks.add(s.taskId);
    else if (s.kind === "qa") qaTasks.add(s.taskId);
    else implTasks.add(s.taskId);
    if (!executedIds.has(id(s.taskId, s.key))) {
      const ran = s.status !== "pending" && s.status !== "ready";
      if (ran && s.kind === "review") reviewRuns += 1;
      if (ran && s.kind === "qa") qaRuns += 1;
      if (typeof s.startedAt === "number" && typeof s.completedAt === "number" && s.completedAt >= s.startedAt) {
        const d = s.completedAt - s.startedAt;
        durations.push(d);
        durationById.set(id(s.taskId, s.key), d);
      }
    }
  }

  const tokens = { input: 0, output: 0, total: 0, cost: null as number | null, estimated: false, calls: 0 };
  for (const u of input.usage) {
    if (!inWindow(u.at)) continue;
    tokens.input += u.inputTokens;
    tokens.output += u.outputTokens;
    tokens.total += u.inputTokens + u.outputTokens;
    tokens.calls += 1;
    if (typeof u.estimatedCost === "number") tokens.cost = (tokens.cost ?? 0) + u.estimatedCost;
    if (u.estimated) tokens.estimated = true;
  }

  // Verdicts, oldest first per task.
  const verdictsByTask = new Map<string, ProfileVerdictInput[]>();
  for (const v of input.verdicts.slice().sort((a, b) => a.at - b.at)) {
    const list = verdictsByTask.get(v.taskId) ?? [];
    list.push(v);
    verdictsByTask.set(v.taskId, list);
  }
  const firstOf = (taskId: string, prefix: "review." | "qa.") =>
    (verdictsByTask.get(taskId) ?? []).find(
      (v) => v.type.startsWith(prefix) && v.type !== "qa.blocked" && v.type !== "qa.warning"
    );
  const workReviewed = { tasks: 0, firstPass: 0, rate: null as number | null };
  const workQaed = { tasks: 0, firstPass: 0, rate: null as number | null };
  for (const taskId of implTasks) {
    const r = firstOf(taskId, "review.");
    if (r && (r.type === "review.approved" || r.type === "review.requested_changes")) {
      workReviewed.tasks += 1;
      if (r.type === "review.approved") workReviewed.firstPass += 1;
    }
    const q = firstOf(taskId, "qa.");
    if (q && (q.type === "qa.passed" || q.type === "qa.failed")) {
      workQaed.tasks += 1;
      if (q.type === "qa.passed") workQaed.firstPass += 1;
    }
  }
  workReviewed.rate = rate(workReviewed.firstPass, workReviewed.tasks);
  workQaed.rate = rate(workQaed.firstPass, workQaed.tasks);

  const verdictsGiven = { review: { approved: 0, changesRequested: 0 }, qa: { passed: 0, failed: 0, blocked: 0 } };
  for (const [taskId, list] of verdictsByTask) {
    for (const v of list) {
      if (!inWindow(v.at)) continue;
      if (reviewTasks.has(taskId)) {
        if (v.type === "review.approved") verdictsGiven.review.approved += 1;
        if (v.type === "review.requested_changes") verdictsGiven.review.changesRequested += 1;
      }
      if (qaTasks.has(taskId)) {
        if (v.type === "qa.passed") verdictsGiven.qa.passed += 1;
        if (v.type === "qa.failed") verdictsGiven.qa.failed += 1;
        if (v.type === "qa.blocked") verdictsGiven.qa.blocked += 1;
      }
    }
  }

  const worked = new Set(subtasks.map((s) => s.taskId));
  const latestEval = new Map<string, ProfileEvaluationInput>();
  for (const e of input.evaluations) {
    if (!worked.has(e.taskId)) continue;
    const cur = latestEval.get(e.taskId);
    if (!cur || e.at >= cur.at) latestEval.set(e.taskId, e);
  }
  const evals = { tasks: latestEval.size, passed: 0, failed: 0, inconclusive: 0 };
  for (const e of latestEval.values()) evals[e.verdict] += 1;

  const recent = subtasks
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, input.recentLimit ?? 15)
    .map((s) => ({
      taskId: s.taskId,
      taskTitle: s.taskTitle ?? null,
      key: s.key,
      title: s.title,
      kind: s.kind,
      status: s.status,
      at: s.at,
      durationMs: durationById.get(id(s.taskId, s.key)) ?? null,
    }));

  const totalMs = durations.reduce((sum, d) => sum + d, 0);
  return {
    sinceDays: input.sinceDays,
    since,
    subtasks: { total: subtasks.length, status, successRate: rate(status.done, status.done + status.failed) },
    duration: {
      timedRuns: durations.length,
      medianMs: median(durations),
      avgMs: durations.length ? totalMs / durations.length : null,
      totalMs,
    },
    executions: { total: executions.length, retries: executions.filter((e) => e.attempt > 1).length },
    tokens,
    fixes,
    reviewRuns,
    qaRuns,
    workReviewed,
    workQaed,
    verdictsGiven,
    evals,
    chatReplies: input.chatReplies,
    recent,
  };
}
