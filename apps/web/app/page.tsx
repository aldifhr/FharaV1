"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import { Folder, Trash2 } from "lucide-react";
import { useToast } from "@/components/Toasts";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import AgentAvatar from "@/components/AgentAvatar";
import { useNewProject } from "@/components/NewProject";
import { TextMorph } from "torph/react";
import { Skeleton, SkeletonBox } from "skullet/react";

const STATUS_DOT: Record<string, string> = {
  queued: "bg-amber-500",
  running: "bg-sky-500",
  needs_approval: "bg-rose-500",
  waiting_input: "bg-orange-500",
  done: "bg-emerald-500",
  rejected: "bg-gray-400",
  failed: "bg-red-500",
};
const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
};

function OverviewSkeleton() {
  return (
    <div aria-hidden className="pointer-events-none">
      <div className="flex items-start justify-between gap-4">
        <div>
          <SkeletonBox height={30} width={150} radius={8} />
          <SkeletonBox height={14} width={240} radius={6} className="mt-3" />
        </div>
        <SkeletonBox height={36} width={100} radius={8} />
      </div>

      <div className="mt-8 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="border-b border-r border-gray-200 p-5 last:border-b-0 sm:border-b-0 dark:border-gray-800">
              <SkeletonBox height={28} width={36} />
              <SkeletonBox height={11} width={72} className="mt-3" />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10">
        <SkeletonBox height={11} width={80} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-gray-200 p-5 dark:border-gray-800">
              <SkeletonBox height={28} width={28} radius={8} />
              <SkeletonBox height={14} width="40%" className="mt-3" />
              <SkeletonBox height={12} width="70%" className="mt-2" />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 grid gap-10 md:grid-cols-2">
        {[0, 1].map((col) => (
          <div key={col}>
            <SkeletonBox height={11} width={90} />
            <div className="mt-2 divide-y divide-gray-100 dark:divide-gray-800/80">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <SkeletonBox height={14} width="45%" />
                    <SkeletonBox height={11} width="30%" className="mt-2" />
                  </div>
                  <SkeletonBox height={12} width={44} radius={999} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const { openNewProject } = useNewProject();
  const data = useQuery(api.overview.get, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const removeAgent = useMutation(api.agents.remove);
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [removingAgentId, setRemovingAgentId] = useState<string | null>(null);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const stats = data ? [
    { label: "Project", value: data.projects.length, attention: false },
    { label: "Agent", value: data.agents.length, attention: false },
    { label: "Running tasks", value: data.taskCounts.byStatus.running ?? 0, attention: false },
    { label: "Needs approval", value: data.approvals.length, attention: data.approvals.length > 0 },
    { label: "Failed tasks", value: data.taskCounts.byStatus.failed ?? 0, attention: (data.taskCounts.byStatus.failed ?? 0) > 0 },
    { label: "Total task", value: data.taskCounts.total, attention: false },
  ] : [];

  const content = data ? (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-medium leading-tight tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Overview of all projects and agents.</p>
          <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{today}</p>
        </div>
        <button
          type="button"
          onClick={openNewProject}
          className="shrink-0 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          + Project
        </button>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-200 bg-gray-200 sm:grid-cols-3 xl:grid-cols-6 dark:border-gray-800 dark:bg-gray-800">
        {stats.map((s) => (
          <div key={s.label} className="bg-white p-5 dark:bg-[#12101f]">
            <p className="text-2xl font-medium tracking-tight tabular-nums"><TextMorph>{s.value}</TextMorph></p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              {s.attention && <span className={`h-1.5 w-1.5 rounded-full ${s.label === "Needs approval" ? "bg-rose-500" : "bg-red-500"}`} />}
              {s.label}
            </p>
          </div>
        ))}
      </div>

      {data.approvals.length > 0 && (
        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">
              Needs approval <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-gray-600 dark:bg-gray-800 dark:text-gray-300">{data.approvals.length}</span>
            </h2>
            <Link href="/inbox" className="text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">View inbox</Link>
          </div>
          <div className="mt-2 divide-y divide-gray-100 border-y border-gray-200 dark:divide-gray-800/80 dark:border-gray-800">
            {data.approvals.slice(0, 3).map((a) => (
              <div key={a._id} className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{a.summary}</p>
                  <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{a.projectName}{a.taskTitle ? ` · ${a.taskTitle}` : ""} · {KIND_LABEL[a.kind] ?? a.kind}</p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <button onClick={() => approve({ approvalId: a._id })} className="text-sm font-medium text-gray-900 hover:underline dark:text-white">Approve</button>
                  <button onClick={() => reject({ approvalId: a._id })} className="text-sm text-gray-500 hover:underline dark:text-gray-400">Reject</button>
                  <Link href={`/chats/${a.projectId}`} className="text-sm text-gray-500 hover:underline dark:text-gray-400">Open</Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">Project</h2>
          <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500">{data.perProject.length}</span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {data.perProject.map((p) => (
            <Link key={p._id} href={`/chats/${p._id}`} className="group flex items-center gap-3 rounded-xl border border-gray-200 p-3.5 transition hover:border-gray-300 hover:bg-gray-50/60 dark:border-gray-800 dark:hover:border-gray-600 dark:hover:bg-white/[0.03]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-400 dark:bg-white/5 dark:text-gray-500">
                <Folder size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                  {p.totalTasks > 0
                    ? `${p.totalTasks} tasks · ${p.running} running · ${p.pendingApprovals} pending · ${p.failed} failed`
                    : p.workspacePath}
                </p>
              </div>
              <span className="shrink-0 text-xs text-gray-300 transition group-hover:text-gray-500 dark:text-gray-600 dark:group-hover:text-gray-400">↗</span>
            </Link>
          ))}
          {data.perProject.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500 sm:col-span-2">
              No projects yet. Add a project folder with the + Project button.
            </div>
          )}
        </div>
      </section>

      <div className="mt-10 grid gap-10 md:grid-cols-2">
        <section>
          <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">Recent tasks</h2>
          <div className="mt-2 divide-y divide-gray-100 border-y border-gray-200 dark:divide-gray-800/80 dark:border-gray-800">
            {data.recentTasks.slice(0, 4).map((t) => (
              <Link key={t._id} href={`/chats/${t.projectId}`} className="flex min-w-0 items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm">{t.title}</p>
                  <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">{t.projectName}</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[t.status] ?? "bg-gray-400"}`} />
                  {t.status}
                </span>
              </Link>
            ))}
            {data.recentTasks.length === 0 && <p className="py-6 text-sm text-gray-400 dark:text-gray-500">No tasks yet.</p>}
          </div>
        </section>

        <section id="team">
          <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">Team ({data.agents.length})</h2>
          <div className="mt-2 divide-y divide-gray-100 border-y border-gray-200 dark:divide-gray-800/80 dark:border-gray-800">
            {data.agents.slice(0, 3).map((a) => (
              <div key={a._id} className="group flex items-center gap-3 py-3">
                <AgentAvatar name={roleLabel(a.role)} size={30} status={a.status} avatarParams={a.avatarParams} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{roleLabel(a.role)}</p>
                  <p className="truncate text-xs text-gray-400 dark:text-gray-500">{a.status}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveAgent(a._id, roleLabel(a.role))}
                  disabled={removingAgentId === a._id}
                  className="rounded p-1 text-gray-400 opacity-0 transition hover:text-gray-900 group-hover:opacity-100 max-[979px]:opacity-100 disabled:opacity-50 dark:hover:text-white"
                  title={`Delete ${roleLabel(a.role)}`}
                  aria-label={`Delete ${roleLabel(a.role)}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {data.agents.length > 3 && (
              <div className="flex items-center gap-3 py-3">
                <div className="flex -space-x-2">
                  {data.agents.slice(3, 6).map((a) => (
                    <span key={a._id} className="rounded-full ring-2 ring-white dark:ring-gray-900">
                      <AgentAvatar name={roleLabel(a.role)} size={24} status={a.status} avatarParams={a.avatarParams} />
                    </span>
                  ))}
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500">+{data.agents.length - 3} more</p>
              </div>
            )}
            {data.agents.length === 0 && <p className="py-6 text-sm text-gray-400 dark:text-gray-500">No agents yet. Create one from the sidebar (Team → +).</p>}
          </div>
        </section>
      </div>
    </>
  ) : null;

  async function confirmRemoveAgent(agentId: string, agentName: string) {
    setRemovingAgentId(agentId);
    try {
      await removeAgent({ agentId: agentId as never });
      toast("success", "Agent deleted", agentName);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete agent", err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setRemovingAgentId(null);
    }
  }

  function handleRemoveAgent(agentId: string, agentName: string) {
    setConfirmReq({
      title: `Delete agent "${agentName}"?`,
      message: "This agent will also be removed from projects that use it.",
      onOk: () => { void confirmRemoveAgent(agentId, agentName); },
    });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <ConfirmDialog request={confirmReq} pending={removingAgentId !== null} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <IconRail />
      <main className="relative min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[#635bff]/[0.05] to-transparent dark:from-[#635bff]/[0.08]" />
        <div className="relative mx-auto max-w-4xl">
          <Skeleton loading={data === undefined} skeleton={<OverviewSkeleton />} label="Loading overview">
            {content}
          </Skeleton>
        </div>
      </main>
    </div>
  );
}
