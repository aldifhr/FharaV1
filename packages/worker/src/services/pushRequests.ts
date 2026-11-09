import path from "node:path";
import type { WorkerApi } from "@/workerApi";
import { pushCommitToGithub, redactSecret, type ExecGit } from "@/tools/gitPush";
import { openPullRequest, type FetchLike, type PullRequestResult } from "@/tools/githubPr";

/**
 * Plan 019: the worker side of "Push & open PR".
 *
 * The backend never pushes: it records the user's approval and a
 * `requested` row. The worker claims it with a lease, pushes the task
 * commit with the project's GitHub token (environment only), opens a draft
 * PR when asked, and reports `pushed` / `failed`. The token is never
 * logged and every error message is redacted before it is reported.
 */

export type PushClaim = NonNullable<Awaited<ReturnType<WorkerApi["claimPushRequest"]>>>;

export interface PushDeps {
  api: Pick<WorkerApi, "claimPushRequest" | "completePushRequest">;
  workerId: string;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
  leaseMs?: number;
  execGit?: ExecGit;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

/** Claim and run at most one push request. Returns whether one ran. */
export async function processNextPushRequest(deps: PushDeps): Promise<boolean> {
  const claim = await deps.api.claimPushRequest({ workerId: deps.workerId, leaseMs: deps.leaseMs });
  if (!claim) return false;
  await handlePushRequest(claim, deps);
  return true;
}

export async function handlePushRequest(claim: PushClaim, deps: PushDeps): Promise<void> {
  const token = claim.token;
  const repoPath = path.isAbsolute(claim.workspacePath)
    ? claim.workspacePath
    : path.resolve(deps.workspaceRoot, claim.workspacePath);
  const repoFullName = `${claim.owner}/${claim.repo}`;
  // Never log the claim object itself: it carries the token.
  deps.log(`push ${claim.pushId}: ${claim.branchName}@${claim.commitSha.slice(0, 12)} → ${repoFullName}`);
  try {
    await pushCommitToGithub({
      repoPath,
      owner: claim.owner,
      repo: claim.repo,
      commitSha: claim.commitSha,
      branchName: claim.branchName,
      token,
      signal: deps.signal,
      execGit: deps.execGit,
    });
    let pr: PullRequestResult | undefined;
    if (claim.openPr && claim.existingPrNumber === undefined) {
      pr = await openPullRequest({
        owner: claim.owner,
        repo: claim.repo,
        token,
        head: claim.branchName,
        base: claim.baseBranch,
        title: claim.prTitle,
        body: claim.prBody,
        fetchImpl: deps.fetchImpl,
        signal: deps.signal,
      });
    }
    await deps.api.completePushRequest({
      pushId: claim.pushId,
      workerId: deps.workerId,
      outcome: "pushed",
      repoFullName,
      baseBranch: claim.baseBranch,
      ...(pr ? { pr } : {}),
    });
    deps.log(`push ${claim.pushId}: pushed${pr ? `, PR #${pr.number}` : ""}`);
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), token).slice(0, 1000);
    deps.log(`push ${claim.pushId}: failed: ${message}`);
    await deps.api
      .completePushRequest({
        pushId: claim.pushId,
        workerId: deps.workerId,
        outcome: "failed",
        error: message,
      })
      .catch((reportError: unknown) =>
        deps.log(
          `push ${claim.pushId}: could not report failure: ${redactSecret(
            reportError instanceof Error ? reportError.message : String(reportError),
            token
          )}`
        )
      );
  }
}
