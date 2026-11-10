import path from "node:path";
import type { WorkerApi } from "@/workerApi";
import { defaultExecGit, GIT_TIMEOUT_MS, gitChildEnv, pushCommitToGithub, redactSecret, remoteBranchSha, type ExecGit } from "@/tools/gitPush";
import { findPullRequestByHead, openPullRequest, type FetchLike, type PullRequestResult } from "@/tools/githubPr";
import { guardedEffect, type GuardedResult, type SideEffectApi } from "./sideEffects";
import { registerSecretValues } from "@/utils/redact";
import type { AccessLogEntry, CommandRecorder } from "@/utils/accessLog";
import { checkCommitDependencies, type DepCheckResult } from "@/execution/depHardening";

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
  /**
   * L6: with the ledger methods present (the real WorkerApi), the push and
   * the PR call run under the no-replay ledger; a bare double without them
   * (unit tests) runs the writes directly.
   */
  api: Pick<WorkerApi, "claimPushRequest" | "completePushRequest"> & Partial<SideEffectApi> & Partial<Pick<WorkerApi, "recordAudit">>;
  workerId: string;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
  leaseMs?: number;
  execGit?: ExecGit;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Push lease: longer than the slowest push can take (the git kill timeout
 * plus the commit check and the PR call), so a slow push is never requeued
 * and pushed a second time by another worker while it is still running.
 */
export const PUSH_LEASE_MS = GIT_TIMEOUT_MS + 2 * 60_000;

/** Claim and run at most one push request. Returns whether one ran. */
export async function processNextPushRequest(deps: PushDeps): Promise<boolean> {
  const claim = await deps.api.claimPushRequest({ workerId: deps.workerId, leaseMs: deps.leaseMs ?? PUSH_LEASE_MS });
  if (!claim) return false;
  await handlePushRequest(claim, deps);
  return true;
}

