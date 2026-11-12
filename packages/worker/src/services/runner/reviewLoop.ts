import { repeatedOutputStop } from "./repeatGuard";
import type { RunContext } from "./types";
import type { PlanSubtask } from "@/types";
import { collectRequestedChanges, formatReviewFindings } from "@/orchestrator/reviewLoop";
import { decideFixOwner } from "@/orchestrator/decisionEngine";

/**
 * The review correction loop (plan 012 step 2): corrections for a failing
 * review spawn targeted fix subtasks and the same review nodes re-run —
 * bounded by maxReviewIterations. Extracted verbatim from executePlan;
 * state that used to be captured is threaded through `ctx`.
 *
 * Loop ownership: while this loop runs (including its fix subtasks), the
 * objective is not judgeable — the loop closes its own findings when its
 * final verdict lands (plan 013 step 5).
 */
export async function runReviewLoop(ctx: RunContext): Promise<boolean> {
  const {
    reviewNodes,
    reviewNodeKeys,
    plan,
    state,
    runCompleted,
    dynamicKeys,
    chainByKey,
    fixDepthByKey,
    persistDynamic,
    deps,
    taskId,
    project,
    agents,
  } = ctx;
  const runNodes = (nodes: PlanSubtask[]) => ctx.runNodes(nodes);
  if (reviewNodes.length === 0) return true;
  ctx.inStageLoop = true;
  try {
    // Resume/recovery: a review that already approved before the
    // interruption has its verdict seeded into state by buildStateFromDb.
    // Re-running it would re-post the same messages and burn a whole
    // extra review cycle, so the stage counts as satisfied without
    // running any review node.
    if (
      reviewNodeKeys.every(
        (key) => state.reviewVerdicts[key]?.verdict === "approved"
      )
    ) {
      return true;
    }

    const maxIterations = deps.policy.maxReviewIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      for (const key of reviewNodeKeys) {
        delete state.reviewVerdicts[key];
        // The loop deliberately re-runs its own nodes: clear this run's
        // completion mark so the scheduler executes them again.
        runCompleted.delete(key);
      }
      // Round is stored separately (title stays stable); persist it so the
      // UI can render "Review (round N)" for the re-run review rows.
      if (iteration > 0) {
        const rerun = plan.subtasks.filter((s) => reviewNodeKeys.includes(s.key));
        for (const node of rerun) node.reviewRound = iteration + 1;
        await persistDynamic(rerun, "review_fix");
      }

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "reviewing", iteration, planVersion: plan.version },
      });

      const reviewRun = await runNodes(reviewNodes);
      if (reviewRun.status !== "completed") return false;

      const changesRequested = reviewNodeKeys.some(
        (key) => state.reviewVerdicts[key]?.verdict === "changes_requested"
      );
      if (!changesRequested) {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "review.approved",
          payload: { iteration },
        });
        // No chat narration: the Response Owner's one report at
        // completion carries the review outcome (O2). The approval itself is
        // recorded in events.
        return true;
      }

      const findings = collectRequestedChanges(state.reviewVerdicts, reviewNodeKeys);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.requested_changes",
        payload: { iteration, findings },
        level: "warn",
      });

      const reviewRepeat = await repeatedOutputStop(
        ctx,
        "review",
        findings.map((finding) => `${finding.filePath}: ${finding.description}`).join("\n")
      );
      if (reviewRepeat) {
        state.feedback.push(reviewRepeat);
        return false;
      }
      // L7: the Decision Engine owns "who fixes this, or does the loop stop?"
      // The fix goes to the agent that wrote the code the findings point at
      // (plan 040, one shared rule), never a catch-all owner.
      const next = decideFixOwner(
        {
          kind: "fix_needed",
          facts: { stage: "review", round: iteration, maxRounds: maxIterations, findings, nodes: plan.subtasks, writerByKey: ctx.agentByKey, agents },
        },
        ctx.uniqueSubtaskKey
      );
      switch (next.kind) {
        case "block":
          if (next.reason === "exhausted") {
            // Decision Outcome Calibration: the loop's stop decision.
            await Promise.resolve(
              deps.api.logEvent({
                taskId,
                projectId: project._id,
                type: "review.loop_stopped",
                payload: { iteration, maxIterations, findings: findings.length, reason: "max_iterations" },
                level: "warn",
              })
            ).catch(() => undefined);
            state.feedback.push(
              `Review still requested changes after ${maxIterations} fix attempt(s): ${findings
                .map((finding) => finding.description)
                .join("; ")}`
            );
            return false;
          }
          await Promise.resolve(
            deps.api.logEvent({
              taskId,
              projectId: project._id,
              type: "review.fix_unowned",
              payload: { iteration, findings: findings.length, reason: "no implementer owns the reviewed code" },
              level: "warn",
            })
          ).catch(() => undefined);
          state.feedback.push("No implementer agent owns the code these review findings point at, so no fix was attempted");
          return false;
        case "spawn_fix":
          break;
      }
      const implementer = next.agent;
      const fixSubtask = next.nodes[0];
      plan.subtasks.push(fixSubtask);
      dynamicKeys.add(fixSubtask.key);
      // Pin the fix to the owner (assign() would re-route by capability).
      ctx.agentByKey.set(fixSubtask.key, implementer);
      // The review loop owns this fix: register it as a fix-depth-1 node
      // on its own chain so an orchestrator evaluation of its outcome can
      // never spawn a second, duplicate fix subtask (Phase 3).
      chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
      fixDepthByKey.set(fixSubtask.key, 1);
      // The review loop's fix subtask is dynamic work too: persist it
      // like the orchestrator's (Phase 4 hardening).
      await persistDynamic([fixSubtask], "review_fix");
      state.priorOutputs.set(`${fixSubtask.key}-findings`, formatReviewFindings(findings));

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.fix_started",
        payload: {
          iteration: iteration + 1,
          findings: findings.length,
          agent: implementer.name,
        },
      });

      const fixRun = await runNodes([fixSubtask]);
      if (fixRun.status !== "completed") {
        state.feedback.push(`Review fix attempt ${iteration + 1} failed`);
        return false;
      }
    }

    return false;
  } finally {
    ctx.inStageLoop = false;
  }
}
