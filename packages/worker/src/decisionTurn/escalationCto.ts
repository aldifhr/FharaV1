/**
 * GOAT G13: CTO-first for executor escalations (plan 022).
 *
 * Before services/runner/escalation.ts routes an escalation, this asks:
 *  1. Does the question cross the user-only ceiling (secrets, push,
 *     destructive, security, product)? Then it goes to the user, always,
 *     even where the deterministic policy would have replanned.
 *  2. Is it a technical question inside the CTO's ceiling, with CTO-first on?
 *     Then the CTO's decision turn answers it. The answer is committed to the
 *     `taskSignals` outbox with an audit row (decisionTurns.answer) before
 *     the run applies it, and consumed after; a run that dies in between
 *     gets the same committed answer back from `open` on its next attempt.
 *  3. Otherwise ("skip") the deterministic routeEscalation decides, exactly
 *     as before G13 (no CTO in the team, CTO-first off, the turn could not run).
 *
 * The CTO declining, or the turn expiring, sends the question to the user.
 * Expiry never picks an option.
 */
import { classifyQuestion, USER_ONLY_CATEGORIES } from "@/api/convex/lib/questionPolicy";
import { ESCALATION_LABELS, type Escalation, type EscalationKind } from "@/api/convex/lib/subtaskContract";
import { normalizePermissionMode } from "@/api/convex/lib/permissionModes";
import type { RunContext } from "@/services/runner/types";
import { CTO_QUESTION_SPEC } from "./ctoQuestion";
import { runDecisionTurn } from "./runDecisionTurn";

export type CtoEscalationResult =
  | { kind: "answered"; turnId: string; answer: string; chosenOption?: string; allow: boolean }
  | { kind: "user"; reason: string }
  | { kind: "skip"; reason: string };

/** The two outcomes the CTO chooses between, allowing first. */
export const ESCALATION_CHOICES: Partial<Record<EscalationKind, [string, string]>> = {
  new_dependency: ["Allow the dependency", "Do it without a new dependency"],
  schema_change: ["Allow the additive schema change", "Do it without a schema change"],
  out_of_scope: ["Widen the scope to this file", "Keep the current scope"],
};

export function escalationQuestion(subtaskKey: string, escalation: Escalation): string {
  const what = `${ESCALATION_LABELS[escalation.kind]}${escalation.detail ? ` (${escalation.detail})` : ""}`;
  return `Subtask "${subtaskKey}" stopped: ${what}. ${escalation.reason}`;
}

/** Only the user may decide this one (the hard ceiling), whatever the CTO-first setting. */
export function escalationNeedsUser(ctx: Pick<RunContext, "task">, subtaskKey: string, escalation: Escalation): string | null {
  const policy = classifyQuestion({
    kind: escalation.kind,
    question: escalationQuestion(subtaskKey, escalation),
    reason: escalation.reason,
    detail: escalation.detail,
    options: escalation.options,
    permissionMode: normalizePermissionMode((ctx.task as { permissionMode?: unknown }).permissionMode),
  });
  return policy.route === "user" && USER_ONLY_CATEGORIES.has(policy.category) ? policy.reason : null;
}

export async function askCtoFirst(ctx: RunContext, subtaskKey: string, escalation: Escalation): Promise<CtoEscalationResult> {
  const { deps, task, taskId } = ctx;
  const port = deps.decisionTurns;
  const config = deps.ctoFirst;
  if (!port || !config?.enabled) return { kind: "skip", reason: "CTO-first questions are off" };
  const choices = ESCALATION_CHOICES[escalation.kind];
  if (!choices) return { kind: "skip", reason: "Not a CTO question kind" };
  const question = escalationQuestion(subtaskKey, escalation);
  const opened = await port
    .open({
      taskId,
      workerId: deps.workerId,
      source: "escalation",
      delivery: "inline",
      question,
      options: [...choices],
      kind: escalation.kind,
      reason: escalation.reason,
      ...(escalation.detail ? { detail: escalation.detail } : {}),
      subtaskKey,
      dedupeKey: `esc:${taskId}:${subtaskKey}:${escalation.kind}:${escalation.detail ?? ""}`,
      ttlMs: config.ttlMs,
    })
    .catch((error: unknown) => ({ route: "error" as const, reason: error instanceof Error ? error.message : String(error) }));
  if (opened.route === "error") return { kind: "skip", reason: `Could not open the decision turn: ${opened.reason}` };
  if (opened.route === "user") return opened.noCto ? { kind: "skip", reason: opened.reason } : { kind: "user", reason: opened.reason };
  const turnId = String(opened.turnId);
  const answered = (answer: string, chosenOption?: string): CtoEscalationResult => ({
    kind: "answered",
    turnId,
    answer,
    ...(chosenOption ? { chosenOption } : {}),
    allow: chosenOption === choices[0],
  });
  // Committed earlier but never applied (the run died after the answer): deliver it now.
  if (opened.status === "answered") return answered(opened.answer, opened.chosenOption);

  const subtask = ctx.plan.subtasks.find((entry) => entry.key === subtaskKey);
  const outcome = await runDecisionTurn(
    CTO_QUESTION_SPEC,
    {
      question,
      options: [...choices],
      kind: escalation.kind,
      context: [task.title ? `Task: ${task.title}` : "", subtask ? `Subtask: ${subtask.title}. ${subtask.objective ?? subtask.description ?? ""}` : ""]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1500),
    },
    {
      agents: ctx.agents,
      llmResolver: ctx.input.llmResolver,
      llmConfig: ctx.input.llmConfig,
      assertBudgetForCall: ctx.input.assertBudgetForCall ?? (ctx.input.budget ? () => ctx.input.budget!.assertLlmCallAllowed() : undefined),
      onTokenUsage: ctx.input.onTokenUsage,
      llmTaskGate: ctx.input.llmTaskGate,
      signal: ctx.input.taskAbort?.signal,
      deadline: opened.expiresAt,
      ...(deps.decisionTurnAsk ? { ask: deps.decisionTurnAsk } : {}),
    }
  );
  if (outcome.verdict === "expired" || outcome.verdict === "unavailable") {
    await port.expire({ turnId, why: outcome.reason }).catch(() => undefined);
    return outcome.verdict === "expired" ? { kind: "user", reason: "The CTO did not answer in time" } : { kind: "skip", reason: outcome.reason };
  }
  const recorded = await port
    .answer({
      turnId,
      workerId: deps.workerId,
      verdict: outcome.verdict,
      ...(outcome.verdict === "answer" ? { answer: outcome.answer, ...(outcome.chosenOption ? { chosenOption: outcome.chosenOption } : {}) } : {}),
      rationale: outcome.rationale,
    })
    .catch(() => null);
  if (!recorded || !recorded.applied) {
    const reason = recorded && "reason" in recorded ? recorded.reason : "not recorded";
    return { kind: "user", reason: reason === "expired" ? "The CTO did not answer in time" : `The CTO's decision was not recorded (${reason})` };
  }
  if (recorded.status === "escalated" || outcome.verdict !== "answer") return { kind: "user", reason: `The CTO handed this to the user: ${outcome.rationale}` };
  return answered(outcome.answer, outcome.chosenOption);
}
