
import { Suspense, useMemo, useState } from "react";
import { Link } from "@/lib/spaRouter";
import { useQuery } from "@fhara/runtime/react";
import { AlertTriangle, ArrowUpRight, GitMerge, GitPullRequest, Layers, Search } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import { PageHeader } from "@/components/ui/page-header";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import Segmented from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { projectHref } from "@/lib/threadTree";
import { requestThread } from "@/lib/pendingThread";
import { relativeTime } from "@/lib/runFormat";

type PrFilter = "all" | "open" | "draft" | "merged" | "closed";

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

type PullRequest = {
  _id: string;
  prNumber: number;
  prUrl: string | null;
  prTitle: string | null;
  prState: "draft" | "open" | "merged" | "closed";
  branchName: string;
  baseBranch: string | null;
  ciState: "pending" | "passed" | "failed" | null;
  reviewState: "none" | "approved" | "changes_requested" | "commented" | null;
  mergeable: "unknown" | "mergeable" | "conflict" | null;
  autoMerge: { state: string; reason: string } | null;
  projectId: string;
  projectName: string;
  repoFullName: string;
  taskId: string;
  taskTitle: string | null;
  updatedAt: number;
};

function needsAttention(pr: PullRequest): boolean {
  if (pr.prState !== "open" && pr.prState !== "draft") return false;
  return (
    pr.ciState === "failed" ||
    pr.reviewState === "changes_requested" ||
    pr.mergeable === "conflict" ||
    pr.autoMerge?.state === "blocked"
  );
}

function Metric({
  label,
  value,
  baseline,
  icon,
  tone = "",
  title,
}: {
  label: string;
  value: number;
  baseline: string;
  icon: React.ReactNode;
  tone?: string;
  title: string;
}) {
  return (
    <div className="p-4 sm:p-5" title={title}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption">{label}</span>
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-inset text-ink-3">{icon}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${tone}`}>{value}</span>
        <span className="truncate text-[12px] text-ink-3">{baseline}</span>
      </div>
    </div>
  );
}

/**
 * Pull Requests (plan 054): every PR Fhara opened, across all projects.
 * Read-only; merging still goes through the approval gate. Facts come from
 * the webhook/cron loop; no GitHub calls.
 */
