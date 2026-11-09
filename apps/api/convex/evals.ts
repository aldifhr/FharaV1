import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjectIds } from "./lib/authz";

/**
 * Evaluations dashboard (read-only). One query, `summary`, aggregates the
 * last 7/30/90 days of runs for one project or for every project the
 * viewer can see.
 *
 * Every table is read newest-first through a time index and capped (see
 * CAPS); when a cap is hit the result says so in `truncated`, and the
 * numbers then cover only the newest rows of the window. Sources:
 *
 * - taskSuccess: `tasks` created in the window that finished. done counts as
 *   success; failed and rejected count as failure. Running/queued/waiting
 *   tasks are excluded.
 * - qa: `evaluations` verdicts (passed / failed; inconclusive is reported
 *   but excluded from the rate). Also QA subtasks (`subtasks.kind === "qa"`,
 *   completed vs failed) as a second signal; the headline rate uses
 *   evaluations when there are any, else QA subtasks.
 * - toolCalls: SOURCE = the `audit` table. Each governed tool call (file
 *   tools, run_command, github, MCP, apply_changes) writes an audit row
 *   with decision allowed/denied; success = allowed / (allowed + denied).
 *   Config ("config") and approval ("approval") rows and pending/recorded
 *   decisions are excluded. NOTE this is a permission/governance success
 *   rate, not "the command exited 0". As a secondary outcome signal we also
 *   count canonical `agentEvents` of type tool.completed vs tool.failed.
 * - agents: `executions` (runs, failures, durations, retries = executions
 *   with attempt > 1) joined with `tokenUsage` by agentId (or agentName
 *   when the usage row has no agentId).
 * - costPerTask: `tokenUsage.estimatedCost` summed per taskId. Rows without
 *   estimatedCost (no registry pricing) are counted in `unpricedCalls`, and
 *   the averages cover priced rows only.
 * - models: `tokenUsage` grouped by model. Execution outcome per model is
 *   attributed through `tokenUsage.executionId` when the row carries one
 *   (and the execution is in the window); otherwise by (taskId, agent) — every execution of that agent on that
 *   task counts as having used the model (an approximation when one agent
 *   used several models on the same task).
 * - trend: per local day (tzOffsetMinutes from the browser), finished-task
 *   success rate and priced cost.
 */

const DAY_MS = 86_400_000;

// Per-table scan caps. Kept well under Convex's per-query read limits even
// with large `output` fields on executions/subtasks.
const CAPS = {
  tasks: 1500,
  executions: 2000,
  subtasks: 1000,
  evaluations: 1000,
  tokenUsage: 5000,
  audit: 3000,
  agentEvents: 1500,
} as const;

type Table = keyof typeof CAPS;

const FINISHED_TASK = new Set(["done", "failed", "rejected"]);
const EXCLUDED_AUDIT_TOOLS = new Set(["config", "approval"]);

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function rate(ok: number, total: number): number | null {
  return total > 0 ? ok / total : null;
}

