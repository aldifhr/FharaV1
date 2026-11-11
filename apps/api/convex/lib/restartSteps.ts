/**
 * G4 restart continuation: the Convex readers behind it. The run context
 * carries the recorded tool steps of every cut-off subtask (and the
 * earlier continuations the loop guard counts); the direct-thread lease
 * recovery reads the steps of the cut-off turn. Pure logic lives in
 * `restartContinuation.ts`.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  DIRECT_STEP_EVENT_TYPES,
  SUBTASK_CONTINUED_EVENT,
  SUBTASK_STEP_EVENT_TYPES,
  interruptedSubtaskKeys,
  toRecordedStep,
  type RecordedStep,
} from "./restartContinuation";

/** Newest events read when looking for a cut-off run's steps. */
const STEP_SCAN = 2000;

async function newestEvents(ctx: Pick<QueryCtx, "db">, taskId: Id<"tasks">): Promise<Doc<"taskEvents">[]> {
  const rows = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(STEP_SCAN);
  return rows.reverse();
}

/**
 * Tool steps and earlier continuations of the subtasks a dead worker cut
 * off, oldest first. Empty (and no event read) when nothing was cut off.
 */
export async function loadRecordedSteps(
  ctx: Pick<QueryCtx, "db">,
  taskId: Id<"tasks">,
  subtasks: Doc<"subtasks">[],
  executions: Doc<"executions">[]
): Promise<RecordedStep[]> {
  const keys = new Set(interruptedSubtaskKeys(subtasks, executions));
  if (keys.size === 0) return [];
  const types = new Set<string>([...SUBTASK_STEP_EVENT_TYPES, SUBTASK_CONTINUED_EVENT]);
  return (await newestEvents(ctx, taskId))
    .filter((row) => row.subtaskKey && keys.has(row.subtaskKey) && types.has(row.type))
    .map(toRecordedStep);
}

/** Tool steps of one direct-thread turn (from its turn.started), oldest first. */
export async function loadDirectTurnSteps(
  ctx: Pick<QueryCtx, "db">,
  taskId: Id<"tasks">,
  turnId: string
): Promise<RecordedStep[]> {
  const rows = await newestEvents(ctx, taskId);
  const start = rows.findIndex((row) => row.eventKey === `turn.started:${turnId}`);
  const types = new Set<string>(DIRECT_STEP_EVENT_TYPES);
  return rows
    .slice(Math.max(0, start))
    .filter((row) => types.has(row.type))
    .map(toRecordedStep);
}

/** Times earlier continuations of this direct thread started (newest events). */
export async function directContinuationTimes(ctx: Pick<QueryCtx, "db">, taskId: Id<"tasks">): Promise<number[]> {
  const rows = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(200);
  return rows
    .filter((row) => row.type === "task.recovered" && (row.payload as { action?: unknown } | undefined)?.action === "direct_continued")
    .map((row) => row.createdAt ?? row._creationTime);
}
