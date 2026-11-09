import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { holdsTaskLease } from "./orchestration";
import { getVisibleTask } from "./lib/authz";
import {
  computeRequirementCoverage,
  parseStoredRequirements,
  type CoverageSubtask,
} from "./lib/requirements";

/**
 * Plan 025: intent-to-execution traceability and execution observations.
 * Public read projections for /runs/[taskId] and the task thread, plus
 * the worker's coverage record (lease-fenced, via worker.ts).
 */

const SUBTASK_CAP = 300;
const FILE_CAP = 500;
const OBSERVATION_CAP = 300;
const QA_EVENT_CAP = 50;

/** The worker's coverage check result before "done" (plan 025). */
export const recordRequirementCoverage = internalMutation({
  args: {
    taskId: v.id("tasks"),
    outcome: v.union(v.literal("covered"), v.literal("gaps"), v.literal("completed_with_gaps")),
    covered: v.array(v.string()),
    missingEvidence: v.array(v.string()),
    uncovered: v.array(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false as const, reason: "lease_lost" as const };
    }
    const task = await ctx.db.get(args.taskId);
    if (!task) return { applied: false as const, reason: "unknown_task" as const };
    await ctx.db.patch(args.taskId, {
      requirementCoverage: {
        checkedAt: Date.now(),
        outcome: args.outcome,
        covered: args.covered.slice(0, 50),
        missingEvidence: args.missingEvidence.slice(0, 50),
        uncovered: args.uncovered.slice(0, 50),
      },
    });
    return { applied: true as const };
  },
});

function qaVerdictFromEvents(events: Doc<"taskEvents">[]): string | undefined {
  const latest = events
    .filter((event) => event.type === "qa.passed" || event.type === "qa.failed" || event.type === "qa.blocked")
    .sort((a, b) => (b.createdAt ?? b._creationTime) - (a.createdAt ?? a._creationTime))[0];
  return latest ? latest.type.slice("qa.".length) : undefined;
}

/**
 * requirement → subtasks → acceptance → evidence → state, computed live
 * with the same deterministic check the worker runs before "done".
 */
export const requirements = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const list = parseStoredRequirements(task.requirements);
    if (list.length === 0) return { requirements: [], quotes: {} as Record<string, string>, coverage: task.requirementCoverage ?? null, report: null };
    // The words of the request each requirement came from (its span).
    const quotes: Record<string, string> = {};
    for (const requirement of list) {
      if (requirement.span) quotes[requirement.id] = task.command.slice(requirement.span.start, requirement.span.end).slice(0, 300);
    }
    const [subtasks, files, qaEvents] = await Promise.all([
      ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(SUBTASK_CAP),
      ctx.db.query("fileChanges").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(FILE_CAP),
      ctx.db
        .query("taskEvents")
        .withIndex("by_task_and_sequence", (q) => q.eq("taskId", task._id))
        .order("desc")
        .take(400)
        .then((rows) => rows.filter((row) => row.type.startsWith("qa.")).slice(0, QA_EVENT_CAP)),
    ]);
    const filesBySubtask: Record<string, string[]> = {};
    for (const change of files) {
      if (!change.subtaskKey) continue;
      (filesBySubtask[change.subtaskKey] ??= []).push(change.filePath);
    }
    const qa = qaVerdictFromEvents(qaEvents);
    const qaVerdicts: Record<string, string> = {};
    if (qa) for (const subtask of subtasks) if (subtask.kind === "qa" && subtask.status === "completed") qaVerdicts[subtask.key] = qa;
    const rows: CoverageSubtask[] = subtasks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((subtask) => ({
        key: subtask.key,
        title: subtask.title,
        description: subtask.description,
        objective: subtask.objective,
        kind: subtask.kind,
        status: subtask.status,
        origin: subtask.origin ?? null,
        requirementIds: subtask.requirementIds,
        acceptance: subtask.acceptance,
        acceptanceStatus: subtask.acceptanceStatus ?? null,
        gateResults: subtask.gateResults,
      }));
    const report = computeRequirementCoverage({ requirements: list, subtasks: rows, qaVerdicts, filesBySubtask });
    return { requirements: list, quotes, coverage: task.requirementCoverage ?? null, report };
  },
});

/** Typed execution observations of a task, oldest first. */
export const observations = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const rows = await ctx.db
      .query("executionObservations")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .order("desc")
      .take(OBSERVATION_CAP);
    return rows
      .reverse()
      .map((row) => ({
        _id: row._id,
        eventType: row.eventType,
        source: row.source,
        facts: row.facts,
        evidenceRefs: row.evidenceRefs,
        observedAt: row.observedAt,
      }));
  },
});
