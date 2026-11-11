/**
 * Native questions in direct threads (plan N7): the transcript side.
 *
 * A question an ACP agent asks with its own question tool is a card in the
 * thread's events, not an approvals row (nothing to allow or deny):
 *
 *   approval.requested {kind: "question", questionId, itemId, question,
 *                       options, answerer: "user" | "cto", reason, turnId?}
 *   approval.resolved  {kind: "question", questionId, itemId,
 *                       decision: "answered", answer, by: "user" | "cto"}
 *
 * The answer itself is always the thread's next `user.message` (written by
 * directThreads.sendDirectMessage, which closes the open question). A
 * question routed to the CTO (G13 policy, decisionTurns.ts) is re-shown with
 * `answerer: "user"` when the CTO declines or runs out of time.
 *
 * No imports from directThreads.ts here: both it and decisionTurns.ts use
 * this file.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { appendTaskEvent } from "./taskEvents";

/** decisionTurns.dedupeKey prefix of a native question (MCP question.ask uses "mcp:"). */
export const NATIVE_QUESTION_DEDUPE = "native:";
const SCAN = 200;
const ANSWER_MAX = 2000;

export type QuestionAnswerer = "user" | "cto";

export interface OpenDirectQuestion {
  questionId: string;
  itemId: string;
  question: string;
  options: string[];
  multiple?: boolean;
  answerer: QuestionAnswerer;
  reason: string;
  turnId?: string;
}

export const nativeQuestionDedupeKey = (taskId: Id<"tasks">, itemId: string) => `${NATIVE_QUESTION_DEDUPE}${taskId}:${itemId}`;

type Payload = Record<string, unknown> | undefined;
const isQuestion = (p: Payload) => p?.kind === "question";

/** The thread's open question (the newest one, if nothing answered it since), else null. */
export async function openDirectQuestion(ctx: Pick<QueryCtx, "db">, taskId: Id<"tasks">): Promise<OpenDirectQuestion | null> {
  const rows = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(SCAN);
  for (const row of rows) {
    const p = row.payload as Payload;
    if (!isQuestion(p)) continue;
    if (row.type === "approval.resolved") return null;
    if (row.type !== "approval.requested" || !p) continue;
    return {
      questionId: String(p.questionId ?? p.itemId ?? ""),
      itemId: String(p.itemId ?? ""),
      question: String(p.question ?? ""),
      options: Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [],
      ...(p.multiple === true ? { multiple: true } : {}),
      answerer: p.answerer === "cto" ? "cto" : "user",
      reason: String(p.reason ?? ""),
      ...(typeof p.turnId === "string" ? { turnId: p.turnId } : {}),
    };
  }
  return null;
}

/** Write (or re-show) the question card. Idempotent per item and answerer. */
export async function showDirectQuestion(ctx: Pick<MutationCtx, "db">, task: Doc<"tasks">, q: OpenDirectQuestion): Promise<void> {
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "approval.requested",
    eventKey: `question.${q.answerer}:${q.itemId}`,
    payload: {
      kind: "question",
      questionId: q.questionId,
      itemId: q.itemId,
      question: q.question,
      options: q.options,
      ...(q.multiple ? { multiple: true } : {}),
      answerer: q.answerer,
      reason: q.reason,
      ...(q.turnId ? { turnId: q.turnId } : {}),
    },
    level: q.answerer === "user" ? "warn" : "info",
  });
}

/**
 * Close the open question with this answer (the message carrying it is
 * written by the caller). Returns the question it closed, or null when none
 * was open (or `turnId` is given and the open one isn't that CTO turn's).
 */
export async function resolveDirectQuestion(
  ctx: Pick<MutationCtx, "db">,
  task: Doc<"tasks">,
  answer: { text: string; by: QuestionAnswerer; turnId?: string }
): Promise<OpenDirectQuestion | null> {
  const open = await openDirectQuestion(ctx, task._id);
  if (!open || (answer.turnId !== undefined && open.turnId !== answer.turnId)) return null;
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "approval.resolved",
    eventKey: `question.answered:${open.itemId}`,
    payload: {
      kind: "question",
      questionId: open.questionId,
      itemId: open.itemId,
      decision: "answered",
      answer: answer.text.slice(0, ANSWER_MAX),
      by: answer.by,
    },
    level: "info",
  });
  return open;
}

/** The CTO declined or timed out: the same question, now for the user. False when it was no longer open. */
export async function handDirectQuestionToUser(ctx: Pick<MutationCtx, "db">, task: Doc<"tasks">, turnId: Id<"decisionTurns">, why: string): Promise<boolean> {
  const open = await openDirectQuestion(ctx, task._id);
  if (!open || open.answerer !== "cto" || open.turnId !== turnId) return false;
  await showDirectQuestion(ctx, task, { ...open, answerer: "user", reason: why === "expired" ? "The CTO did not answer in time" : "The CTO handed this to the user" });
  return true;
}
