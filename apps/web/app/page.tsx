"use client";

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import IconRail from "@/components/IconRail";
import InitialAvatar from "@/components/InitialAvatar";
import { roleLabel } from "@/lib/agentRoles";
import { useNewProject } from "@/components/NewProject";
import { statusFromLeases, teamStatusLabel, type LeaseEntry } from "@/lib/teamStatus";

/** Needs-you item kinds (shell.ts NeedsYouKind). */
const NEEDS_KIND_LABEL: Record<string, string> = {
  push: "Push",
  changes: "Apply changes",
  command: "Run command",
  merge: "Merge",
  question: "Question",
  review: "Review",
  pr: "Pull request",
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  needs_approval: "Needs approval",
  waiting_input: "Waiting for you",
  paused: "Paused",
  done: "Done",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

function ago(ts: number | null | undefined): string {
  if (!ts) return "No activity yet";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-[13px] font-medium text-ink-2">{children}</h2>
      {aside}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">{children}</p>;
}

/**
 * Overview: a calm dashboard. What is moving right now, what needs the
 * user, then each project with its progress. The roster lives on /team.
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

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  // Same number as the sidebar "Needs you" (one server definition, shell.ts).
  const attentionCount = data?.needsYou.total ?? 0;
  const failedTasks = data?.attentionTasks ?? [];

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[13px] text-ink-3">{today}</p>
              <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Overview</h1>
            </div>
            <button
              type="button"
              onClick={openNewProject}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <Plus size={14} /> Project
            </button>
          </header>

          {data === undefined ? (
            <div className="mt-10 space-y-3" aria-label="Loading overview">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : (
            <>
              <p className="mt-6 text-[15px] text-ink-2">
                {running.length > 0
                  ? `${running.length} ${running.length === 1 ? "agent is" : "agents are"} working`
                  : "All quiet right now"}
                {attentionCount > 0 ? (
                  <>
                    {" · "}
                    <span className="text-warn">{attentionCount} {attentionCount === 1 ? "thing needs" : "things need"} you</span>
                  </>
                ) : null}
                {" · "}
                {data.projects.length} {data.projects.length === 1 ? "project" : "projects"}
              </p>

              {running.length > 0 && (
                <section className="mt-10">
                  <SectionTitle aside={<Link href="/team" className="text-[12.5px] text-ink-3 hover:text-ink">Team</Link>}>
                    Working now
                  </SectionTitle>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                    {running.map(({ agent, lease, word, projectName }) => (
                      <li key={String(agent!._id)}>
                        <Link href={`/chats/${lease.projectId}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                          <InitialAvatar agent avatarParams={agent!.avatarParams} name={roleLabel(agent!.role)} size={28} status="working" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px]">
                              <span className="font-medium">{roleLabel(agent!.role)}</span>
                              <span className="text-ink-3"> · {word}</span>
                            </p>
                            <p className="truncate text-[12.5px] text-ink-3">
                              {lease.taskTitle}{projectName ? ` · ${projectName}` : ""}
                            </p>
                          </div>
                          <span className="shell-dots flex shrink-0 items-center gap-[3px] text-ink-3" aria-hidden="true"><i /><i /><i /></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {attentionCount > 0 && (
                <section className="mt-10">
                  <SectionTitle aside={<Link href="/inbox" className="text-[12.5px] text-ink-3 hover:text-ink">Inbox</Link>}>
                    Needs you
                  </SectionTitle>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                    {data.needsYou.items.slice(0, 6).map((item) => {
                      // Run-command approvals are allowed/denied in the task thread or Inbox.
                      const decidable = item.approvalId !== null && item.kind !== "command";
                      const href = `/chats/${item.projectId}${item.taskId ? `?task=${item.taskId}` : ""}`;
                      return (
                        <li key={item.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                          <Link href={href} className="min-w-0 flex-1">
                            <p className="truncate text-[14px]">{item.title}</p>
                            <p className="truncate text-[12.5px] text-ink-3">
                              {NEEDS_KIND_LABEL[item.kind] ?? item.kind} · {item.projectName}
                              {item.note ? ` · ${item.note}` : ""}
                            </p>
                          </Link>
                          {decidable ? (
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => reject({ approvalId: item.approvalId! })}
                                className="rounded-lg px-2.5 py-1 text-[13px] text-ink-2 transition hover:bg-hover"
                              >
                                Reject
                              </button>
                              <button
                                type="button"
                                onClick={() => approve({ approvalId: item.approvalId! })}
                                className="rounded-lg bg-ink px-2.5 py-1 text-[13px] font-medium text-canvas transition hover:opacity-90"
                              >
                                Approve
                              </button>
                            </div>
                          ) : (
                            <ArrowUpRight size={14} className="shrink-0 text-ink-3 max-sm:hidden" />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {failedTasks.length > 0 && (
                <section className="mt-10">
                  <SectionTitle>Recent failures</SectionTitle>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                    {failedTasks.map((t) => (
                      <li key={t._id}>
                        <Link href={`/chats/${t.projectId}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px]">{t.title}</p>
                            <p className="truncate text-[12.5px] text-ink-3">{TASK_STATUS_LABEL[t.status] ?? t.status} · {t.projectName}</p>
                          </div>
                          <ArrowUpRight size={14} className="shrink-0 text-ink-3" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="mt-10">
                <SectionTitle>Projects</SectionTitle>
                {data.perProject.length === 0 ? (
                  <Empty>No projects yet. Add a project folder to get started.</Empty>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {data.perProject.map((p) => {
                      const total = p.totalTasks;
                      const pct = total > 0 ? Math.round((p.done / total) * 100) : 0;
                      return (
                        <li key={p._id}>
                          <Link
                            href={`/chats/${p._id}`}
                            className="group block h-full rounded-xl border border-line bg-panel p-4 outline-none transition hover:border-line-strong focus-visible:ring-2 focus-visible:ring-ink/30"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <p className="truncate text-[15px] font-medium">{p.name}</p>
                              <ArrowUpRight size={14} className="shrink-0 text-ink-3 opacity-0 transition group-hover:opacity-100" />
                            </div>
                            <p className="mt-0.5 text-[12.5px] text-ink-3">{ago(p.lastActivityAt)}</p>
                            <div className="mt-4 h-1 overflow-hidden rounded-full bg-hover">
                              <div className="h-full rounded-full bg-ink-2 transition-all" style={{ width: `${pct}%` }} />
                            </div>
                            <p className="mt-2 flex flex-wrap gap-x-3 text-[12.5px] text-ink-3">
                              <span>{total > 0 ? `${p.done}/${total} done` : "No tasks yet"}</span>
                              {p.running > 0 && <span className="text-ink-2">{p.running} running</span>}
                              {p.pendingApprovals > 0 && <span className="text-warn">{p.pendingApprovals} to approve</span>}
                              {p.failed > 0 && <span className="text-red-500">{p.failed} failed</span>}
                            </p>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="mt-10">
                <SectionTitle>Recent tasks</SectionTitle>
                {data.recentTasks.length === 0 ? (
                  <Empty>No tasks yet. Ask the team for something in a project chat.</Empty>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.recentTasks.slice(0, 6).map((t) => (
                      <li key={t._id}>
                        <Link href={`/chats/${t.projectId}`} className="flex items-center gap-4 py-2.5 text-[14px] transition hover:text-ink-2">
                          <span className="min-w-0 flex-1 truncate">{t.title}</span>
                          <span className="hidden shrink-0 truncate text-[12.5px] text-ink-3 sm:inline">{t.projectName}</span>
                          <span className="w-28 shrink-0 text-right text-[12.5px] text-ink-3">{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
