/**
 * Replay Session: one run as an ordered step timeline (instruction →
 * classification → plan → routing → each LLM call / tool call /
 * verification / QA / review → failure point), built from taskEvents plus
 * context snapshots; and a step-aligned diff of two runs.
 *
 * Pure: the runs query feeds it rows, the web renders the result.
 */
import type { SectionKey } from "./contextSnapshot";

export type ReplayStepKind =
  | "instruction"
  | "classification"
  | "plan"
  | "routing"
  | "llm"
  | "tool"
  | "verification"
  | "qa"
  | "review"
  | "subtask"
  | "approval"
  | "result"
  | "event";

export interface ReplayEventRow {
  _id: string;
  type: string;
  at: number;
  sequence?: number;
  subtaskKey?: string;
  level?: "info" | "warn" | "error";
  message?: string;
  payload?: unknown;
  agentId?: string;
}

export interface ReplaySnapshotRow {
  _id: string;
  at: number;
  callRole: string;
  subtaskKey?: string;
  agentId?: string;
  agentRole?: string;
  model?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export interface ReplayStep {
  id: string;
  kind: ReplayStepKind;
  label: string;
  at: number;
  subtaskKey?: string;
  agentRole?: string;
  snapshotId?: string;
  eventType?: string;
  detail?: string;
  failed: boolean;
}

export interface ReplayInput {
  task: { command: string; createdAt: number; status: string; errorMessage?: string; endedAt?: number | null };
  events: ReplayEventRow[];
  snapshots: ReplaySnapshotRow[];
}

/** Event types that are noise in a replay (live output, heartbeats). */
const SKIP_EVENT = /^(?:subtask\.chunk|agent\.chunk|heartbeat|task\.heartbeat|subtask\.output_chunk|lease\.)/;

export function eventKind(type: string): ReplayStepKind {
  if (type === "task.classified" || type.startsWith("classif")) return "classification";
  if (type.startsWith("plan.") || type === "orchestrator.plan") return "plan";
  if (type === "subtask.routed" || type.startsWith("routing.") || type.startsWith("delegation.")) return "routing";
  if (type.startsWith("verification.") || type === "task.check" || type.startsWith("acceptance.")) return "verification";
  if (type.startsWith("qa.")) return "qa";
  if (type.startsWith("review.")) return "review";
  if (type.startsWith("mcp.") || type.startsWith("shell.") || type.startsWith("tool.") || type.startsWith("repo.") || type === "agent.web_context")
    return "tool";
  if (type.startsWith("approval.") || type.startsWith("permission.")) return "approval";
  if (type.startsWith("subtask.")) return "subtask";
  if (type === "task.completed" || type === "task.failed" || type === "orchestrator.completed" || type === "task.cancelled") return "result";
  return "event";
}

function isFailureEvent(event: ReplayEventRow): boolean {
  if (event.level === "error") return true;
  return /(?:\.failed|\.error|_error|\.exhausted|\.blocked|\.timeout|\.interrupted|merge_failed)$/.test(event.type);
}

function shortText(value: unknown, max = 240): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const CALL_ROLE_TEXT: Record<string, string> = {
  executor: "LLM call",
  planner: "Planner call",
  decision: "Decision call",
  reviewer: "Review call",
  qa: "QA call",
  chat: "Chat reply",
  chat_tool_step: "Chat tool step",
};

export function buildReplaySteps(input: ReplayInput): { steps: ReplayStep[]; failureIndex: number } {
  const steps: ReplayStep[] = [
    {
      id: "instruction",
      kind: "instruction",
      label: "Instruction",
      at: input.task.createdAt,
      detail: shortText(input.task.command, 600),
      failed: false,
    },
  ];
  const timed: Array<ReplayStep & { order: number }> = [];
  for (const event of input.events) {
    if (SKIP_EVENT.test(event.type)) continue;
    timed.push({
      id: `e:${event._id}`,
      kind: eventKind(event.type),
      label: event.type,
      at: event.at,
      subtaskKey: event.subtaskKey,
      eventType: event.type,
      detail: shortText(event.message ?? event.payload),
      failed: isFailureEvent(event),
      order: event.sequence ?? event.at,
    });
  }
  for (const snap of input.snapshots) {
    timed.push({
      id: `s:${snap._id}`,
      kind: "llm",
      label: `${CALL_ROLE_TEXT[snap.callRole] ?? "LLM call"}${snap.model ? ` · ${snap.model}` : ""}`,
      at: snap.at,
      subtaskKey: snap.subtaskKey,
      agentRole: snap.agentRole,
      snapshotId: snap._id,
      detail: snap.error ? shortText(snap.error) : undefined,
      failed: Boolean(snap.error),
      order: Number.NaN,
    });
  }
  // Order by time; ties keep events (by sequence) ahead of the call they caused.
  timed.sort((a, b) => a.at - b.at || (a.kind === "llm" ? 1 : 0) - (b.kind === "llm" ? 1 : 0) || (a.order || 0) - (b.order || 0));
  steps.push(...timed.map(({ order: _order, ...step }) => step));
  if (input.task.errorMessage && !steps.some((s) => s.failed)) {
    steps.push({
      id: "task-error",
      kind: "result",
      label: "Task failed",
      at: input.task.endedAt ?? steps[steps.length - 1].at,
      detail: shortText(input.task.errorMessage, 600),
      failed: true,
    });
  }
  // The failure point: the first failed step (later failures usually cascade).
  const failureIndex = steps.findIndex((s) => s.failed);
  return { steps, failureIndex };
}

// ── Compare ─────────────────────────────────────────────────────────────

export interface RunSide {
  label: string;
  status: string;
  errorMessage?: string;
  plan: Array<{ key: string; title: string; capability?: string }>;
  routed: Array<{ subtaskKey: string; agentRole?: string }>;
  calls: Array<{
    snapshotId: string;
    callRole: string;
    subtaskKey?: string;
    agentRole?: string;
    model?: string;
    error?: string;
    sections: Array<{ key: SectionKey | string; tokens: number; content?: string }>;
    response?: string;
  }>;
}

export type DiffMark = "same" | "changed" | "only_a" | "only_b";

export interface DiffRow {
  group: "plan" | "routing" | "prompt" | "output" | "error";
  key: string;
  a?: string;
  b?: string;
  mark: DiffMark;
}

function mark(a: string | undefined, b: string | undefined): DiffMark {
  if (a === undefined) return "only_b";
  if (b === undefined) return "only_a";
  return a === b ? "same" : "changed";
}

/** Align calls by (callRole, subtaskKey or role, ordinal). */
function callKey(call: RunSide["calls"][number], ordinal: number): string {
  return `${call.callRole}:${call.subtaskKey ?? call.agentRole ?? "-"}#${ordinal}`;
}

function keyedCalls(side: RunSide): Map<string, RunSide["calls"][number]> {
  const counts = new Map<string, number>();
  const out = new Map<string, RunSide["calls"][number]>();
  for (const call of side.calls) {
    const base = `${call.callRole}:${call.subtaskKey ?? call.agentRole ?? "-"}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.set(callKey(call, n), call);
  }
  return out;
}

function union<T>(a: Iterable<T>, b: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

export function diffRuns(a: RunSide, b: RunSide): DiffRow[] {
  const rows: DiffRow[] = [];
  // Plan: by position (subtask keys differ between runs of the same ask).
  const planLen = Math.max(a.plan.length, b.plan.length);
  for (let i = 0; i < planLen; i += 1) {
    const pa = a.plan[i];
    const pb = b.plan[i];
    const ta = pa ? `${pa.title}${pa.capability ? ` [${pa.capability}]` : ""}` : undefined;
    const tb = pb ? `${pb.title}${pb.capability ? ` [${pb.capability}]` : ""}` : undefined;
    rows.push({ group: "plan", key: `#${i + 1}`, a: ta, b: tb, mark: mark(ta, tb) });
  }
  // Routing: by position as well.
  const routeLen = Math.max(a.routed.length, b.routed.length);
  for (let i = 0; i < routeLen; i += 1) {
    const ra = a.routed[i]?.agentRole;
    const rb = b.routed[i]?.agentRole;
    const sa = a.routed[i] ? ra ?? "—" : undefined;
    const sb = b.routed[i] ? rb ?? "—" : undefined;
    rows.push({ group: "routing", key: `#${i + 1}`, a: sa, b: sb, mark: mark(sa, sb) });
  }
  const ca = keyedCalls(a);
  const cb = keyedCalls(b);
  for (const key of union(ca.keys(), cb.keys())) {
    const x = ca.get(key);
    const y = cb.get(key);
    const sectionKeys = union((x?.sections ?? []).map((s) => s.key), (y?.sections ?? []).map((s) => s.key));
    for (const section of sectionKeys) {
      const sx = x?.sections.find((s) => s.key === section);
      const sy = y?.sections.find((s) => s.key === section);
      const vx = sx ? sx.content ?? `${sx.tokens} tok` : undefined;
      const vy = sy ? sy.content ?? `${sy.tokens} tok` : undefined;
      rows.push({ group: "prompt", key: `${key} · ${section}`, a: vx, b: vy, mark: mark(vx, vy) });
    }
    const ox = x ? x.response ?? "" : undefined;
    const oy = y ? y.response ?? "" : undefined;
    rows.push({ group: "output", key, a: ox, b: oy, mark: mark(ox, oy) });
    if (x?.error || y?.error) rows.push({ group: "error", key, a: x?.error, b: y?.error, mark: mark(x?.error, y?.error) });
  }
  const ea = a.errorMessage;
  const eb = b.errorMessage;
  if (ea || eb) rows.push({ group: "error", key: "task", a: ea, b: eb, mark: mark(ea, eb) });
  return rows;
}

/** Simple line diff (LCS) for the side-by-side text view. */
export function lineDiff(a: string, b: string, maxLines = 400): Array<{ op: "=" | "-" | "+"; text: string }> {
  const la = a.split("\n").slice(0, maxLines);
  const lb = b.split("\n").slice(0, maxLines);
  const n = la.length;
  const m = lb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ op: "=" | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      out.push({ op: "=", text: la[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: la[i++] });
    else out.push({ op: "+", text: lb[j++] });
  }
  while (i < n) out.push({ op: "-", text: la[i++] });
  while (j < m) out.push({ op: "+", text: lb[j++] });
  return out;
}
