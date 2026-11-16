/**
 * Pull Requests page (plan 054): every PR Fhara opened, across the projects
 * the caller may see. Read path only — no GitHub calls, no mutations.
 *
 * PR facts live on `taskPushes` rows and are copied onto every row of the
 * same PR (`githubPush`, `prFeedback`). Rows are grouped by
 * `repoFullName#prNumber`; the row with the newest `prFactsAt ?? updatedAt`
 * wins. Fix-task rows carry `ownerTaskId`; the listed `taskId` is the task
 * that owns the PR, so the page can deep-link the thread that opened it.
 */
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { visibleProjects } from "./lib/authz";

/** taskPushes rows read per project (bounded; a project has a handful per task). */
const PROJECT_PUSH_LIMIT = 200;
/** PRs returned (bounded). */
const PULL_REQUEST_LIMIT = 100;

export interface PullRequestEntry {
  _id: Doc<"taskPushes">["_id"];
  repoFullName: string;
  prNumber: number;
  prUrl: string | null;
  prTitle: string | null;
  /** `prState` unset renders as open (facts only arrive once the PR exists). */
  prState: "draft" | "open" | "merged" | "closed";
  branchName: string;
  baseBranch: string | null;
  ciState: "pending" | "passed" | "failed" | null;
  reviewState: "none" | "approved" | "changes_requested" | "commented" | null;
  mergeable: "unknown" | "mergeable" | "conflict" | null;
  autoMerge: { state: string; reason: string } | null;
  projectId: Doc<"taskPushes">["projectId"];
  projectName: string;
  /** The task that owns the PR (`ownerTaskId ?? taskId`). */
  taskId: Doc<"taskPushes">["taskId"];
  taskTitle: string | null;
  /** `prFactsAt ?? updatedAt` of the winning row — what the list sorts on. */
  updatedAt: number;
}

function stampOf(row: Doc<"taskPushes">): number {
  return row.prFactsAt ?? row.updatedAt;
}

export const list = query({
  args: {},
  handler: async (ctx): Promise<PullRequestEntry[]> => {
    const visibleDocs = await visibleProjects(ctx);
    const projectNameById = new Map(visibleDocs.map((p) => [p._id as string, p.name]));

    const byPr = new Map<string, Doc<"taskPushes">>();
    for (const project of visibleDocs) {
      const rows = await ctx.db
        .query("taskPushes")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .take(PROJECT_PUSH_LIMIT);
      for (const row of rows) {
        if (row.prNumber === undefined || !row.repoFullName) continue;
        const key = `${row.repoFullName}#${row.prNumber}`;
        const current = byPr.get(key);
        if (!current || stampOf(row) > stampOf(current)) byPr.set(key, row);
      }
    }

    const winners = [...byPr.values()].sort((a, b) => stampOf(b) - stampOf(a)).slice(0, PULL_REQUEST_LIMIT);

    const taskIdOf = (row: Doc<"taskPushes">) => row.ownerTaskId ?? row.taskId;
    const titleById = new Map<string, string>();
    for (const row of winners) {
      const taskId = taskIdOf(row);
      if (titleById.has(taskId)) continue;
      const task = await ctx.db.get(taskId);
      if (task) titleById.set(taskId, task.title);
    }

    return winners.map((row) => {
      const taskId = taskIdOf(row);
      return {
        _id: row._id,
        repoFullName: row.repoFullName!,
        prNumber: row.prNumber!,
        prUrl: row.prUrl ?? null,
        prTitle: row.prTitle ?? null,
        prState: row.prState ?? "open",
        branchName: row.branchName,
        baseBranch: row.baseBranch ?? null,
        ciState: row.ciState ?? null,
        reviewState: row.reviewState ?? null,
        mergeable: row.mergeable ?? null,
        autoMerge: row.autoMerge ? { state: row.autoMerge.state, reason: row.autoMerge.reason } : null,
        projectId: row.projectId,
        projectName: projectNameById.get(row.projectId as string) ?? "",
        taskId,
        taskTitle: titleById.get(taskId) ?? null,
        updatedAt: stampOf(row),
      };
    });
  },
});
