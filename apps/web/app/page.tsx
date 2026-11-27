import { useMemo } from "react";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { api } from "@fhara/runtime/api";
import { Link } from "@/lib/spaRouter";
import { Activity, AlertCircle, AlertTriangle, ArrowUpRight, FolderKanban, Plus } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import InitialAvatar from "@/components/InitialAvatar";
import { roleLabel } from "@/lib/agentRoles";
import { useNewProject } from "@/components/NewProject";
import { statusFromLeases, teamStatusLabel, type LeaseEntry } from "@/lib/teamStatus";
import { projectHref } from "@/lib/threadTree";
import { requestThread } from "@/lib/pendingThread";

/** Needs-you item kinds (shell.ts NeedsYouKind). */
const NEEDS_KIND_LABEL: Record<string, string> = {
  push: "Push",
  changes: "Apply changes",
  command: "Run command",
  merge: "Merge",
  question: "Question",
  review: "Review",
  pr: "Pull request",
  options: "Choose option",
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  needs_approval: "Approval",
  waiting_input: "Input",
  paused: "Paused",
  done: "Done",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

function ago(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function CardHeader({
  title,
  count,
  toneDot,
  aside,
}: {
  title: string;
  count?: number;
  toneDot?: "ok" | "warn" | "danger" | "brand";
  aside?: React.ReactNode;
}) {
  const dotClass =
    toneDot === "warn"
      ? "bg-warn"
      : toneDot === "danger"
        ? "bg-danger"
        : toneDot === "ok"
          ? "bg-ok"
          : toneDot === "brand"
            ? "bg-brand"
            : null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="flex items-center gap-2">
        {dotClass && <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />}
        <h2 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h2>
        {count !== undefined && (
          <span className="text-[12.5px] font-medium tabular-nums text-ink-3">{count}</span>
        )}
      </div>
      {aside}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-[13px] text-ink-3">{children}</p>;
}

/**
 * Overview: monitoring dashboard following dashboard-design-skill —
 * one-glance KPI strip, attention-first monitor grid, 3px project share bars,
 * and wordless tabular detail lists.
 */
export default function Home() {
  const { openNewProject } = useNewProject();
  const data = useQuery(api.overview.get, {});
  const active = useQuery(api.executionView.activeByAgent, {}) as Record<string, LeaseEntry> | undefined;
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);

  const running = useMemo(() => {
    if (!data || !active) return [];
    const status = statusFromLeases(active, { otherProjects: "elsewhere", checkFirst: "review" });
    const projectName = new Map(data.projects.map((p) => [String(p._id), p.name]));
    return Object.entries(active)
      .map(([agentId, lease]) => ({
        agent: data.agents.find((a) => String(a._id) === agentId),
        lease,
        word: teamStatusLabel(status[agentId]),
        projectName: projectName.get(String(lease.projectId)) ?? "",
      }))
      .filter((r) => r.agent);
  }, [data, active]);

  const totals = useMemo(() => {
    if (!data) return { tasks: 0, done: 0 };
    return data.perProject.reduce(
      (acc, p) => ({ tasks: acc.tasks + p.totalTasks, done: acc.done + p.done }),
      { tasks: 0, done: 0 },
    );
  }, [data]);

  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const attentionCount = data?.needsYou.total ?? 0;
  const failedTasks = data?.attentionTasks ?? [];
  const totalAgents = data?.agents.length ?? 0;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1440px] min-[112.5rem]:max-w-[1640px]">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-baseline gap-3">
              <h1 className="text-[24px] font-semibold tracking-tight text-ink">Overview</h1>
              <span className="text-[13px] text-ink-3">{today}</span>
            </div>
            <div className="flex items-center gap-2">
              {data !== undefined && active !== undefined && (
                <div
                  className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-[12.5px] font-medium text-ink-2 shadow-card"
                  title="Live workspace status"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      attentionCount > 0 ? "bg-warn" : running.length > 0 ? "bg-brand" : "bg-ok"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="tabular-nums">
                    {attentionCount > 0
                      ? `${attentionCount} waiting`
                      : running.length > 0
                        ? `${running.length} active`
                        : "All quiet"}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={openNewProject}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-ink shadow-card outline-none transition hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <Plus size={14} /> Project
              </button>
            </div>
          </header>

          {data === undefined || active === undefined ? (
            <div className="mt-6 space-y-5" aria-label="Loading overview">
              <div className="grid grid-cols-2 divide-x divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-20 rounded bg-hover" />
                    <div className="mt-3 h-8 w-14 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                <div className="h-64 rounded-2xl border border-line bg-panel shadow-card lg:col-span-7" />
                <div className="h-64 rounded-2xl border border-line bg-panel shadow-card lg:col-span-5" />
              </div>
            </div>
          ) : (
            <>
              {/* KPI Strip: one unified card, hairline dividers, tabular figures, zero sentences */}
              <section
                aria-label="Key metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                <div
                  className="p-5"
                  title={`${running.length} of ${totalAgents} agents currently executing`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Active agents</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <Activity size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2.5">
                    <span className={`text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${running.length > 0 ? "text-brand" : "text-ink"}`}>
                      {running.length}
                    </span>
                    <span className="text-[12.5px] tabular-nums text-ink-3">of {totalAgents}</span>
                  </div>
                </div>

                <Link
                  href="/inbox"
                  className="block p-5 transition hover:bg-hover/60"
                  title="Approvals, questions, and pull requests waiting for your decision"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Needs you</span>
                    <span className={`flex h-6 w-6 items-center justify-center rounded-md ${attentionCount > 0 ? "bg-warn-soft text-warn" : "bg-hover text-ink-3"}`}>
                      <AlertCircle size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2.5">
                    <span className={`text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${attentionCount > 0 ? "text-warn" : "text-ink"}`}>
                      {attentionCount}
                    </span>
                    <span className="text-[12.5px] text-ink-3">
                      {attentionCount > 0 ? "waiting" : "clear"}
                    </span>
                  </div>
                </Link>

                <div
                  className="p-5"
                  title={`${totals.done} completed out of ${totals.tasks} total tasks across ${data.projects.length} projects`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Projects</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <FolderKanban size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2.5">
                    <span className="text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">
                      {data.projects.length}
                    </span>
                    <span className="text-[12.5px] tabular-nums text-ink-3">
                      {totals.tasks > 0 ? `${totals.done}/${totals.tasks} done` : "no tasks"}
                    </span>
                  </div>
                </div>

                <div
                  className="p-5"
                  title="Recent tasks that failed or need attention"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Failures</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <AlertTriangle size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2.5">
                    <span className={`text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${failedTasks.length > 0 ? "text-danger" : "text-ink"}`}>
                      {failedTasks.length}
                    </span>
                    <span className="text-[12.5px] text-ink-3">
                      {failedTasks.length > 0 ? "recent" : "none"}
                    </span>
                  </div>
                </div>
              </section>

              {/* Monitor Grid: 12-column layout (7 + 5) */}
              <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
                {/* Primary monitor column */}
                <div className="space-y-5 lg:col-span-7">
                  {attentionCount > 0 && (
                    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                      <CardHeader
                        title="Needs you"
                        count={attentionCount}
                        toneDot="warn"
                        aside={
                          <Link href="/inbox" className="text-[12.5px] font-medium text-brand hover:underline">
                            Inbox →
                          </Link>
                        }
                      />
                      <ul className="divide-y divide-line">
                        {data.needsYou.items.slice(0, 6).map((item) => {
                          const decidable = item.approvalId !== null && item.kind !== "command";
                          const href = projectHref(item.projectId);
                          return (
                            <li key={item.key} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4 hover:bg-hover/50">
                              <Link
                                href={href}
                                onClick={() => item.taskId && requestThread(item.projectId, item.taskId)}
                                className="min-w-0 flex-1"
                              >
                                <p className="truncate text-[14px] font-medium text-ink">{item.title}</p>
                                <p className="truncate text-[12.5px] text-ink-3">
                                  {NEEDS_KIND_LABEL[item.kind] ?? item.kind} · {item.projectName}
                                  {item.note ? ` · ${item.note}` : ""}
                                </p>
                              </Link>
                              {decidable ? (
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => reject({ approvalId: item.approvalId! })}
                                    className="rounded-lg border border-line bg-panel px-2.5 py-1 text-[12.5px] font-medium text-ink-2 transition hover:bg-hover hover:text-ink"
                                  >
                                    Reject
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => approve({ approvalId: item.approvalId! })}
                                    className="rounded-lg bg-brand px-2.5 py-1 text-[12.5px] font-medium text-brand-ink transition hover:bg-brand-hover"
                                  >
                                    Approve
                                  </button>
                                </div>
                              ) : (
                                <Link
                                  href={href}
                                  onClick={() => item.taskId && requestThread(item.projectId, item.taskId)}
                                  className="shrink-0 text-ink-3 hover:text-ink max-sm:hidden"
                                  aria-label={`Open ${item.title}`}
                                >
                                  <ArrowUpRight size={15} />
                                </Link>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}

                  {running.length > 0 && (
                    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                      <CardHeader title="Working now" count={running.length} toneDot="brand" />
                      <ul className="divide-y divide-line">
                        {running.map(({ agent, lease, word, projectName }) => (
                          <li key={String(agent!._id)}>
                            <Link
                              href={`/project/${lease.projectId}`}
                              className="flex items-center gap-3 px-5 py-3 transition hover:bg-hover/60"
                            >
                              <InitialAvatar agent avatarParams={agent!.avatarParams} name={roleLabel(agent!.role)} size={28} status="working" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[14px]">
                                  <span className="font-medium text-ink">{roleLabel(agent!.role)}</span>
                                  <span className="text-ink-3"> · {word}</span>
                                </p>
                                <p className="truncate text-[12.5px] text-ink-3">
                                  {lease.taskTitle}{projectName ? ` · ${projectName}` : ""}
                                </p>
                              </div>
                              <span className="shell-dots flex shrink-0 items-center gap-[3px] text-brand" aria-hidden="true"><i /><i /><i /></span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Projects ranked breakdown with 3px bottom share track */}
                  <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                    <CardHeader
                      title="Projects"
                      count={data.perProject.length}
                      aside={
                        <span className="text-[12px] text-ink-3">Done / Total</span>
                      }
                    />
                    {data.perProject.length === 0 ? (
                      <Empty>No projects yet. Add a project folder to get started.</Empty>
                    ) : (
                      <ul className="divide-y divide-line">
                        {data.perProject.map((p) => {
                          const total = p.totalTasks;
                          const pct = total > 0 ? Math.round((p.done / total) * 100) : 0;
                          const barColor =
                            p.failed > 0 ? "bg-danger" : pct === 100 && total > 0 ? "bg-ok" : "bg-brand";
                          return (
                            <li key={p._id}>
                              <Link
                                href={`/project/${p._id}`}
                                className="group block px-5 pt-3 pb-2.5 outline-none transition hover:bg-hover/60 focus-visible:bg-hover/60"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2">
                                      <span className="truncate text-[14px] font-medium text-ink">{p.name}</span>
                                      <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{ago(p.lastActivityAt)}</span>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-3 text-[12.5px] tabular-nums">
                                    {p.running > 0 && <span className="font-medium text-brand">{p.running} running</span>}
                                    {p.pendingApprovals > 0 && <span className="font-medium text-warn">{p.pendingApprovals} waiting</span>}
                                    {p.failed > 0 && <span className="font-medium text-danger">{p.failed} failed</span>}
                                    <span className="w-16 text-right font-medium text-ink-2">
                                      {total > 0 ? `${p.done}/${total}` : "—"}
                                    </span>
                                    <span className="w-10 text-right text-ink-3">{total > 0 ? `${pct}%` : ""}</span>
                                  </div>
                                </div>
                                <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-line">
                                  <div
                                    className={`h-full rounded-full transition-all ${barColor}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>

                {/* Secondary monitor column */}
                <div className="space-y-5 lg:col-span-5">
                  {failedTasks.length > 0 && (
                    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                      <CardHeader title="Recent failures" count={failedTasks.length} toneDot="danger" />
                      <ul className="divide-y divide-line">
                        {failedTasks.map((t) => (
                          <li key={t._id}>
                            <Link href={`/project/${t.projectId}`} className="flex items-center gap-3 px-5 py-3 transition hover:bg-hover/60">
                              <span className="h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[14px] font-medium text-ink">{t.title}</p>
                                <p className="truncate text-[12.5px] text-ink-3">{TASK_STATUS_LABEL[t.status] ?? t.status} · {t.projectName}</p>
                              </div>
                              <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                    <CardHeader
                      title="Recent tasks"
                      count={data.recentTasks.length}
                      aside={
                        <Link href="/runs" className="text-[12.5px] font-medium text-ink-3 hover:text-ink">
                          All runs →
                        </Link>
                      }
                    />
                    {data.recentTasks.length === 0 ? (
                      <Empty>No tasks yet. Ask the team for something in a project chat.</Empty>
                    ) : (
                      <>
                        <div className="flex items-center justify-between border-b border-line px-5 py-2 text-[12px] text-ink-3">
                          <span>Task</span>
                          <span>Status</span>
                        </div>
                        <ul className="divide-y divide-line">
                          {data.recentTasks.slice(0, 8).map((t) => {
                            const dot =
                              t.status === "failed" || t.status === "rejected"
                                ? "bg-danger"
                                : t.status === "needs_approval" || t.status === "waiting_input"
                                  ? "bg-warn"
                                  : t.status === "running"
                                    ? "bg-brand"
                                    : t.status === "done"
                                      ? "bg-ok"
                                      : "bg-ink-3";
                            return (
                              <li key={t._id}>
                                <Link
                                  href={`/project/${t.projectId}`}
                                  className="flex items-center gap-3 px-5 py-2.5 text-[13.5px] transition hover:bg-hover/60"
                                >
                                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-medium text-ink">{t.title}</p>
                                    <p className="truncate text-[12px] text-ink-3">{t.projectName}</p>
                                  </div>
                                  <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-ink-2">
                                    {TASK_STATUS_LABEL[t.status] ?? t.status}
                                  </span>
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    )}
                  </section>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
