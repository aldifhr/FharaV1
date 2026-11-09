import { v } from "convex/values";
import { internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { DAY_MS } from "./lib/workload";
import {
  PERFORMANCE_DEFAULTS,
  PRIOR_SCORE,
  buildPerformanceSamples,
  scorePerformance,
  type PerfExecutionInput,
  type PerfSubtaskInput,
  type PerfTaskInput,
  type PerfUsageInput,
  type PerformanceScore,
} from "./lib/agentPerformance";

/**
 * Agent Performance Intelligence (plan 027): per-agent, per-capability
 * scores over a window (default 30 days), computed on read with caps — no
 * score table, no cron. The worker asks once per scheduling batch when
 * performance routing is on and keeps the answer for the run (10 min TTL);
 * the /team profile asks for one agent. Caps: 2000 subtasks, 150 tasks
 * (executions + token usage + coverage read per task, 200 rows each); a hit
 * cap is reported in `truncated`.
 */

const SUBTASK_LIMIT = 2000;
const TASK_LIMIT = 150;
const PER_TASK_LIMIT = 200;
const ALLOWED_WINDOWS = [7, 30, 90];

const windowDays = (value: number | undefined) =>
  ALLOWED_WINDOWS.includes(value ?? PERFORMANCE_DEFAULTS.windowDays) ? value ?? PERFORMANCE_DEFAULTS.windowDays : PERFORMANCE_DEFAULTS.windowDays;

function filePathsOf(meta: unknown): string[] {
  const paths = (meta as { filePaths?: unknown } | null | undefined)?.filePaths;
  return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string").slice(0, 200) : [];
}

export async function computePerformanceScores(
  ctx: QueryCtx,
  projects: Doc<"projects">[],
  sinceDays: number
): Promise<{ scores: PerformanceScore[]; truncated: string[]; sinceDays: number }> {
  const since = Date.now() - sinceDays * DAY_MS;
  const truncated = new Set<string>();
  const subtaskRows: Doc<"subtasks">[] = [];
  for (const p of projects) {
    const left = SUBTASK_LIMIT - subtaskRows.length;
    if (left <= 0) {
      truncated.add("subtasks");
      break;
    }
    const rows = await ctx.db
      .query("subtasks")
      .withIndex("by_project", (q) => q.eq("projectId", p._id).gte("_creationTime", since))
      .order("desc")
      .take(left + 1);
    if (rows.length > left) truncated.add("subtasks");
    subtaskRows.push(...rows.slice(0, left));
  }

  const taskIds = [...new Set(subtaskRows.map((s) => s.taskId as string))];
  if (taskIds.length > TASK_LIMIT) truncated.add("tasks");
  const keptTasks = new Set(taskIds.slice(0, TASK_LIMIT));
  const executions: PerfExecutionInput[] = [];
  const usage: PerfUsageInput[] = [];
  const tasks: PerfTaskInput[] = [];
  for (const taskId of keptTasks) {
    const id = taskId as Id<"tasks">;
    const execs = await ctx.db.query("executions").withIndex("by_task", (q) => q.eq("taskId", id)).take(PER_TASK_LIMIT);
    for (const e of execs) {
      executions.push({
        taskId,
        subtaskKey: e.subtaskKey ?? null,
        agentId: (e.agentId as string | undefined) ?? null,
        attempt: e.attempt,
        filePaths: filePathsOf(e.meta),
      });
    }
    const uses = await ctx.db.query("tokenUsage").withIndex("by_task", (q) => q.eq("taskId", id)).take(PER_TASK_LIMIT);
    for (const u of uses) {
      usage.push({
        taskId,
        subtaskKey: u.subtaskKey ?? null,
        agentId: (u.agentId as string | undefined) ?? null,
        tokens: u.inputTokens + u.outputTokens,
      });
    }
    const task = await ctx.db.get(id);
    const coverage = task?.requirementCoverage;
    if (coverage && coverage.outcome !== "covered") {
      tasks.push({ taskId, gaps: [...coverage.uncovered, ...coverage.missingEvidence] });
    }
  }

  const subtasks: PerfSubtaskInput[] = subtaskRows
    .filter((s) => keptTasks.has(s.taskId as string))
    .map((s) => ({
      taskId: s.taskId as string,
      key: s.key,
      capability: s.capability,
      kind: s.kind,
      status: s.status,
      origin: s.origin ?? null,
      agentId: (s.assignedAgentId as string | undefined) ?? null,
      attempts: s.attempts,
      dependencies: s.dependencies,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      at: s.startedAt ?? s._creationTime,
      acceptanceStatus: s.acceptanceStatus ?? null,
      gates: {
        pass: (s.gateResults ?? []).filter((g) => g.status === "pass").length,
        fail: (s.gateResults ?? []).filter((g) => g.status === "fail").length,
      },
      requirementIds: s.requirementIds ?? [],
    }));

  const samples = buildPerformanceSamples({ subtasks, executions, usage, tasks });
  return { scores: scorePerformance(samples), truncated: [...truncated], sinceDays };
}

/** Worker: scores for one project's history (performance routing). */
export const scoresForProject = internalQuery({
  args: { projectId: v.id("projects"), sinceDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { scores: [], truncated: [], sinceDays: windowDays(args.sinceDays) };
    return await computePerformanceScores(ctx, [project], windowDays(args.sinceDays));
  },
});

/** /team/[agentId]: this agent's score per capability, with the factor breakdown. */
export const agentScores = query({
  args: { agentId: v.id("agents"), projectId: v.optional(v.id("projects")), sinceDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return null;
    const projects = args.projectId ? [await assertProjectAccess(ctx, args.projectId)] : await visibleProjects(ctx);
    const result = await computePerformanceScores(ctx, projects, windowDays(args.sinceDays));
    return {
      scores: result.scores.filter((s) => s.agentId === (agent._id as string)),
      prior: Math.round(PRIOR_SCORE * 1000) / 1000,
      minSamples: PERFORMANCE_DEFAULTS.minSamples,
      sinceDays: result.sinceDays,
      truncated: result.truncated,
      performanceRouting: args.projectId ? (projects[0]?.performanceRouting ?? null) : null,
    };
  },
});

export const setPerformanceRouting = mutation({
  args: { projectId: v.id("projects"), enabled: v.union(v.boolean(), v.null()) },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const next = args.enabled ?? undefined;
    if (project.performanceRouting === next) return args.enabled;
    await ctx.db.patch(args.projectId, { performanceRouting: next });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["performanceRouting"], performanceRouting: args.enabled },
    });
    return args.enabled;
  },
});
