"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowUpRight, GitPullRequest } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Sidebar from "@/components/Sidebar";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { projectHref } from "@/lib/threadTree";
import { requestThread } from "@/lib/pendingThread";
import { relativeTime } from "@/lib/runFormat";

const STATE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  open: "active",
  merged: "ok",
  closed: "neutral",
};
const CI_TONE: Record<string, StatusTone> = {
  passed: "ok",
  failed: "danger",
  pending: "warn",
};
const REVIEW_TONE: Record<string, StatusTone> = {
  approved: "ok",
  changes_requested: "warn",
  commented: "neutral",
  none: "neutral",
};
const REVIEW_LABEL: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Commented",
  none: "",
};

/**
 * Pull Requests (plan 054): every PR Fhara opened, across all projects.
 * Read-only; merging still goes through the approval gate. Facts come from
 * the webhook/cron loop; no GitHub calls.
 */
function PullRequestsPage() {
  const prs = useQuery(api.pullRequests.list, {});
  const open = prs?.filter((p) => p.prState === "open").length ?? 0;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header>
            <h1 className="text-[26px] font-semibold tracking-tight">Pull Requests</h1>
            <p className="mt-1 text-[15px] text-ink-2">
              {prs === undefined
                ? "Loading…"
                : prs.length === 0
                  ? "No pull requests yet"
                  : `${open} open · ${prs.length} total`}
            </p>
          </header>

          {prs === undefined ? (
            <div className="mt-10 space-y-3" aria-label="Loading pull requests">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-hover" />
              ))}
            </div>
          ) : prs.length === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <GitPullRequest size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No pull requests yet.</p>
              <p className="mt-1 text-[13px] text-ink-3">PRs Fhara opens from a push show up here with their checks and review state.</p>
            </div>
          ) : (
            <ul className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {prs.map((pr) => {
                const title = pr.prTitle ?? `PR #${pr.prNumber}`;
                const branch = pr.baseBranch ? `${pr.branchName} → ${pr.baseBranch}` : pr.branchName;
                const inner = (
                  <>
                    <GitPullRequest size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px]">
                        <span className="text-ink-3">#{pr.prNumber}</span> {title}
                      </p>
                      <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
                        {`${pr.projectName} · `}
                        {pr.repoFullName} · {branch}
                        {pr.taskTitle ? ` · ${pr.taskTitle}` : ""}
                      </p>
                      {(pr.ciState || pr.reviewState || pr.mergeable === "conflict" || pr.autoMerge) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {pr.ciState && <StatusTag tone={CI_TONE[pr.ciState]}>CI {pr.ciState}</StatusTag>}
                          {pr.reviewState && REVIEW_LABEL[pr.reviewState] && (
                            <StatusTag tone={REVIEW_TONE[pr.reviewState]}>{REVIEW_LABEL[pr.reviewState]}</StatusTag>
                          )}
                          {pr.mergeable === "conflict" && <StatusTag tone="danger">Conflict</StatusTag>}
                          {pr.autoMerge && <StatusTag tone={pr.autoMerge.state === "blocked" ? "warn" : "neutral"}>Auto-merge: {pr.autoMerge.state}</StatusTag>}
                        </div>
                      )}
                    </div>
                  </>
                );
                return (
                  <li key={pr._id} className="flex items-center gap-2 pr-3">
                    <Link
                      href={projectHref(pr.projectId)}
                      onClick={() => requestThread(pr.projectId, pr.taskId)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 transition hover:bg-hover"
                    >
                      {inner}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusTag tone={STATE_TONE[pr.prState]}>{pr.prState}</StatusTag>
                      <span className="hidden text-[12.5px] tabular-nums text-ink-3 sm:inline">{relativeTime(pr.updatedAt)}</span>
                      {pr.prUrl && (
                        <a
                          href={pr.prUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          aria-label={`Open PR #${pr.prNumber} on GitHub`}
                          title="Open on GitHub"
                          className="rounded-lg p-2 text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                        >
                          <ArrowUpRight size={16} />
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

export default PullRequestsPage;
