import type {
  WorkerFileChange,
  WorkerSubtask,
} from "@/workerApi";
import type {
  ExecutionPlan,
} from "@/types";
import { normalizeCapability } from "@/orchestrator/capabilities";
import type { ReviewResult } from "@/utils/json";
import type { FileDiff } from "@/tools/gitDiff";
import type { RunState } from "./types";
import type { QaVerdict } from "@/types/qa";

/**
 * Build the executable state for a task from what the DB already holds:
 * subtask rows marked completed become completedKeys (with their
 * recorded outputs as priorOutputs), and the persisted file changes are
 * the staged work those subtasks produced. ONE builder is shared by
 * processTask (recovery of a re-claimed task whose stored plan was
 * adopted) and resumeTask (post-approval continuation), so a completed
 * subtask is never re-executed on either path (Phase 4). Since Phase 4
 * hardening, dynamic subtasks (delegation/fix/review-fix) are persisted
 * too — their rows are in `subtasks` and their definitions in the
 * stored plan payload — so the builder recovers the WHOLE DAG, not
 * just the initial plan. (Runtime derivations that are not persisted —
 * the per-branch capability chain and fix depth — are rebuilt from the
 * plan alone; see the Phase 4H report's limitations.)
 */
export function buildStateFromDb(input: {
  subtasks: WorkerSubtask[];
  fileChanges: WorkerFileChange[];
  /** Execution rows (for per-subtask file attribution, see below). */
  executions?: Array<{
    subtaskKey?: string;
    status?: string;
    meta?: unknown;
  }>;
}): { state: RunState; completedKeys: Set<string> } {
  // `waiting_approval` is a finished execution: requestApproval only moves
  // a subtask there after its work was produced. Counting it as done keeps
  // a resumed run (or a crash recovery) from executing that work again.
  const finished = input.subtasks.filter(
    (subtask) =>
      subtask.status === "completed" || subtask.status === "waiting_approval"
  );
  const completedKeys = new Set(finished.map((subtask) => subtask.key));
  const appliedFilesBySubtask = new Map<string, string[]>();
  for (const change of input.fileChanges) {
    if (!change.subtaskKey) continue;
    const existing = appliedFilesBySubtask.get(change.subtaskKey) ?? [];
    if (!existing.includes(change.filePath)) existing.push(change.filePath);
    appliedFilesBySubtask.set(change.subtaskKey, existing);
  }
  // The fileChanges table holds ONE row per file path: when several
  // code_change subtasks edit the same file (implement, then review-fix),
  // each save upserts the row and only the LAST writer's subtaskKey
  // survives. Rebuilding attribution from those rows alone collapses —
  // earlier writers look like they produced nothing, and the objective
  // evaluation then reports them as completed-without-changes. The
  // executions table keeps each subtask's own meta.filePaths, so union
  // it in: every subtask that really produced a change keeps its
  // attribution even when a later fix rewrote the same file.
  for (const execution of input.executions ?? []) {
    if (execution.status !== "completed" || !execution.subtaskKey) continue;
    const filePaths = (execution.meta as { filePaths?: unknown } | null | undefined)
      ?.filePaths;
    if (!Array.isArray(filePaths)) continue;
    const existing = appliedFilesBySubtask.get(execution.subtaskKey) ?? [];
    for (const filePath of filePaths) {
      if (typeof filePath === "string" && !existing.includes(filePath)) {
        existing.push(filePath);
      }
    }
    appliedFilesBySubtask.set(execution.subtaskKey, existing);
  }
  // Review/QA verdicts are not persisted as their own columns; they are
  // recoverable from the deterministic output the executor recorded on the
  // subtask. Seeding them lets a resumed run honour a pass that already
  // happened instead of re-running (and re-messaging) the same review.
  const reviewVerdicts: RunState["reviewVerdicts"] = {};
  const qaVerdicts: RunState["qaVerdicts"] = {};
  for (const subtask of finished) {
    const output = subtask.output ?? "";
    if (subtask.kind === "review") {
      const verdict = persistedReviewVerdict(output);
      if (verdict) reviewVerdicts[subtask.key] = { verdict, findings: [] };
    }
    if (subtask.kind === "qa") {
      const verdict = persistedQaVerdict(output);
      if (verdict) qaVerdicts[subtask.key] = verdict;
    }
  }
  const state: RunState = {
    priorOutputs: new Map(
      finished
        .filter((subtask) => subtask.output)
        .map((subtask) => [subtask.key, subtask.output as string])
    ),
    qaVerdicts,
    reviewVerdicts,
    fileChanges: new Map(
      input.fileChanges.map((change) => [change.filePath, toFileDiff(change)])
    ),
    appliedFilesBySubtask,
    feedback: [],
  };
  return { state, completedKeys };
}

