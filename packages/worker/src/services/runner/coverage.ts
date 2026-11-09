import {
  computeRequirementCoverage,
  coverageBlocksDone,
  coverageGapNote,
  parseStoredRequirements,
  type CoverageReport,
  type CoverageSubtask,
} from "@/api/convex/lib/requirements";
import type { RunContext } from "./types";

export type CoverageOutcome =
  | { status: "skipped" }
  | { status: "covered"; report: CoverageReport }
  | { status: "gaps"; report: CoverageReport; note: string };

/**
 * Plan 025 coverage check, the last gate before "done" (after the
 * acceptance stage): every requirement extracted at plan time must be
 * served by a planned subtask that completed with passing evidence (a
 * passing gate, a passing QA verdict, or changed files) and no failing
 * evidence. Deterministic; no LLM. Tasks without stored requirements
 * (plans from before plan 025) are skipped.
 */
export async function runCoverageCheck(ctx: RunContext): Promise<CoverageOutcome> {
  const { deps, taskId, project, plan, state, dynamicKeys } = ctx;
  const context = await deps.api.getContext({ taskId }).catch(() => null);
  const requirements =
    plan.requirements && plan.requirements.length > 0
      ? plan.requirements
      : parseStoredRequirements((context?.task as { requirements?: unknown } | undefined)?.requirements);
  if (requirements.length === 0) return { status: "skipped" };

  const rows = new Map(((context?.subtasks ?? []) as Array<Record<string, any>>).map((row) => [String(row.key), row]));
  const subtasks: CoverageSubtask[] = plan.subtasks
    .filter((subtask) => !dynamicKeys.has(subtask.key) && subtask.origin !== "dynamic")
    .map((subtask) => {
      const row = rows.get(subtask.key);
      return {
        key: subtask.key,
        title: subtask.title,
        description: subtask.description,
        objective: subtask.objective,
        kind: subtask.kind,
        status: row?.status ?? (ctx.runCompleted.has(subtask.key) || ctx.input.completedKeys.has(subtask.key) ? "completed" : "pending"),
        origin: null,
        requirementIds: subtask.requirementIds ?? row?.requirementIds,
        acceptance: subtask.acceptance,
        acceptanceStatus: row?.acceptanceStatus ?? null,
        gateResults: row?.gateResults,
      };
    });

  const filesBySubtask: Record<string, string[]> = {};
  const addFile = (key: string | undefined, path: string) => {
    if (!key) return;
    const list = (filesBySubtask[key] ??= []);
    if (!list.includes(path)) list.push(path);
  };
  for (const [key, paths] of state.appliedFilesBySubtask) for (const path of paths) addFile(key, path);
  const changes = await deps.api.getFileChanges({ taskId }).catch(() => [] as Array<{ subtaskKey?: string; filePath: string }>);
  for (const change of changes as Array<{ subtaskKey?: string; filePath: string }>) addFile(change.subtaskKey, change.filePath);

  const report = computeRequirementCoverage({
    requirements,
    subtasks,
    qaVerdicts: state.qaVerdicts as Record<string, string>,
    filesBySubtask,
  });
  const blocks = coverageBlocksDone(report);
  await deps.api
    .logEvent({
      taskId,
      projectId: project._id,
      type: "requirements.coverage",
      payload: {
        complete: report.complete,
        blocksDone: blocks,
        covered: report.covered,
        missingEvidence: report.missingEvidence,
        uncovered: report.uncovered,
        requirements: report.requirements.map((entry) => ({
          id: entry.requirement.id,
          text: entry.requirement.text.slice(0, 200),
          state: entry.state,
          reason: entry.reason.slice(0, 300),
          subtasks: entry.subtasks.map((subtask) => subtask.key),
        })),
      },
      level: blocks ? "warn" : "info",
    })
    .catch(() => undefined);
  if (!blocks) return { status: "covered", report };
  return { status: "gaps", report, note: coverageGapNote(report) };
}

/** Record the coverage outcome on the task (best-effort; older backends lack the action). */
export async function recordCoverage(
  ctx: RunContext,
  report: CoverageReport,
  outcome: "covered" | "gaps" | "completed_with_gaps"
): Promise<void> {
  await ctx.deps.api
    .recordRequirementCoverage?.({
      taskId: ctx.taskId,
      outcome,
      covered: report.covered,
      missingEvidence: report.missingEvidence,
      uncovered: report.uncovered,
    })
    ?.catch(() => undefined);
}
