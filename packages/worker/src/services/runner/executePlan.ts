import { WebClient } from "@/tools/webClient";
import { snapshotIdForChanges } from "@/tools/gitDiff";
import { decideStageOrder } from "@/orchestrator/decisionEngine";
import type { ExecutePlanInput } from "./types";
import { stagehandConfigFrom } from "./setup";
import { createRunContext } from "./runContext";
import { runPipeline, type ExecutePlanResult } from "./execute/pipeline";
import { phasesFor } from "./execute/order";

export type { ExecutePlanResult } from "./execute/pipeline";

/**
 * The stage driver for one plan: a small phase pipeline (execute/order.ts).
 *
 * With an isolated task worktree the order is review → verify → QA →
 * approval → land: the staged changes are written into the worktree, so
 * the user approves code that was reviewed, verified and QA'd on that exact
 * snapshot, and only then is it merged. Without one (no git, no commit, a
 * dirty checkout, a cloud backend, isolation off) the legacy order review →
 * approval → apply → verify → QA stays: verification and QA can only run
 * in the user's own checkout there, which must not be written before the
 * approval (decisionEngine/stageOrder.ts says why a temp checkout is no
 * substitute). In both orders every verify / QA fix is re-reviewed.
 *
 * Each phase returns continue (optionally asking for a decision boundary)
 * or a terminal outcome; runPipeline is the one place boundaries
 * (waiting_input / paused / replan) are evaluated.
 */
export async function executePlan(input: ExecutePlanInput): Promise<ExecutePlanResult> {
  const browser = new WebClient({
    headless: true,
    ...stagehandConfigFrom(input.llmConfig),
  });
  try {
    if (input.plan.subtasks.length === 0) return { status: "failed" };
    const ctx = createRunContext(input, browser);
    const { order, reason } = decideStageOrder({
      workspacePath: input.workspacePath,
      worktreePath: input.worktree?.worktreePath,
    });
    ctx.stageOrder = order;
    // Announced only when it differs from the long-standing order (legacy
    // runs keep their event stream byte-identical).
    if (order === "verified_first") {
      await Promise.resolve(
      input.deps.api.logEvent({
        taskId: ctx.taskId,
        projectId: input.project._id,
        type: "task.stage_order",
        payload: { order, reason },
      })
      ).catch(() => undefined);
    }
    return await runPipeline(phasesFor(order), {
      ctx,
      order,
      baseSnapshotId: snapshotIdForChanges(Array.from(input.state.fileChanges.values())),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