/** Read a review verdict back from the output executeReview persisted. */
function persistedReviewVerdict(
  output: string
): ReviewResult["verdict"] | null {
  const text = output.trim();
  if (text.startsWith("Review approved")) return "approved";
  if (text.startsWith("Review requested changes")) return "changes_requested";
  return null;
}

/** Read a QA verdict back from the summary executeQa persisted. */
function persistedQaVerdict(
  output: string
): QaVerdict | null {
  const match = /QA verdict:\s*(passed|failed|inconclusive|blocked)/i.exec(output);
  if (!match) return null;
  const verdict = match[1].toLowerCase();
  return verdict === "passed" ||
    verdict === "failed" ||
    verdict === "inconclusive" ||
    verdict === "blocked"
    ? verdict
    : null;
}

/**
 * Plan 005 Phase 5 Step 5.3: replan without rework.
 *
 * A replan replaces the REMAINING graph, but completed work must survive:
 *  - `priorOutputs` and `fileChanges` carry over for a new subtask whose
 *    `(kind, capability, normalized description)` matches a completed old
 *    one (the plan builder reuses descriptions, so a carry-forward match
 *    means "the same work, still done");
 *  - `qaVerdicts` NEVER carry over: a replan means the code changed, so
 *    QA must re-validate (QA audit P1-7). QA nodes are never counted as
 *    completed carried work either. Same-plan resumes keep their verdicts
 *    through `buildStateFromDb`, not here;
 *  - `completedKeys` is recomputed from the carried-over matches;
 *  - only `feedback` is cleared.
 *
 * `previousState` is mutated in place for the caller's convenience and
 * returned; `previousPlan`/`newPlan` are only read.
 */
export function carryForwardState(
  previousPlan: ExecutionPlan,
  previousState: RunState,
  newPlan: ExecutionPlan
): { state: RunState; completedKeys: Set<string> } {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
  const signature = (subtask: { kind: string; capability: string; description: string }): string =>
    `${subtask.kind}|${normalizeCapability(subtask.capability)}|${normalize(subtask.description)}`;

  // Work that already finished: key -> signature of the OLD node.
  const completedOld = previousPlan.subtasks.filter((subtask) =>
    previousState.priorOutputs.has(subtask.key)
  );
  const signatures = new Map<string, string>();
  for (const subtask of completedOld) {
    const sig = signature(subtask);
    if (!signatures.has(sig)) signatures.set(sig, subtask.key);
  }

  const carriedOutputs = new Map<string, string>();
  const carriedFiles = new Map<string, FileDiff>();
  const completedKeys = new Set<string>();
  let anyMatch = false;

  for (const subtask of newPlan.subtasks) {
    const match = signatures.get(signature(subtask));
    if (match === undefined) continue;
    anyMatch = true;
    // QA must re-run after any replan: never carry its output/completion.
    if (subtask.kind === "qa") continue;
    const output = previousState.priorOutputs.get(match);
    if (output !== undefined) {
      carriedOutputs.set(subtask.key, output);
      completedKeys.add(subtask.key);
    }
  }

  // File changes are staged by file path (no per-node attribution in
  // state): when a carried-over node exists, its staged work lands in the
  // apply phase instead of being dropped with the old plan.
  if (anyMatch) {
    for (const [filePath, change] of previousState.fileChanges) {
      carriedFiles.set(filePath, change);
    }
  }

  previousState.priorOutputs = carriedOutputs;
  previousState.fileChanges = carriedFiles;
  previousState.qaVerdicts = {};
  previousState.qaChecks = undefined;
  previousState.feedback = [];
  return { state: previousState, completedKeys };
}

/** Shape a persisted file-change row into the executor's in-memory diff. */
export function toFileDiff(change: WorkerFileChange): FileDiff {
  return {
    filePath: change.filePath,
    changeType: change.changeType,
    oldContent: change.oldContent,
    newContent: change.newContent,
    oldContentHash: change.oldContentHash,
    newContentHash: change.newContentHash,
    diff: change.diff,
  };
}
