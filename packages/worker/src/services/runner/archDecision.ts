/**
 * O1: the CTO architecture decision node's verdict (go / revise / stop).
 *
 * - go: the gated subtasks run (nothing to do here).
 * - revise: one bounded replan with the CTO's text as planner feedback. The
 *   decision node is frozen by the replan, so the CTO is not asked again; a
 *   second revise on an already-revised plan is treated as stop.
 * - stop: the task fails with the CTO's reason and is never replanned.
 * - no readable verdict: go, with a visible note (the CTO stays an advisor).
 */
import type { RunContext } from "./types";
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
  if (verdict === "go") return verdict;
  ctx.decisionTerminal = true;
  if (verdict === "revise") {
    if (ctx.replanFeedback === null) ctx.replanFeedback = `${ARCH_REVISE_FEEDBACK_PREFIX}. The CTO said: ${text}`;
    ctx.archDecision = { verdict, reason: text };
    return verdict;
  }
  const message = `Architecture decision: stop. The CTO said: ${text}`;
  ctx.state.terminalFailure = message;
  ctx.state.feedback.unshift(message);
  ctx.archDecision = { verdict, reason: text };
  return verdict;
}
