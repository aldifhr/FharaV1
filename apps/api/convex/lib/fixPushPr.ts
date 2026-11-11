/**
 * A fix task's commit joins its owner's PR (post-push feedback loop): a PR
 * reaction fix (`prFix`) or a review-round fix (`reviewFix`, Paradev A3/A4)
 * commits on the owner's branch, so its push row inherits the owner's PR
 * and the push updates that PR instead of opening another.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type PushRow = Doc<"taskPushes">;

/**
 * The owner's PR row: newest push on the same project and branch that
 * carries a PR. A prFix task names its PR; a reviewFix task only names its
 * owner, so the owner's own pushes and its earlier fix pushes are searched.
 */
async function ownerPrRow(ctx: MutationCtx, task: Doc<"tasks">, projectId: Id<"projects">, branchName: string): Promise<PushRow | undefined> {
  let rows: PushRow[];
  if (task.prFix) {
    const { repoFullName, prNumber } = task.prFix;
    rows = await ctx.db
      .query("taskPushes")
      .withIndex("by_repo_pr", (q) => q.eq("repoFullName", repoFullName).eq("prNumber", prNumber))
      .take(100);
  } else {
    const ownerId = task.parentTaskId!;
    const own = await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", ownerId)).take(100);
    const fixes = await ctx.db.query("taskPushes").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerId)).take(100);
    rows = [...own, ...fixes].filter((row) => row.prNumber !== undefined);
  }
  return rows
    .filter((row) => row.projectId === projectId && row.branchName === branchName)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Fields a fix task's new push row inherits; empty for a task that is not a fix. */
export async function inheritedFixPush(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  projectId: Id<"projects">,
  branchName: string
): Promise<Partial<PushRow>> {
  if (!task.parentTaskId || !(task.prFix || task.reviewFix)) return {};
  const pr = await ownerPrRow(ctx, task, projectId, branchName);
  if (!pr) return { ownerTaskId: task.parentTaskId };
  return {
    ownerTaskId: task.parentTaskId,
    openPr: true,
    repoFullName: pr.repoFullName,
    baseBranch: pr.baseBranch,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    prTitle: pr.prTitle,
    prState: pr.prState,
    prCheckedAt: pr.prCheckedAt,
    headSha: pr.headSha,
    ciState: pr.ciState,
    ciChecks: pr.ciChecks,
    reviewState: pr.reviewState,
    mergeable: pr.mergeable,
  };
}
