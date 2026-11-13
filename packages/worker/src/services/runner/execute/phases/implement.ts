import { researchFailuresTolerated } from "@/prompts/research";
import type { SchedulerResult } from "@/scheduler/dagScheduler";
import { exit, failedOrCancelled, next, type Phase, type PipelineState } from "../pipeline";

/**
 * The implementation DAG. Step bound, cancellation and the CTO's
 * architecture verdict end the invocation here; a revise verdict, an
 * escalation or a user pause asks for a decision boundary (and only then:
 * a replan latched by a FAILED implementation still reports as failed).
 */
export const implementPhase: Phase = async (s) => {
  const { ctx } = s;
  const { deps, taskId, implementationNodes, reviewNodes, qaNodes, plan, state } = ctx;
  const implementation = await ctx.runNodes(implementationNodes);
  // Plan 005 Step 5.4: the decision step bound is terminal — fail the
  // task explicitly upstream, never mark it done or replan it.
  if (ctx.stepLimitHit) return exit({ status: "step_limit" });
  if (implementation.status === "cancelled") {
    await deps.api
      .updateSubtask({
        taskId,
        key: implementationNodes[0]?.key ?? reviewNodes[0]?.key ?? qaNodes[0]?.key ?? "unknown",
        status: "blocked",
      })
      .catch(() => undefined);
    // Cancellation is its own outcome (Phase 4 hardening): the caller
    // ends the task as cancelled instead of treating it as a failure
    // it could replan away.
    return exit({ status: "cancelled" });
  }
  // O1/O2: the CTO's architecture verdict decides the exit: stop holds the
  // task for the user (waiting_input; failed only when the pause was
  // refused), revise replans once.
  if (ctx.archDecision?.verdict === "stop") return exit({ status: ctx.waitingForInput !== null ? "waiting_input" : "failed" });
  // Plan 022: an escalation or a user pause decides this invocation's
  // exit even though the scheduler settled the stopped node as failed.
  const boundary = ctx.archDecision?.verdict === "revise" || ctx.escalated || ctx.paused;
  // O7: a /research run whose synthesis answered from the angles that
  // succeeded is complete; the failed angle is named in the answer.
  const failed = implementation.status !== "completed" && !researchFailuresTolerated(plan.subtasks, implementation);
  if (failed && boundary) {
    // The boundary decides first; with nothing latched the failure stands.
    s.implementationFailed = implementation;
    return next("check");
  }
  if (failed) return exit(implementationFailure(s, implementation));
  return next(boundary ? "check" : undefined);
};

function implementationFailure(s: PipelineState, implementation: SchedulerResult): ReturnType<typeof failedOrCancelled> {
  if (implementation.outcomes) {
    for (const [key, o] of implementation.outcomes) {
      if (o.status === "failed") s.ctx.state.feedback.push(`${key}: ${o.error ?? "failed without detail"}`);
    }
  }
  return failedOrCancelled(s.ctx);
}

/**
 * A failed implementation that survived its boundary fails here; otherwise
 * the stage boundary after implementation (plan 013 step 3): an engine
 * replan abandons the rest of this plan, processTask re-plans (bounded).
 */
export const implementationOutcomePhase: Phase = async (s) => {
  if (s.implementationFailed) return exit(implementationFailure(s, s.implementationFailed));
  return next("observe");
};