function PullRequestsPage() {
  const prs = useQuery(api.pullRequests.list, {}) as PullRequest[] | undefined;
  const [filter, setFilter] = useState<PrFilter>("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [search, setSearch] = useState("");

  const stats = useMemo(() => {
    const list = prs ?? [];
    return {
      total: list.length,
      active: list.filter((p) => p.prState === "open" || p.prState === "draft").length,
      attention: list.filter(needsAttention).length,
      merged: list.filter((p) => p.prState === "merged").length,
      open: list.filter((p) => p.prState === "open").length,
      draft: list.filter((p) => p.prState === "draft").length,
      closed: list.filter((p) => p.prState === "closed").length,
    };
  }, [prs]);

  const visible = useMemo(() => {
    if (!prs) return [];
    const query = search.trim().toLowerCase();
    return prs.filter((pr) => {
      if (attentionOnly && !needsAttention(pr)) return false;
      if (filter !== "all" && pr.prState !== filter) return false;
      if (!query) return true;
      return [pr.prTitle, pr.repoFullName, pr.branchName, pr.projectName, pr.taskTitle, `#${pr.prNumber}`]
        .filter(Boolean)
        .some((part) => part!.toLowerCase().includes(query));
    });
  }, [prs, filter, attentionOnly, search]);

  const resetFilters = () => {
    setFilter("all");
    setAttentionOnly(false);
    setSearch("");
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1280px]">
          <PageHeader
            eyebrow={prs === undefined ? "All projects" : `${stats.total} pull requests`}
            title="Pull Requests"
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
                <GitPullRequest size={17} />
              </span>
            }
            meta={
              <p className="text-[13.5px] text-ink-2">
                PRs Fhara opened, newest first. Checks and reviews sync from GitHub; merging still needs your approval.
              </p>
            }
          />

          {prs === undefined ? (
            <div className="mt-6 space-y-4" aria-label="Loading pull requests">
              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-16 rounded bg-hover" />
                    <div className="mt-3 h-8 w-12 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="h-9 w-72 rounded-lg bg-hover" />
              <div className="h-72 rounded-2xl border border-line bg-panel shadow-card" />
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
            <>
              <section
                aria-label="Pull request metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                <Metric
                  label="In this list"
                  value={stats.total}
                  baseline="total"
                  icon={<Layers size={13} />}
                  title="Pull requests loaded across all projects"
                />
                <Metric
                  label="Active"
                  value={stats.active}
                  baseline={`${stats.open} open · ${stats.draft} draft`}
                  icon={<GitPullRequest size={13} />}
                  title="Open or draft pull requests in this list"
                />
                <Metric
                  label="Attention"
                  value={stats.attention}
                  baseline="need a look"
                  icon={<AlertTriangle size={13} />}
                  tone={stats.attention > 0 ? "text-danger" : ""}
                  title="Open or draft PRs with failed CI, requested changes, a merge conflict or blocked auto-merge"
                />
                <Metric
                  label="Merged"
                  value={stats.merged}
                  baseline="completed"
                  icon={<GitMerge size={13} />}
                  tone="text-ok"
                  title="Merged pull requests in this list"
                />
              </section>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Segmented
                  label="Filter pull requests by state"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "open", label: "Open" },
                    { value: "draft", label: "Draft" },
                    { value: "merged", label: "Merged" },
                    { value: "closed", label: "Closed" },
                  ]}
                />
                <button
                  type="button"
                  aria-pressed={attentionOnly}
                  onClick={() => setAttentionOnly((current) => !current)}
                  className={`inline-flex h-[30px] items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 ${
                    attentionOnly
                      ? "border-danger/40 bg-danger/5 text-danger"
                      : "border-line bg-panel text-ink-3 hover:bg-hover hover:text-ink"
                  }`}
                >
                  <AlertTriangle size={13} />
                  Needs attention {stats.attention}
                </button>
                <div className="relative w-full sm:ml-auto sm:w-56">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-ink-3" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search PRs"
                    aria-label="Search pull requests"
                    className="h-[30px] bg-panel pl-8 text-[12.5px]"
                  />
                </div>
              </div>

              <section className="mt-3 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                <div className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption sm:flex">
                  <span className="min-w-0 flex-1">Pull request</span>
                  <span className="w-16 shrink-0 text-right">State</span>
                  <span className="hidden w-36 shrink-0 lg:block">Checks</span>
                  <span className="w-16 shrink-0 text-right">Updated</span>
                  <span className="w-8 shrink-0" />
                </div>
                {visible.length === 0 ? (
                  <div className="flex flex-col items-center px-5 py-12 text-center">
                    <p className="text-[13.5px] text-ink-2">No pull requests match these filters.</p>
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="mt-3 rounded-field border border-line bg-panel px-2.5 py-1 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                    >
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {visible.map((pr) => {
                      const title = pr.prTitle ?? `PR #${pr.prNumber}`;
                      const branch = pr.baseBranch ? `${pr.branchName} → ${pr.baseBranch}` : pr.branchName;
                      const flagged = needsAttention(pr);
                      return (
                        <li key={pr._id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-inset/60">
                          <Link
                            href={projectHref(pr.projectId)}
                            onClick={() => requestThread(pr.projectId, pr.taskId)}
                            className="flex min-w-0 flex-1 items-start gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:basis-full"
                          >
                            {flagged ? (
                              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-label="Needs attention" />
                            ) : (
                              <GitPullRequest size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
                            )}
                            <div className="min-w-0">
                              <p className="flex min-w-0 items-baseline gap-2">
                                <span className="text-mono-id shrink-0">#{pr.prNumber}</span>
                                <span className="truncate text-[13.5px] font-medium text-ink">{title}</span>
                              </p>
                              <p className="mt-0.5 truncate text-[12px] text-ink-3">
                                {pr.projectName} · {pr.repoFullName} · <span className="font-mono">{branch}</span>
                                {pr.taskTitle ? ` · ${pr.taskTitle}` : ""}
                              </p>
                            </div>
                          </Link>
                          <div className="flex shrink-0 items-center gap-3 max-sm:ml-6 max-sm:w-full">
                            <div className="w-16 shrink-0 sm:text-right">
                              <StatusTag tone={STATE_TONE[pr.prState]}>{pr.prState}</StatusTag>
                            </div>
                            <div className="hidden w-36 shrink-0 flex-wrap gap-1 lg:flex">
                              {pr.ciState && <StatusTag tone={CI_TONE[pr.ciState]}>CI {pr.ciState}</StatusTag>}
                              {pr.reviewState && REVIEW_LABEL[pr.reviewState] && (
                                <StatusTag tone={REVIEW_TONE[pr.reviewState]}>{REVIEW_LABEL[pr.reviewState]}</StatusTag>
                              )}
                              {pr.mergeable === "conflict" && <StatusTag tone="danger">Conflict</StatusTag>}
                              {pr.autoMerge && (
                                <StatusTag tone={pr.autoMerge.state === "blocked" ? "warn" : "neutral"}>
                                  Auto-merge: {pr.autoMerge.state}
                                </StatusTag>
                              )}
                            </div>
                            <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-ink-3">
                              {relativeTime(pr.updatedAt)}
                            </span>
                            {pr.prUrl ? (
                              <a
                                href={pr.prUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                aria-label={`Open PR #${pr.prNumber} on GitHub`}
                                title="Open on GitHub"
                                className="flex w-8 shrink-0 justify-center rounded-lg p-1.5 text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:ml-auto"
                              >
                                <ArrowUpRight size={15} />
                              </a>
                            ) : (
                              <span className="w-8 shrink-0" />
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <p className="mt-2 text-[12px] text-ink-3">Showing {visible.length} of {stats.total} pull requests.</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function PullRequestsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <PullRequestsPage />
    </Suspense>
  );
}
