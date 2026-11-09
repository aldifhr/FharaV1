/**
 * Workload Manager — live capacity. Pure (no Convex APIs): which agents
 * are running how many executions against their concurrency limit.
 *
 * An execution occupies a slot while it is `running` or
 * `waiting_approval` on a task that is not terminal (the same rule the
 * scheduler's per-agent start gate applies inside one run). A `running`
 * row whose lease lapsed with no heartbeat is a stale row, not load: it is
 * counted separately so the view can say so.
 */
import { roleBucket } from "./workload";

export const ACTIVE_EXECUTION_STATUSES = ["running", "waiting_approval"] as const;
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "rejected", "cancelled"]);

export interface CapacityExecutionInput {
  agentId: string | null;
  status: string;
  taskStatus: string | null;
  leaseExpiresAt?: number | null;
  taskId: string;
  taskTitle?: string | null;
  projectId: string;
  subtaskKey?: string | null;
  startedAt?: number | null;
}

export interface CapacityAgentInput {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  maxConcurrency?: number | null;
  priority?: number | null;
}

/** Limit as the worker reads it: unset or invalid = 1 (runNodes canStartNode). */
export function concurrencyLimitOf(maxConcurrency: number | null | undefined): number {
  return typeof maxConcurrency === "number" && Number.isFinite(maxConcurrency) && maxConcurrency >= 1
    ? Math.floor(maxConcurrency)
    : 1;
}

export type ExecutionLoadClass = "active" | "stale" | "ignored";

export function classifyExecution(e: CapacityExecutionInput, now: number): ExecutionLoadClass {
  if (!e.agentId) return "ignored";
  if (!(ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(e.status)) return "ignored";
  if (!e.taskStatus || TERMINAL_TASK_STATUSES.has(e.taskStatus)) return "ignored";
  if (e.status === "running" && typeof e.leaseExpiresAt === "number" && e.leaseExpiresAt < now) return "stale";
  return "active";
}

/** Running executions per agent id (the load-aware router's input). */
export function countActiveByAgent(executions: CapacityExecutionInput[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of executions) {
    if (classifyExecution(e, now) !== "active") continue;
    out[e.agentId!] = (out[e.agentId!] ?? 0) + 1;
  }
  return out;
}

export interface CapacityRow {
  agentId: string;
  role: string;
  label: string;
  enabled: boolean;
  running: number;
  limit: number;
  spare: number;
  /** running / limit, may exceed 1 when slots were taken across workers. */
  utilization: number;
  stale: number;
  work: Array<{ taskId: string; taskTitle: string | null; projectId: string; subtaskKey: string | null; status: string; startedAt: number | null }>;
}

export interface CapacityView {
  rows: CapacityRow[];
  totals: { running: number; limit: number; atCapacity: number; stale: number };
}

export function buildCapacity(agents: CapacityAgentInput[], executions: CapacityExecutionInput[], now: number): CapacityView {
  const rows = new Map<string, CapacityRow>();
  for (const a of agents) {
    const limit = concurrencyLimitOf(a.maxConcurrency);
    rows.set(a.id, {
      agentId: a.id,
      role: a.role,
      label: roleBucket(a.role).label,
      enabled: a.enabled,
      running: 0,
      limit,
      spare: limit,
      utilization: 0,
      stale: 0,
      work: [],
    });
  }
  for (const e of executions) {
    const cls = classifyExecution(e, now);
    if (cls === "ignored") continue;
    const row = rows.get(e.agentId!);
    if (!row) continue;
    if (cls === "stale") {
      row.stale += 1;
      continue;
    }
    row.running += 1;
    row.work.push({
      taskId: e.taskId,
      taskTitle: e.taskTitle ?? null,
      projectId: e.projectId,
      subtaskKey: e.subtaskKey ?? null,
      status: e.status,
      startedAt: e.startedAt ?? null,
    });
  }
  const list = [...rows.values()];
  for (const r of list) {
    r.spare = Math.max(0, r.limit - r.running);
    r.utilization = r.limit > 0 ? Math.round((r.running / r.limit) * 100) / 100 : 0;
    r.work.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
  list.sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      b.utilization - a.utilization ||
      b.running - a.running ||
      a.label.localeCompare(b.label)
  );
  const enabled = list.filter((r) => r.enabled);
  return {
    rows: list,
    totals: {
      running: list.reduce((s, r) => s + r.running, 0),
      limit: enabled.reduce((s, r) => s + r.limit, 0),
      atCapacity: enabled.filter((r) => r.running >= r.limit).length,
      stale: list.reduce((s, r) => s + r.stale, 0),
    },
  };
}
