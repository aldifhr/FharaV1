import { applyQaCheck, buildQaCard, postStageCard } from "../cards";
import type { RunContext } from "../types";

/**
 * QA-specific node execution (plan 019): fold one QA `task.check` event into
 * the live QA checklist card of the pass in flight, and re-post the card
 * when a row changed (or the application URL was confirmed). A no-op
 * without a live card or a labelled check. Part of `runNodes`.
 */
export async function foldQaCheck(
  ctx: Pick<RunContext, "deps" | "taskId" | "project" | "qaCard">,
  payload: unknown
): Promise<void> {
  const check = payload as { label?: string; status?: string; details?: string } | undefined;
  const live = ctx.qaCard;
  if (!check?.label || !live) return;
  if (check.label === "application reachable" && check.status === "passed" && check.details) {
    live.url = check.details;
  }
  const before = JSON.stringify(live.rows);
  live.rows = applyQaCheck(live.rows, {
    label: check.label,
    status: check.status ?? "inconclusive",
    details: check.details,
  });
  if (JSON.stringify(live.rows) !== before || check.label === "application reachable") {
    await postStageCard(ctx.deps.api, {
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      agentId: live.agentId,
      kind: "qa",
      data: buildQaCard({
        outcome: "running",
        iteration: live.iteration,
        checks: [],
        rows: live.rows,
        fallbackUrl: live.url,
        idempotencyKey: live.key,
      }),
    });
  }
}