/** "2026-11-09" for a timestamp, in the caller's local day. */
export function dayKey(ms: number, tzOffsetMinutes: number): string {
  // getTimezoneOffset() is minutes BEHIND UTC (Jakarta = -420).
  return new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

async function scan<T extends Table>(
  ctx: QueryCtx,
  table: T,
  since: number,
  projectId: Id<"projects"> | undefined
): Promise<{ rows: Doc<T>[]; truncated: boolean }> {
  const cap = CAPS[table];
  let rows: Doc<T>[];
  if (projectId && (table === "tasks" || table === "subtasks" || table === "audit" || table === "tokenUsage" || table === "agentEvents")) {
    // Every by_project index ends in _creationTime implicitly, so the
    // window is an index range, not a filter.
    rows = (await (ctx.db.query(table) as any)
      .withIndex("by_project", (q: any) => q.eq("projectId", projectId).gte("_creationTime", since))
      .order("desc")
      .take(cap)) as Doc<T>[];
  } else {
    rows = (await (ctx.db.query(table) as any)
      .withIndex("by_creation_time", (q: any) => q.gte("_creationTime", since))
      .order("desc")
      .take(cap)) as Doc<T>[];
  }
  return { rows, truncated: rows.length >= cap };
}

type AgentAcc = {
  key: string;
  agentId?: Id<"agents">;
  agentName: string;
  executions: number;
  completed: number;
  failed: number;
  cancelled: number;
  retries: number;
  durationTotal: number;
  durationCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  pricedCalls: number;
  calls: number;
};

type ModelAcc = {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  pricedCalls: number;
  executionIds: Set<string>;
};

export const summary = query({
  args: {
    projectId: v.optional(v.id("projects")),
    days: v.union(v.literal(7), v.literal(30), v.literal(90)),
    /** Browser `new Date().getTimezoneOffset()`; default UTC days. */
    tzOffsetMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const tz = Math.max(-840, Math.min(840, Math.round(args.tzOffsetMinutes ?? 0)));
    const now = Date.now();
    const since = now - args.days * DAY_MS;

    let visible: Set<string> | null = null;
    if (args.projectId) {
      await assertProjectAccess(ctx, args.projectId);
    } else {
      visible = await visibleProjectIds(ctx);
    }
    const inScope = (pid: string | undefined) =>
      args.projectId ? pid === args.projectId : pid !== undefined && visible!.has(pid);

    const [tasksScan, execScan, subtaskScan, evalScan, usageScan, auditScan, eventScan] = await Promise.all([
      scan(ctx, "tasks", since, args.projectId),
      scan(ctx, "executions", since, args.projectId),
      scan(ctx, "subtasks", since, args.projectId),
      scan(ctx, "evaluations", since, args.projectId),
      scan(ctx, "tokenUsage", since, args.projectId),
      scan(ctx, "audit", since, args.projectId),
      scan(ctx, "agentEvents", since, args.projectId),
    ]);
    const tasks = tasksScan.rows.filter((r) => inScope(r.projectId));
    const executions = execScan.rows.filter((r) => inScope(r.projectId));
    const subtasks = subtaskScan.rows.filter((r) => inScope(r.projectId));
    const evaluations = evalScan.rows.filter((r) => inScope(r.projectId));
    const usage = usageScan.rows.filter((r) => inScope(r.projectId));
    const audit = auditScan.rows.filter((r) => inScope(r.projectId));
    const events = eventScan.rows.filter((r) => inScope(r.projectId));

    // ---- Task success -------------------------------------------------
    let done = 0;
    let failedTasks = 0;
    let rejected = 0;
    for (const t of tasks) {
      if (t.status === "done") done++;
      else if (t.status === "failed") failedTasks++;
      else if (t.status === "rejected") rejected++;
    }
    const finished = done + failedTasks + rejected;

    // ---- QA -----------------------------------------------------------
    let evalPassed = 0;
    let evalFailed = 0;
    let evalInconclusive = 0;
    for (const e of evaluations) {
      if (e.verdict === "passed") evalPassed++;
      else if (e.verdict === "failed") evalFailed++;
      else evalInconclusive++;
    }
    let qaCompleted = 0;
    let qaFailed = 0;
    for (const s of subtasks) {
      if (s.kind !== "qa") continue;
      if (s.status === "completed") qaCompleted++;
      else if (s.status === "failed") qaFailed++;
    }
    const evalRate = rate(evalPassed, evalPassed + evalFailed);
    const qaSubtaskRate = rate(qaCompleted, qaCompleted + qaFailed);

    // ---- Tool calls (audit) ----------------------------------------------
    let toolAllowed = 0;
    let toolDenied = 0;
    const deniedByTool = new Map<string, number>();
    for (const a of audit) {
      if (EXCLUDED_AUDIT_TOOLS.has(a.tool)) continue;
      if (a.decision === "allowed") toolAllowed++;
      else if (a.decision === "denied") {
        toolDenied++;
        deniedByTool.set(a.tool, (deniedByTool.get(a.tool) ?? 0) + 1);
      }
    }
    let toolEventsCompleted = 0;
    let toolEventsFailed = 0;
    for (const e of events) {
      if (e.type === "tool.completed" || e.type === "agent.tool.completed") toolEventsCompleted++;
      else if (e.type === "tool.failed" || e.type === "agent.tool.failed") toolEventsFailed++;
    }

    // ---- Agents ---------------------------------------------------------
    const agentDocs = new Map<string, Doc<"agents">>();
    for (const a of await ctx.db.query("agents").take(500)) agentDocs.set(a._id, a);
    const agentKeyByName = new Map<string, string>();
    for (const a of agentDocs.values()) agentKeyByName.set(a.name, a._id);
    const agentKey = (agentId: Id<"agents"> | undefined, name: string) =>
      agentId ?? agentKeyByName.get(name) ?? `name:${name}`;

    const agents = new Map<string, AgentAcc>();
    const acc = (agentId: Id<"agents"> | undefined, name: string): AgentAcc => {
      const key = agentKey(agentId, name);
      let row = agents.get(key);
      if (!row) {
        row = {
          key,
          agentId: agentId ?? (agentDocs.has(key) ? (key as Id<"agents">) : undefined),
          agentName: name,
          executions: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          retries: 0,
          durationTotal: 0,
          durationCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          pricedCalls: 0,
          calls: 0,
        };
        agents.set(key, row);
      }
      return row;
    };

    const execById = new Map<string, Doc<"executions">>();
    const execsByTaskAgent = new Map<string, string[]>();
    const duration = (e: Doc<"executions">) =>
      e.startedAt && e.completedAt && e.completedAt >= e.startedAt ? e.completedAt - e.startedAt : null;
    for (const e of executions) {
      execById.set(e._id, e);
      const k = `${e.taskId}|${agentKey(e.agentId, e.agentName)}`;
      const list = execsByTaskAgent.get(k) ?? [];
      list.push(e._id);
      execsByTaskAgent.set(k, list);
      const row = acc(e.agentId, e.agentName);
      row.executions++;
      if (e.status === "completed") row.completed++;
      else if (e.status === "failed") row.failed++;
      else if (e.status === "cancelled") row.cancelled++;
      if (e.attempt > 1) row.retries++;
      const d = duration(e);
      if (d !== null && (e.status === "completed" || e.status === "failed")) {
        row.durationTotal += d;
        row.durationCount++;
      }
    }

    // ---- Usage: agents, models, cost per task ----------------------------
    const models = new Map<string, ModelAcc>();
    const costByTask = new Map<string, number>();
    let pricedCalls = 0;
    let unpricedCalls = 0;
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let executionIdAttributed = 0;
    for (const u of usage) {
      const row = acc(u.agentId, u.agentName);
      row.calls++;
      row.inputTokens += u.inputTokens;
      row.outputTokens += u.outputTokens;
      totalIn += u.inputTokens;
      totalOut += u.outputTokens;
      const priced = typeof u.estimatedCost === "number";
      if (priced) {
        row.cost += u.estimatedCost!;
        row.pricedCalls++;
        pricedCalls++;
        totalCost += u.estimatedCost!;
        if (u.taskId) costByTask.set(u.taskId, (costByTask.get(u.taskId) ?? 0) + u.estimatedCost!);
      } else {
        unpricedCalls++;
      }

      const model = u.model || "unknown";
      let m = models.get(model);
      if (!m) {
        m = { model, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, pricedCalls: 0, executionIds: new Set() };
        models.set(model, m);
      }
      m.calls++;
      m.inputTokens += u.inputTokens;
      m.outputTokens += u.outputTokens;
      if (priced) {
        m.cost += u.estimatedCost!;
        m.pricedCalls++;
      }
      // Rows written since the Runs work carry `executionId`; older rows
      // fall back to (task, agent) attribution.
      const execId = u.executionId;
      if (execId && execById.has(execId)) {
        m.executionIds.add(execId);
        executionIdAttributed++;
      } else if (u.taskId) {
        for (const id of execsByTaskAgent.get(`${u.taskId}|${agentKey(u.agentId, u.agentName)}`) ?? []) {
          m.executionIds.add(id);
        }
      }
    }
    const taskCosts = [...costByTask.values()];

    // ---- Daily trend ----------------------------------------------------
    const trendMap = new Map<string, { day: string; done: number; finished: number; cost: number }>();
    for (let t = since; t <= now; t += DAY_MS) {
      const day = dayKey(t, tz);
      trendMap.set(day, { day, done: 0, finished: 0, cost: 0 });
    }
    const today = dayKey(now, tz);
    if (!trendMap.has(today)) trendMap.set(today, { day: today, done: 0, finished: 0, cost: 0 });
    for (const t of tasks) {
      if (!FINISHED_TASK.has(t.status)) continue;
      const at = t.completedAt ?? t.updatedAt ?? t._creationTime;
      const bucket = trendMap.get(dayKey(at, tz));
      if (!bucket) continue;
      bucket.finished++;
      if (t.status === "done") bucket.done++;
    }
    for (const u of usage) {
      if (typeof u.estimatedCost !== "number") continue;
      const bucket = trendMap.get(dayKey(u.createdAt, tz));
      if (bucket) bucket.cost += u.estimatedCost;
    }
    const trend = [...trendMap.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((b) => ({ ...b, successRate: rate(b.done, b.finished) }));

    // ---- Shape ----------------------------------------------------------
    const agentRows = [...agents.values()]
      .map((a) => {
        const doc = a.agentId ? agentDocs.get(a.agentId) : undefined;
        return {
          key: a.key,
          agentId: a.agentId ?? null,
          agentName: doc?.name ?? a.agentName,
          role: doc?.role ?? a.agentName,
          executions: a.executions,
          completed: a.completed,
          failed: a.failed,
          cancelled: a.cancelled,
          failureRate: rate(a.failed, a.completed + a.failed),
          avgDurationMs: a.durationCount ? a.durationTotal / a.durationCount : null,
          retries: a.retries,
          calls: a.calls,
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          tokens: a.inputTokens + a.outputTokens,
          cost: a.pricedCalls ? a.cost : null,
          unpricedCalls: a.calls - a.pricedCalls,
        };
      })
      .sort((a, b) => (b.failureRate ?? -1) - (a.failureRate ?? -1) || b.executions - a.executions);

    const modelRows = [...models.values()]
      .map((m) => {
        let completed = 0;
        let failed = 0;
        let durTotal = 0;
        let durCount = 0;
        for (const id of m.executionIds) {
          const e = execById.get(id)!;
          if (e.status === "completed") completed++;
          else if (e.status === "failed") failed++;
          const d = duration(e);
          if (d !== null && (e.status === "completed" || e.status === "failed")) {
            durTotal += d;
            durCount++;
          }
        }
        return {
          model: m.model,
          calls: m.calls,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cost: m.pricedCalls ? m.cost : null,
          unpricedCalls: m.calls - m.pricedCalls,
          executions: m.executionIds.size,
          failureRate: rate(failed, completed + failed),
          avgDurationMs: durCount ? durTotal / durCount : null,
        };
      })
      .sort((a, b) => b.calls - a.calls);

    const qaSource: "evaluations" | "qa_subtasks" | "none" =
      evalPassed + evalFailed > 0 ? "evaluations" : qaCompleted + qaFailed > 0 ? "qa_subtasks" : "none";

    const truncated = {
      tasks: tasksScan.truncated,
      executions: execScan.truncated,
      subtasks: subtaskScan.truncated,
      evaluations: evalScan.truncated,
      tokenUsage: usageScan.truncated,
      audit: auditScan.truncated,
      agentEvents: eventScan.truncated,
    };

    return {
      days: args.days,
      since,
      generatedAt: now,
      hasData: tasks.length + executions.length + usage.length + evaluations.length + audit.length > 0,
      truncated,
      anyTruncated: Object.values(truncated).some(Boolean),
      taskSuccess: { done, failed: failedTasks, rejected, finished, total: tasks.length, rate: rate(done, finished) },
      qa: {
        source: qaSource,
        rate: qaSource === "evaluations" ? evalRate : qaSource === "qa_subtasks" ? qaSubtaskRate : null,
        evaluations: { passed: evalPassed, failed: evalFailed, inconclusive: evalInconclusive, rate: evalRate },
        qaSubtasks: { completed: qaCompleted, failed: qaFailed, rate: qaSubtaskRate },
      },
      toolCalls: {
        source: "audit" as const,
        allowed: toolAllowed,
        denied: toolDenied,
        rate: rate(toolAllowed, toolAllowed + toolDenied),
        deniedByTool: [...deniedByTool.entries()]
          .map(([tool, count]) => ({ tool, count }))
          .sort((a, b) => b.count - a.count),
        events: {
          completed: toolEventsCompleted,
          failed: toolEventsFailed,
          rate: rate(toolEventsCompleted, toolEventsCompleted + toolEventsFailed),
        },
      },
      cost: {
        total: pricedCalls ? totalCost : null,
        pricedCalls,
        unpricedCalls,
        inputTokens: totalIn,
        outputTokens: totalOut,
        tasksWithCost: taskCosts.length,
        avgPerTask: taskCosts.length ? taskCosts.reduce((s, c) => s + c, 0) / taskCosts.length : null,
        medianPerTask: median(taskCosts),
        note:
          usage.length === 0
            ? "No model calls in this window."
            : pricedCalls === 0
              ? "No pricing: no model call carried an estimated cost. Add input/output prices to the models in LLM settings."
              : unpricedCalls > 0
                ? `${unpricedCalls} of ${usage.length} calls had no pricing and are left out of cost.`
                : null,
      },
      agents: agentRows,
      models: modelRows,
      modelAttribution: executionIdAttributed > 0 ? ("executionId" as const) : ("task_and_agent" as const),
      trend,
    };
  },
});
