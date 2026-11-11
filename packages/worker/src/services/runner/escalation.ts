import { routeEscalation, type Escalation } from "@/api/convex/lib/subtaskContract";
import { normalizePermissionMode } from "@/api/convex/lib/permissionModes";
import type { RunContext, RunState } from "./types";
import { askCtoFirst, ESCALATION_CHOICES, escalationNeedsUser, escalationQuestion, type CtoEscalationResult } from "@/decisionTurn/escalationCto";

/**
 * Plan 022: route one executor escalation. The executor already stopped
 * (nothing staged). GOAT G13: a question above the user-only ceiling goes
 * to the user; a technical one inside the CTO's ceiling goes to the CTO's
 * decision turn first (decisionTurn/escalationCto.ts). Otherwise a
 * deterministic policy decides (`routeEscalation`, system code):
 *
 *  - replan: the note becomes this invocation's replan feedback (the
 *    planner replans with the widened scope / the allowed dependency recorded);
 *  - ask_user: the task pauses in `waiting_input` through the existing
 *    ask_user path (pauseForInput), with the question and options.
 *
 * Always records `subtask.escalated` and the subtask's acceptance state
 * ("escalated", with the escalation) so /runs and the next run see it.
 * A replan requested inside a staged loop (verification / QA fix) cannot
 * be honoured mid-loop, so it is asked instead.
 */
export async function handleEscalation(
  ctx: RunContext,
  subtaskKey: string,
  escalation: Escalation,
  executionId?: string
): Promise<void> {
  const { deps, task, project, taskId, state } = ctx;
  const counts = (state.escalationCounts ??= new Map());
  const signature = `${subtaskKey}:${escalation.kind}`;
  const repeated = (counts.get(signature) ?? 0) > 0;
  counts.set(signature, (counts.get(signature) ?? 0) + 1);
  const permissionMode = normalizePermissionMode((task as { permissionMode?: unknown }).permissionMode);
  let route = routeEscalation(escalation, {
    subtaskKey,
    permissionMode,
    replansLeft: ctx.input.replansLeft ?? 0,
    repeated,
  });
  // GOAT G13: the user-only ceiling first (secrets, push, destructive, ...),
  // then the CTO's decision turn for technical questions inside its ceiling.
  const userOnly = escalationNeedsUser(ctx, subtaskKey, escalation);
  let cto: CtoEscalationResult = { kind: "skip", reason: userOnly ?? "repeated, stage loop or no replans left" };
  if (userOnly) {
    route = { route: "ask_user", question: `${escalationQuestion(subtaskKey, escalation)} How should the team proceed?`, ...(escalation.options ? { options: escalation.options } : {}) };
  } else if (!repeated && !ctx.inStageLoop && (ctx.input.replansLeft ?? 0) > 0) {
    cto = await askCtoFirst(ctx, subtaskKey, escalation);
    if (cto.kind === "answered") {
      route = { route: "replan", note: `Escalation from subtask ${subtaskKey}: ${escalationQuestion(subtaskKey, escalation)} CTO decision: ${cto.answer}` };
    } else if (cto.kind === "user") {
      const choices = ESCALATION_CHOICES[escalation.kind];
      route = { route: "ask_user", question: `${escalationQuestion(subtaskKey, escalation)} ${cto.reason}. How should the team proceed?`, ...(choices ? { options: [...choices] } : {}) };
    }
  }
  if (route.route === "replan" && ctx.inStageLoop) {
    route = {
      route: "ask_user",
      question: `Subtask "${subtaskKey}" stopped during a fix round: ${escalation.reason} How should the team proceed?`,
      ...(escalation.options ? { options: escalation.options } : {}),
    };
  }
  ctx.escalated = true;

  await deps.api
    .recordSubtaskAcceptance?.({
      taskId,
      key: subtaskKey,
      acceptanceStatus: "escalated",
      acceptanceReason: escalation.reason.slice(0, 500),
      escalation,
    })
    ?.catch(() => undefined);
  await deps.api
    .logEvent({
      taskId,
      projectId: project._id,
      type: "subtask.escalated",
      payload: {
        subtaskKey,
        kind: escalation.kind,
        reason: escalation.reason.slice(0, 500),
        ...(escalation.detail ? { detail: escalation.detail } : {}),
        source: escalation.source ?? "executor",
        route: route.route,
        permissionMode,
        repeated,
        decidedBy: cto.kind === "answered" ? "cto" : userOnly ? "user_only" : cto.kind === "user" ? "cto_escalated" : "policy",
      },
      executionId,
      subtaskKey,
      level: "warn",
    })
    .catch(() => undefined);

  if (route.route === "replan") {
    // The policy's allowance (dependency / schema file) is recorded so the
    // deterministic guard does not stop the replanned subtask on it again.
    const allowed = cto.kind === "answered" ? cto.allow : true;
    if (allowed && (escalation.kind === "new_dependency" || escalation.kind === "schema_change")) {
      (state.allowedEscalations ??= []).push({ kind: escalation.kind, detail: escalation.detail });
    }
    // The answer is applied (the replan note above): consume its outbox signal.
    if (cto.kind === "answered") await deps.decisionTurns?.consume({ turnId: cto.turnId, workerId: deps.workerId }).catch(() => undefined);
    ctx.decisionTerminal = true;
    if (ctx.replanFeedback === null) ctx.replanFeedback = route.note;
    return;
  }

  if (ctx.waitingForInput !== null) return;
  const paused = await deps.api
    .pauseForInput({
      taskId,
      question: route.question.slice(0, 1000),
      options: route.options,
      workerId: deps.workerId,
    })
    .catch(() => null);
  if (paused?.applied) {
    ctx.waitingForInput = route.question;
    ctx.decisionTerminal = true;
  }
}

/** Answers that decline the escalated action ("Do it without a new dependency"). */
const DECLINING_ANSWER = /\b(no|not|don't|do not|without|cancel|deny|denied|reject|skip|stop)\b/i;

/**
 * Seed the run's allowed escalations from the user's answer to an earlier
 * escalation question (the ask_user re-queue). An answer that declines the
 * action keeps the guard on, so the executor escalates again if it still
 * tries it. Only rows still marked "escalated" count.
 */
export function seedAllowedEscalations(
  state: RunState,
  rows: Array<{ acceptanceStatus?: string; escalation?: { kind: string; detail?: string } }>,
  latestUserAnswer: string | undefined
): void {
  if (!latestUserAnswer || DECLINING_ANSWER.test(latestUserAnswer)) return;
  for (const row of rows) {
    if (row.acceptanceStatus !== "escalated" || !row.escalation) continue;
    if (row.escalation.kind === "out_of_scope") continue; // scope widens only through a plan
    (state.allowedEscalations ??= []).push({ kind: row.escalation.kind, detail: row.escalation.detail });
  }
}
