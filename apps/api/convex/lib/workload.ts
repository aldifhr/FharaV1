/**
 * Workload by role: a pure aggregation over rows the backend already records
 * (subtasks, executions, tokenUsage, `subtask.routed` taskEvents, agent chat
 * messages). No LLM, no guessing: every number is a count or a sum of stored
 * fields, and the one-line summary is composed from those numbers.
 *
 * Pure (no Convex APIs) so it is unit-testable; `workload.ts` loads the rows
 * with bounded index reads and calls `aggregateWorkload`.
 */
import {
  LEGACY_ROLE_SUCCESSORS,
  ROLES,
  ROLE_KEYS,
  isRoleKey,
  normalizeRoleKey,
  roleLabel,
} from "./roles";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Subtask origins that are fix work spawned during a run (DynamicSubtaskOrigin). */
const FIX_ORIGINS = new Set(["fix", "review_fix"]);

export interface WorkloadSubtaskInput {
  taskId: string;
  key: string;
  kind: string;
  status: string;
  origin?: string | null;
  /** Raw stored role of the assigned agent; null when the subtask was never assigned. */
  role: string | null;
  /** When the subtask counts for the window (startedAt ?? creation time). */
  at: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface WorkloadExecutionInput {
  taskId: string;
  subtaskKey?: string | null;
  /** Kind of the subtask the execution ran (qa, review, code_change, …), when known. */
  kind?: string | null;
  role: string | null;
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
  at: number;
}

export interface WorkloadUsageInput {
  role: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost?: number | null;
  /** Provider reported no usage: the counts are a chars/4 estimate (usageEstimated). */
  estimated?: boolean | null;
  at: number;
}

export interface WorkloadRouteInput {
  taskId: string;
  subtaskKey: string | null;
  role: string | null;
  match: "exact" | "fallback";
  at: number;
}

export interface WorkloadMessageInput {
  role: string | null;
  at: number;
}

export interface WorkloadInput {
  now: number;
  sinceDays: number;
  /** Roles of enabled agents; a rostered role with no work is listed as idle. */
  rosterRoles?: string[];
  subtasks: WorkloadSubtaskInput[];
  executions: WorkloadExecutionInput[];
  usage: WorkloadUsageInput[];
  routes: WorkloadRouteInput[];
  messages: WorkloadMessageInput[];
}

export interface WorkloadRoleRow {
  /** Canonical role key (nine fixed roles) or the normalized stored role. */
  key: string;
  label: string;
  /** False for a stored role that is not one of the nine fixed roles. */
  recognized: boolean;
  subtasks: number;
  status: { done: number; failed: number; blocked: number; running: number; pending: number; skipped: number };
  totalDurationMs: number;
  medianDurationMs: number | null;
  avgDurationMs: number | null;
  timedRuns: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  /** Sum of estimatedCost over calls that had pricing; null when none did. */
  cost: number | null;
  /** Some calls had no provider usage, so their tokens are a chars/4 estimate. */
  tokensEstimated: boolean;
  llmCalls: number;
  /** Fix subtasks (origin fix / review_fix, not review or QA nodes) this role ran. */
  fixIterations: number;
  /** QA passes this role ran (executions of qa subtasks; a subtask without executions counts once). */
  qaRounds: number;
  /** Review passes this role ran, counted the same way as QA rounds. */
  reviewRounds: number;
  routes: number;
  fallbackRoutes: number;
  chatReplies: number;
  subtaskShare: number;
  tokenShare: number;
}

export interface WorkloadResult {
  sinceDays: number;
  since: number;
  rows: WorkloadRoleRow[];
  totals: {
    subtasks: number;
    tokens: number;
    cost: number | null;
    routes: number;
    fallbackRoutes: number;
    chatReplies: number;
    /** Subtasks in the window that were never assigned to an agent. */
    unassignedSubtasks: number;
    /** Assigned subtasks with no `subtask.routed` event (ran before routing events existed). */
    subtasksWithoutRouteEvent: number;
  };
  /** Fixed roles that ran no subtask in the window. */
  idleRoles: string[];
  /**
   * Work done by agents whose stored role is not one of the nine fixed roles.
   * These are the roles the worker's normalizeRole would map to Frontend; they
   * are kept under their own label here instead of being folded into Frontend.
   */
  unrecognizedRoleSubtasks: number;
  summary: string;
}

interface Bucket {
  key: string;
  label: string;
  recognized: boolean;
}

/** Stored role → bucket. Legacy keys show as their successor (roleLabel). */
export function roleBucket(raw: string | null | undefined): Bucket {
  const normalized = normalizeRoleKey(raw ?? "");
  if (!normalized) return { key: "unattributed", label: "Unattributed", recognized: false };
  const key = LEGACY_ROLE_SUCCESSORS[normalized] ?? normalized;
  if (isRoleKey(key)) return { key, label: ROLES[key].label, recognized: true };
  const byLabel = ROLE_KEYS.find((k) => ROLES[k].label.toLowerCase() === normalized || ROLES[k].title.toLowerCase().replace(/\s+/g, "-") === normalized);
  if (byLabel) return { key: byLabel, label: ROLES[byLabel].label, recognized: true };
  return { key, label: roleLabel(key), recognized: false };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Match of one `subtask.routed` payload: the explicit `match` field when the
 * worker wrote it, else whether the agent declared the capability (the same
 * inference the Routing Inspector uses for older events).
 */
export function routeMatch(payload: unknown): "exact" | "fallback" {
  const p = asRecord(payload);
  if (p.match === "exact" || p.match === "fallback") return p.match;
  const capability = typeof p.capability === "string" ? p.capability.trim().toLowerCase().replace(/\s+/g, "-") : "";
  const declared = Array.isArray(p.capabilities)
    ? p.capabilities.filter((c): c is string => typeof c === "string").map((c) => c.trim().toLowerCase())
    : [];
  return capability && declared.includes(capability) ? "exact" : "fallback";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function statusSlot(status: string): keyof WorkloadRoleRow["status"] {
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

/** Plain-language line built from the numbers (never an LLM). */
export function workloadSummary(rows: WorkloadRoleRow[], idleRoles: string[], sinceDays: number): string {
  const window = `in ${sinceDays} days`;
  const total = rows.reduce((sum, r) => sum + r.subtasks, 0);
  if (total === 0) return `No subtasks ran ${window}.`;
  const max = Math.max(...rows.map((r) => r.subtasks));
  const top = rows.filter((r) => r.subtasks === max);
  const share = Math.round((max / total) * 100);
  const lead =
    top.length === 1
      ? `${top[0].label} did ${share}% of subtasks`
      : `${joinNames(top.map((r) => r.label))} each did ${share}% of subtasks`;
  if (idleRoles.length === 0) return `${lead}; every role had work ${window}.`;
  return `${lead}; ${joinNames(idleRoles)} did none ${window}.`;
}

export function aggregateWorkload(input: WorkloadInput): WorkloadResult {
  const since = input.now - input.sinceDays * DAY_MS;
  const inWindow = (at: number) => at >= since;

  const rows = new Map<string, WorkloadRoleRow>();
  const durations = new Map<string, number[]>();
  const row = (raw: string | null | undefined): WorkloadRoleRow => {
    const b = roleBucket(raw);
    let r = rows.get(b.key);
    if (!r) {
      r = {
        key: b.key,
        label: b.label,
        recognized: b.recognized,
        subtasks: 0,
        status: { done: 0, failed: 0, blocked: 0, running: 0, pending: 0, skipped: 0 },
        totalDurationMs: 0,
        medianDurationMs: null,
        avgDurationMs: null,
        timedRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        cost: null,
        tokensEstimated: false,
        llmCalls: 0,
        fixIterations: 0,
        qaRounds: 0,
        reviewRounds: 0,
        routes: 0,
        fallbackRoutes: 0,
        chatReplies: 0,
        subtaskShare: 0,
        tokenShare: 0,
      };
      rows.set(b.key, r);
      durations.set(b.key, []);
    }
    return r;
  };
  // Every fixed role is listed, so a role with no work shows as zeros.
  for (const key of ROLE_KEYS) row(key);
  for (const role of input.rosterRoles ?? []) row(role);

  const subtaskId = (taskId: string, key: string | null | undefined) => `${taskId}::${key ?? ""}`;
  const subtasks = input.subtasks.filter((s) => inWindow(s.at));
  const executions = input.executions.filter((e) => inWindow(e.at));

  let unassigned = 0;
  let unrecognized = 0;
  const assignedIds = new Set<string>();
  const executedIds = new Set<string>();
  for (const e of executions) if (e.subtaskKey) executedIds.add(subtaskId(e.taskId, e.subtaskKey));

  for (const s of subtasks) {
    if (!s.role) {
      unassigned += 1;
      continue;
    }
    const r = row(s.role);
    if (!r.recognized) unrecognized += 1;
    assignedIds.add(subtaskId(s.taskId, s.key));
    r.subtasks += 1;
    r.status[statusSlot(s.status)] += 1;
    const isRound = s.kind === "qa" || s.kind === "review";
    if (!isRound && (FIX_ORIGINS.has(s.origin ?? "") || (!s.origin && /^fix[_-]/.test(s.key)))) r.fixIterations += 1;
    // Rows that predate executions (or never got one) still count their run once.
    if (!executedIds.has(subtaskId(s.taskId, s.key))) {
      if (s.kind === "qa" && s.status !== "pending" && s.status !== "ready") r.qaRounds += 1;
      if (s.kind === "review" && s.status !== "pending" && s.status !== "ready") r.reviewRounds += 1;
      if (typeof s.startedAt === "number" && typeof s.completedAt === "number" && s.completedAt >= s.startedAt) {
        durations.get(r.key)!.push(s.completedAt - s.startedAt);
      }
    }
  }

  for (const e of executions) {
    if (!e.role) continue;
    const r = row(e.role);
    if (e.kind === "qa") r.qaRounds += 1;
    if (e.kind === "review") r.reviewRounds += 1;
    if (typeof e.startedAt === "number" && typeof e.completedAt === "number" && e.completedAt >= e.startedAt) {
      durations.get(r.key)!.push(e.completedAt - e.startedAt);
    }
  }

  let totalTokens = 0;
  let totalCost: number | null = null;
  for (const u of input.usage) {
    if (!inWindow(u.at)) continue;
    const r = row(u.role);
    const tokens = u.inputTokens + u.outputTokens;
    r.inputTokens += u.inputTokens;
    r.outputTokens += u.outputTokens;
    r.tokens += tokens;
    r.llmCalls += 1;
    totalTokens += tokens;
    if (typeof u.estimatedCost === "number") {
      r.cost = (r.cost ?? 0) + u.estimatedCost;
      totalCost = (totalCost ?? 0) + u.estimatedCost;
    }
    if (u.estimated) r.tokensEstimated = true;
  }

  let totalRoutes = 0;
  let totalFallback = 0;
  const routedIds = new Set<string>();
  for (const route of input.routes) {
    if (!inWindow(route.at)) continue;
    const r = row(route.role);
    r.routes += 1;
    totalRoutes += 1;
    if (route.match === "fallback") {
      r.fallbackRoutes += 1;
      totalFallback += 1;
    }
    if (route.subtaskKey) routedIds.add(subtaskId(route.taskId, route.subtaskKey));
  }

  let totalReplies = 0;
  for (const m of input.messages) {
    if (!inWindow(m.at)) continue;
    row(m.role).chatReplies += 1;
    totalReplies += 1;
  }

  const totalSubtasks = subtasks.length - unassigned;
  for (const r of rows.values()) {
    const list = durations.get(r.key)!;
    r.timedRuns = list.length;
    r.totalDurationMs = list.reduce((sum, d) => sum + d, 0);
    r.medianDurationMs = median(list);
    r.avgDurationMs = list.length ? r.totalDurationMs / list.length : null;
    r.subtaskShare = pct(r.subtasks, totalSubtasks);
    r.tokenShare = pct(r.tokens, totalTokens);
  }

  const order = (r: WorkloadRoleRow) => {
    const i = (ROLE_KEYS as readonly string[]).indexOf(r.key);
    return i === -1 ? ROLE_KEYS.length : i;
  };
  // Fixed roles in display order, then other stored roles; drop empty
  // non-fixed buckets (e.g. an "Unattributed" bucket with nothing in it).
  const list = [...rows.values()]
    .filter((r) => r.recognized || r.subtasks + r.tokens + r.chatReplies + r.routes > 0)
    .sort((a, b) => order(a) - order(b) || b.subtasks - a.subtasks || a.label.localeCompare(b.label));

  const idleRoles = list.filter((r) => r.recognized && r.subtasks === 0).map((r) => r.label);
  let withoutRoute = 0;
  for (const id of assignedIds) if (!routedIds.has(id)) withoutRoute += 1;

  return {
    sinceDays: input.sinceDays,
    since,
    rows: list,
    totals: {
      subtasks: totalSubtasks,
      tokens: totalTokens,
      cost: totalCost,
      routes: totalRoutes,
      fallbackRoutes: totalFallback,
      chatReplies: totalReplies,
      unassignedSubtasks: unassigned,
      subtasksWithoutRouteEvent: withoutRoute,
    },
    idleRoles,
    unrecognizedRoleSubtasks: unrecognized,
    summary: workloadSummary(list, idleRoles, input.sinceDays),
  };
}

/** Plain-text table (CLI `npm run stats:roles`; shared so web and CLI agree). */
export function formatWorkloadTable(result: WorkloadResult): string {
  const fmtDur = (ms: number | null) => {
    if (ms === null) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const fmtCost = (c: number | null) =>
    c === null ? "—" : c === 0 ? "$0" : `$${c.toFixed(c < 0.01 ? 4 : c < 1 ? 3 : 2)}`;
  const header = ["Role", "Subtasks", "Share", "Done/Failed", "Tokens", "Tok%", "Cost", "Avg time", "Median", "Fixes", "QA rds", "Fallback/Routes", "Replies"];
  const body = result.rows.map((r) => [
    r.recognized ? r.label : `${r.label}*`,
    String(r.subtasks),
    `${r.subtaskShare}%`,
    `${r.status.done}/${r.status.failed}`,
    `${r.tokensEstimated ? "≈" : ""}${fmtTok(r.tokens)}`,
    `${r.tokenShare}%`,
    fmtCost(r.cost),
    fmtDur(r.avgDurationMs),
    fmtDur(r.medianDurationMs),
    String(r.fixIterations),
    String(r.qaRounds),
    `${r.fallbackRoutes}/${r.routes}`,
    String(r.chatReplies),
  ]);
  const t = result.totals;
  body.push([
    "Total",
    String(t.subtasks),
    "",
    "",
    fmtTok(t.tokens),
    "",
    fmtCost(t.cost),
    "",
    "",
    "",
    "",
    `${t.fallbackRoutes}/${t.routes}`,
    String(t.chatReplies),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((line) => line[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const out = [result.summary, "", line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)];
  const notes: string[] = [];
  if (t.unassignedSubtasks) notes.push(`${t.unassignedSubtasks} subtask(s) were never assigned and are not counted per role.`);
  if (t.subtasksWithoutRouteEvent) notes.push(`${t.subtasksWithoutRouteEvent} assigned subtask(s) have no subtask.routed event, so their routing match is unknown.`);
  if (result.unrecognizedRoleSubtasks) notes.push(`* stored role is not one of the nine fixed roles (${result.unrecognizedRoleSubtasks} subtask(s)); the worker's normalizeRole would treat it as Frontend.`);
  if (result.rows.some((r) => r.tokensEstimated)) notes.push("≈ some token counts are chars/4 estimates (provider reported no usage).");
  if (notes.length) out.push("", ...notes);
  return out.join("\n");
}
