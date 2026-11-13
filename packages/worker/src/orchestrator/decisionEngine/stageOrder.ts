import * as path from "node:path";

/**
 * Exec-pipeline: the order executePlan runs its post-review stages in, and
 * the gate in front of the user's apply approval. Pure: facts in, decision
 * out.
 *
 *   verified_first  review → verify → QA → approval → land (merge).
 *                   The staged changes are written into the task's isolated
 *                   worktree (never the user's checkout) so verification and
 *                   QA run on them BEFORE the user is asked; the approval
 *                   then gates the merge into the user's branch.
 *   legacy          review → approval → apply → verify → QA. Kept only for a
 *                   run with no isolated worktree (no git, no commit yet, a
 *                   dirty checkout, a cloud backend that cannot reach the
 *                   worker's disk, or isolation turned off). There the only
 *                   place verification and QA can run is the user's own
 *                   checkout: a fresh temp checkout from HEAD would miss the
 *                   user's uncommitted edits and the installed dependencies
 *                   / dev server, so it would verify different code than the
 *                   code that lands. Writing there before approval is what
 *                   the approval exists to prevent.
 */
export type StageOrder = "verified_first" | "legacy";

export interface StageOrderDecision {
  order: StageOrder;
  reason: "isolated_worktree" | "no_worktree" | "worktree_not_workspace";
}

export function decideStageOrder(facts: { workspacePath: string; worktreePath?: string | null }): StageOrderDecision {
  if (!facts.worktreePath) return { order: "legacy", reason: "no_worktree" };
  // Staged writes land in input.workspacePath: only when that IS the task
  // worktree are they isolated from the user's checkout.
  if (path.resolve(facts.workspacePath) !== path.resolve(facts.worktreePath)) {
    return { order: "legacy", reason: "worktree_not_workspace" };
  }
  return { order: "verified_first", reason: "isolated_worktree" };
}

export type SnapshotReviewVerdict = "approved" | "changes_requested";

/** Review fix rounds already spent on this plan (`review_fix_<n>` nodes); the re-review budget continues from here. */
export function reviewFixRoundsSpent(subtasks: ReadonlyArray<{ key: string }>): number {
  return subtasks.filter((subtask) => /^review_fix_\d+$/.test(subtask.key)).length;
}

export interface ApprovalGateFacts {
  /** The plan has review nodes: approval needs an approve verdict on this exact snapshot. */
  reviewRequired: boolean;
  /** Snapshot id of the staged changes approval would cover. */
  snapshotId: string;
  /** Latest review verdict recorded per snapshot id. */
  reviewBySnapshot: Readonly<Record<string, SnapshotReviewVerdict>>;
  /** This invocation resumed from the user's apply approval. */
  approvalResolved: boolean;
  /** Snapshot the resumed approval was given for (the staged set when this invocation started). */
  approvedSnapshotId: string | null;
}

export type ApprovalGateDecision =
  /** The user's approval already covers exactly this snapshot: land it. */
  | { kind: "covered" }
  /** Ask (or let the permission mode / broker decide) for this snapshot. */
  | { kind: "ask" }
  /** Never ask for an unreviewed or rejected snapshot. */
  | { kind: "block"; reason: "unreviewed" | "review_rejected" };

export function decideApprovalGate(facts: ApprovalGateFacts): ApprovalGateDecision {
  if (facts.reviewRequired) {
    const verdict = facts.reviewBySnapshot[facts.snapshotId];
    if (verdict === undefined) return { kind: "block", reason: "unreviewed" };
    if (verdict !== "approved") return { kind: "block", reason: "review_rejected" };
  }
  // An approval covers the snapshot the user saw; a fix landed since then
  // (a resumed verification that had to fix something) needs a new one.
  if (facts.approvalResolved && facts.approvedSnapshotId === facts.snapshotId) return { kind: "covered" };
  return { kind: "ask" };
}