export async function handlePushRequest(claim: PushClaim, deps: PushDeps): Promise<void> {
  const token = claim.token;
  // L2: the GitHub token is masked on every path out of the worker.
  registerSecretValues([token]);
  // Always an absolute cwd for git (a relative workspace path is resolved
  // against the worker's workspace root, never the process cwd).
  const repoPath = path.isAbsolute(claim.workspacePath)
    ? path.resolve(claim.workspacePath)
    : path.resolve(path.resolve(deps.workspaceRoot), claim.workspacePath);
  const repoFullName = `${claim.owner}/${claim.repo}`;
  const onCommand = pushCommandRecorder(claim, deps);
  // Never log the claim object itself: it carries the token.
  deps.log(`push ${claim.pushId}: ${claim.branchName}@${claim.commitSha.slice(0, 12)} → ${repoFullName}`);
  try {
    const ledger = sideEffectApi(deps.api);
    const shortSha = claim.commitSha.slice(0, 12);
    const doPush = () =>
      pushCommitToGithub({
        repoPath,
        owner: claim.owner,
        repo: claim.repo,
        commitSha: claim.commitSha,
        branchName: claim.branchName,
        // Push guard: never the base branch, never forced, unless allowed.
        baseBranch: claim.baseBranch,
        token,
        signal: deps.signal,
        execGit: deps.execGit,
        onCommand,
      });
    if (ledger) {
      // L6: armed before `git push`; an earlier attempt that was cut off
      // is settled by the remote branch SHA, never by pushing again.
      const pushed = await guardedEffect({
        api: ledger,
        workerId: deps.workerId,
        key: `push:${claim.pushId}:${claim.commitSha}`,
        kind: "push",
        taskId: claim.taskId,
        projectId: claim.projectId,
        pushId: claim.pushId,
        label: `the push of ${claim.branchName}@${claim.commitSha.slice(0, 7)} to ${repoFullName}`,
        perform: doPush,
        reconcile: async () => {
          const remote = await remoteBranchSha({
            owner: claim.owner,
            repo: claim.repo,
            branchName: claim.branchName,
            token,
            repoPath,
            execGit: deps.execGit,
            signal: deps.signal,
          });
          if (remote && remote === claim.commitSha.toLowerCase()) {
            return { status: "done", value: { remoteUrl: `https://github.com/${repoFullName}.git` }, evidence: { remoteSha: remote } };
          }
          return {
            status: "unknown",
            reason: remote
              ? `${claim.branchName} on GitHub is at ${remote.slice(0, 12)}, not ${shortSha}`
              : `${claim.branchName} does not exist on GitHub`,
            evidence: { remoteSha: remote },
          };
        },
        classifyError: pushErrorKind,
        evidenceOf: () => ({ commitSha: claim.commitSha }),
      });
      unwrap(pushed, "push");
      deps.log(`push ${claim.pushId}: ${pushed.status === "performed" ? "pushed" : `already on GitHub (${pushed.status})`}`);
    } else {
      await doPush();
    }
    let pr: PullRequestResult | undefined;
    if (claim.openPr && claim.existingPrNumber === undefined) {
      const doPr = () =>
        openPullRequest({
          owner: claim.owner,
          repo: claim.repo,
          token,
          head: claim.branchName,
          base: claim.baseBranch,
          title: claim.prTitle,
          body: claim.prBody,
          fetchImpl: deps.fetchImpl,
          signal: deps.signal,
          onCommand,
        });
      if (ledger) {
        // L6: an interrupted PR create is found by its head branch; only
        // GitHub listing none lets it be created (no second PR).
        const opened = await guardedEffect<PullRequestResult>({
          api: ledger,
          workerId: deps.workerId,
          key: `pr:${claim.pushId}:${claim.branchName}`,
          kind: "pr_create",
          taskId: claim.taskId,
          projectId: claim.projectId,
          pushId: claim.pushId,
          label: `the pull request for ${claim.branchName} on ${repoFullName}`,
          perform: doPr,
          reconcile: async () => {
            const found = await findPullRequestByHead({
              owner: claim.owner,
              repo: claim.repo,
              token,
              head: claim.branchName,
              fetchImpl: deps.fetchImpl,
              signal: deps.signal,
            });
            return found ? { status: "done", value: found } : { status: "absent" };
          },
          absentIsSafe: true,
          classifyError: (error) => (/timed out|aborted|fetch failed|ECONNRESET|socket hang up/i.test(String((error as Error)?.message ?? error)) ? "ambiguous" : "failed"),
          evidenceOf: (value) => ({ pr: value }),
          fromEvidence: (evidence) => (evidence as { pr?: PullRequestResult } | null)?.pr,
        });
        if (opened.status === "ambiguous") {
          // The push itself landed: report it; the card asks about the PR.
          deps.log(`push ${claim.pushId}: pull request unconfirmed (${opened.reason})`);
        } else {
          pr = unwrap(opened, "pull request");
        }
      } else {
        pr = await doPr();
      }
    }
    // O8: the dependency check on what this push adds (feeds auto-merge).
    const depCheck = await pushDependencyCheck(claim, repoPath, deps);
    await deps.api.completePushRequest({
      pushId: claim.pushId,
      workerId: deps.workerId,
      outcome: "pushed",
      repoFullName,
      baseBranch: claim.baseBranch,
      ...(pr ? { pr } : {}),
      dependencyCheck: { status: depCheck.status, high: depCheck.high, summary: depCheck.summary.slice(0, 500) },
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

/** The ledger half of the API, when the deps carry it. */
function sideEffectApi(api: PushDeps["api"]): SideEffectApi | null {
  if (
    typeof api.armSideEffect !== "function" ||
    typeof api.acceptSideEffect !== "function" ||
    typeof api.settleSideEffect !== "function" ||
    typeof api.markSideEffectAmbiguous !== "function"
  ) {
    return null;
  }
  return api as SideEffectApi;
}

/**
 * A push error that does not prove nothing was written: git was killed or
 * timed out, or the connection dropped mid-push. A rejection (non-fast-
 * forward, protected branch, 403, secret scan, invalid input) is clean.
 */
export function pushErrorKind(error: unknown): "failed" | "ambiguous" {
  const text = error instanceof Error ? error.message : String(error);
  if (/before contacting GitHub|Push blocked|Invalid|not in the local repository|\[rejected\]|non-fast-forward|protected branch|GH006|\b40[134]\b|permission .*denied|could not resolve host/i.test(text)) {
    return "failed";
  }
  if (/timed out|was killed|was cancelled|connection (reset|timed out)|early EOF|remote end hung up|RPC failed/i.test(text)) {
    return "ambiguous";
  }
  return "failed";
}

/** A guarded result → its value, or a thrown error the push handler reports. */
function unwrap<T>(result: GuardedResult<T>, what: string): T | undefined {
  switch (result.status) {
    case "performed":
    case "reconciled":
      return result.value;
    case "already_done":
      return result.value;
    case "ambiguous":
      throw new Error(
        `Fhara could not confirm whether the ${what} happened (${result.reason}). Use Check, Mark done or Retry on the card.`
      );
    case "failed":
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
}

/**
 * O5: one `cmd` audit row per git / GitHub API command of a push: the
 * sanitized argv, exit code and duration, never output or the token.
 */
export function pushCommandRecorder(claim: PushClaim, deps: Pick<PushDeps, "api" | "workerId" | "log">): CommandRecorder | undefined {
  const record = deps.api.recordAudit;
  if (!record) return undefined;
  return async (entry: AccessLogEntry) => {
    await record
      .call(deps.api, commandAuditRow(entry, { taskId: claim.taskId, projectId: claim.projectId, workerId: deps.workerId }))
      .catch((error: unknown) => deps.log(`push ${claim.pushId}: audit row not recorded: ${redactSecret(error instanceof Error ? error.message : String(error), claim.token)}`));
  };
}

/** The `audit` row for one command (tool "cmd", action "cmd.<tool>"). */
export function commandAuditRow<T, P>(entry: AccessLogEntry, ctx: { taskId?: T; projectId?: P; workerId?: string }) {
  return {
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
    actor: "worker",
    tool: "cmd",
    action: `cmd.${entry.tool}`,
    decision: "recorded" as const,
    target: [entry.tool, ...entry.argv].join(" ").slice(0, 200),
    details: {
      argv: entry.argv,
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
      success: entry.success,
      ...(entry.failureKind ? { failureKind: entry.failureKind } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    },
  };
}

/** O8: dependency check of the pushed commit against the base branch (never throws). */
export async function pushDependencyCheck(claim: PushClaim, repoPath: string, deps: Pick<PushDeps, "execGit" | "signal">): Promise<DepCheckResult> {
  const execGit = deps.execGit ?? defaultExecGit;
  // Read-only local git: not access-logged (only pushes, PRs and merges are).
  const git = (args: string[]) => execGit(args, { cwd: repoPath, env: gitChildEnv(), signal: deps.signal, timeoutMs: 30_000 });
  return await checkCommitDependencies(git, { commitSha: claim.commitSha, baseBranch: claim.baseBranch });
}
