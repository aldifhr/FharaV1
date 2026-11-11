/**
 * O1: the CTO architecture decision node's verdict (go / revise / stop).
 *
 * - go: the gated subtasks run (nothing to do here).
 * - revise: one bounded replan with the CTO's text as planner feedback. The
 *   decision node is frozen by the replan, so the CTO is not asked again; a
 *   second revise on an already-revised plan is treated as stop.
 * - stop: the task is held (O2): it pauses in `waiting_input` through the
 *   existing ask_user path with the CTO's reason and asks the user to resume
 *   or cancel. Resume continues the plan (the decision node stays completed);
 *   cancel ends the task as cancelled (`archStopCancelled`). Only when the
 *   pause is refused (lease lost, task already terminal) does it fail.
 * - no readable verdict: go, with a visible note (the CTO stays an advisor).
 */
import type { RunContext } from "./types";
import { archVerdictSystemLine, postSystemLine } from "./systemLines";
import {
  ARCH_DECISION_KEY,
  ARCH_REVISE_FEEDBACK_PREFIX,
  parseArchVerdict,
  type ArchVerdict,
} from "@/api/convex/lib/architectureFlag";

const REASON_CHARS = 600;

/** Applies the verdict of a completed decision node; null for any other node. */
export async function handleArchDecision(
  ctx: RunContext,
  nodeId: string,
  output: string | undefined,
  executionId: string | undefined
): Promise<ArchVerdict | null> {
  if (nodeId !== ARCH_DECISION_KEY) return null;
  const { verdict: read, parsed } = parseArchVerdict(output);
  const alreadyRevised = (ctx.plan.replan?.reason ?? "").includes(ARCH_REVISE_FEEDBACK_PREFIX);
  const verdict: ArchVerdict = read === "revise" && alreadyRevised ? "stop" : read;
  const text = (output ?? "").trim().slice(0, REASON_CHARS) || "no reason given";
  await ctx.deps.api
    .logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "architecture.decision",
      payload: {
        subtaskKey: nodeId,
        verdict,
        parsed,
        ...(verdict !== read ? { note: "a second revise after a revised plan stops the task" } : {}),
        ...(!parsed ? { note: "no Decision line in the CTO's answer: treated as go" } : {}),
      },
      ...(executionId ? { executionId } : {}),
      subtaskKey: nodeId,
      level: verdict === "go" ? "info" : "warn",
    })
    .catch(() => undefined);
  const line = (held: boolean) =>
    postSystemLine(ctx.deps, { taskId: ctx.taskId, projectId: ctx.project._id, content: archVerdictSystemLine(verdict, held) });
  if (verdict === "go") {
    await line(false);
    return verdict;
  }
  ctx.decisionTerminal = true;
  ctx.archDecision = { verdict, reason: text };
  if (verdict === "revise") {
    if (ctx.replanFeedback === null) ctx.replanFeedback = `${ARCH_REVISE_FEEDBACK_PREFIX}. The CTO said: ${text}`;
    await line(false);
    return verdict;
  }
  // stop → hold and ask (resume or cancel), never a silent failure.
  if (ctx.waitingForInput === null && typeof ctx.deps.api.pauseForInput === "function") {
    const question = archStopQuestion(text);
    const paused = await ctx.deps.api
      .pauseForInput({ taskId: ctx.taskId, question, options: [...ARCH_STOP_OPTIONS], workerId: ctx.deps.workerId })
      .catch(() => null);
    if (paused?.applied) {
      ctx.waitingForInput = question;
      await line(true);
      return verdict;
    }
  }
  const message = `Architecture decision: stop. The CTO said: ${text}`;
  ctx.state.terminalFailure = message;
  ctx.state.feedback.unshift(message);
  await line(false);
  return verdict;
}

/** The two answers a held `stop` offers (the first resumes, the second cancels). */
export const ARCH_STOP_OPTIONS = ["Resume the plan", "Cancel the task"] as const;

export function archStopQuestion(reason: string): string {
  return `The CTO recommends stopping before the gated work: ${reason}\n\nResume the plan anyway, or cancel the task?`;
}

/**
 * True when the user's answer to a held `stop` cancels the task: the plan's
 * decision node already completed and the latest answer is the cancel option
 * (or a bare "cancel"/"batal"/"stop").
 */
export function archStopCancelled(
  subtasks: ReadonlyArray<{ key: string; status: string }> | undefined,
  latestAnswer: string | undefined
): boolean {
  if (!latestAnswer) return false;
  if (!(subtasks ?? []).some((row) => row.key === ARCH_DECISION_KEY && row.status === "completed")) return false;
  const answer = latestAnswer.trim().toLowerCase().replace(/[.!]+$/, "");
  return answer === ARCH_STOP_OPTIONS[1].toLowerCase() || /^(cancel|batal|batalkan|stop)( (it|the task|task))?$/.test(answer);
}
