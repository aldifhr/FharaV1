/**
 * Native questions in direct threads (plan N7).
 *
 * The worker (packages/worker/src/direct/acpSession.ts) turns OpenCode's
 * question tool call into `ask`: the question is routed by the G13 policy
 * (lib/questionPolicy.ts through decisionTurns.openDecisionTurn) and shown
 * as a card (lib/directQuestions.ts). The tool call itself is answered
 * cancelled and the agent ends its turn; the answer is the thread's next
 * `user.message`:
 *
 *  - the user answers (`answer`, or simply sends a message: directThreads.
 *    sendDirectMessage closes the open question with it);
 *  - within policy the CTO answers through the decision-turn runner
 *    (decisionTurn/poller.ts → decisionTurns.answer → deliver →
 *    `deliverCtoAnswer` here). Declined or expired: the card goes to the user.
 *
 * Secrets, push/merge/deploy and destructive questions never reach the CTO:
 * the policy is re-run here, whatever the worker sends.
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, assertServiceToken } from "./lib/authz";
import { holdsTaskLease } from "./orchestration";
import { openDecisionTurn } from "./decisionTurns";
import { sendDirectMessage } from "./directThreads";
import { nativeQuestionDedupeKey, openDirectQuestion, resolveDirectQuestion, showDirectQuestion } from "./lib/directQuestions";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);
const QUESTION_MAX = 2000;
const ANSWER_MAX = 20_000;

const cleanOptions = (options: readonly string[] | undefined) =>
  [...new Set((options ?? []).map((o) => o.trim().slice(0, 200)).filter(Boolean))].slice(0, 6);

async function directTask(ctx: Pick<MutationCtx, "db">, taskId: Id<"tasks">): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(taskId);
  if (!task || task.mode !== "direct" || !task.direct) throw new Error("Not a direct thread");
  if (TERMINAL.has(task.status)) throw new Error(`This thread is ${task.status}`);
  return task;
}

/** Worker: show one question card and route it. Idempotent per tool call. */
export const ask = mutation({
  args: {
    workerToken: v.string(),
    taskId: v.id("tasks"),
    workerId: v.string(),
    itemId: v.string(),
    question: v.string(),
    options: v.optional(v.array(v.string())),
    multiple: v.optional(v.boolean()),
    // The worker's CTO-first setting (FHARA_CTO_QUESTIONS); absent: the user answers.
    ctoFirst: v.optional(v.object({ ttlMs: v.number() })),
  },
  handler: async (ctx, args): Promise<{ route: "user" | "cto"; questionId: string; reason: string }> => {
    assertServiceToken(args.workerToken);
    const task = await directTask(ctx, args.taskId);
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error("Lease lost: this task is no longer owned by this worker");
    const itemId = args.itemId.trim().slice(0, 200);
    const question = args.question.trim().slice(0, QUESTION_MAX);
    if (!itemId || !question) throw new Error("A question needs an item id and a text");
    const open = await openDirectQuestion(ctx, task._id);
    if (open?.itemId === itemId) return { route: open.answerer, questionId: open.questionId, reason: open.reason };
    const options = cleanOptions(args.options);
    let route: "user" | "cto" = "user";
    let reason = "CTO-first questions are off";
    let turnId: string | undefined;
    if (args.ctoFirst) {
      const routed = await openDecisionTurn(ctx, {
        task,
        source: "direct",
        delivery: "task_input",
        question,
        options,
        dedupeKey: nativeQuestionDedupeKey(task._id, itemId),
        ttlMs: args.ctoFirst.ttlMs,
      });
      if (routed.route === "cto") {
        route = "cto";
        reason = "A technical question inside the CTO's ceiling";
        turnId = routed.turnId;
      } else reason = routed.reason;
    }
    await showDirectQuestion(ctx, task, {
      questionId: itemId,
      itemId,
      question,
      options,
      ...(args.multiple ? { multiple: true } : {}),
      answerer: route,
      reason,
      ...(turnId ? { turnId } : {}),
    });
    return { route, questionId: itemId, reason };
  },
});

/**
 * User: answer the open question (an option or free text). Posted as the
 * thread's next user.message, which closes the card and wakes the thread.
 */
export const answer = mutation({
  args: { taskId: v.id("tasks"), questionId: v.string(), answer: v.string(), clientId: v.string() },
  handler: async (ctx, args): Promise<{ eventId: Id<"taskEvents">; deduped: boolean }> => {
    const task = await directTask(ctx, args.taskId);
    await assertProjectAccess(ctx, task.projectId);
    const text = args.answer.trim();
    if (!text) throw new Error("The answer is empty");
    if (text.length > ANSWER_MAX) throw new Error(`The answer is too long (max ${ANSWER_MAX} characters)`);
    const clientId = args.clientId.trim();
    if (!clientId || clientId.length > 100) throw new Error("clientId is required (1-100 characters)");
    const open = await openDirectQuestion(ctx, task._id);
    if (!open || open.questionId !== args.questionId) {
      // A retried answer (same clientId) is the message already written.
      const sent = await ctx.db
        .query("taskEvents")
        .withIndex("by_task_and_event_key", (q) => q.eq("taskId", task._id).eq("eventKey", `user.message:${clientId}`))
        .first();
      if (sent) return { eventId: sent._id, deduped: true };
      throw new Error("This question was already answered");
    }
    const sent = await sendDirectMessage(ctx, task, text, clientId);
    return { eventId: sent.eventId, deduped: sent.deduped };
  },
});

/**
 * decisionTurns.deliver for a native question: the CTO's answer closes the
 * card and is posted as the next user.message. False when the question was
 * no longer open (the user answered first): nothing is sent.
 */
export async function deliverCtoAnswer(ctx: MutationCtx, task: Doc<"tasks">, turnId: Id<"decisionTurns">, text: string): Promise<boolean> {
  if (TERMINAL.has(task.status)) return false;
  const closed = await resolveDirectQuestion(ctx, task, { text, by: "cto", turnId });
  if (!closed) return false;
  await sendDirectMessage(ctx, task, `CTO: ${text}`, `cto-answer-${turnId}`);
  return true;
}
