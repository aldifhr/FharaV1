"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { useToast } from "@/components/Toasts";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import AgentAvatar from "@/components/AgentAvatar";
import { useNewProject } from "@/components/NewProject";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import { TextMorph } from "torph/react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton, SkeletonBox } from "skullet/react";

const STATUS_PILL: Record<string, string> = {
  queued: "bg-amber-100 text-amber-700",
  running: "bg-sky-100 text-sky-700",
  needs_approval: "bg-rose-100 text-rose-700",
  done: "bg-emerald-100 text-emerald-700",
  rejected: "bg-gray-200 text-gray-600",
  failed: "bg-red-100 text-red-700",
};
const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
};

function OverviewSkeleton() {
  return (
    <div aria-hidden className="pointer-events-none">
      <div className="flex items-center justify-between gap-3">
        <div>
          <SkeletonBox height={30} width={160} radius={8} />
          <SkeletonBox height={14} width={240} radius={6} className="mt-3" />
        </div>
        <SkeletonBox height={38} width={104} radius={8} />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-[#ebe9f0] p-3 dark:border-gray-800">
            <SkeletonBox height={28} width={48} />
            <SkeletonBox height={12} width={72} className="mt-2" />
          </div>
        ))}
      </div>

      <div className="mt-6">
        <SkeletonBox height={14} width={80} />
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <SkeletonBox height={16} width="40%" />
              <SkeletonBox height={12} width="70%" className="mt-2" />
              <SkeletonBox height={12} width="55%" className="mt-2" />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {[0, 1].map((col) => (
          <div key={col}>
            <SkeletonBox height={14} width={90} />
            <div className="mt-2 grid gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-800"
                >
                  <div className="w-full">
                    <SkeletonBox height={14} width="45%" />
                    <SkeletonBox height={12} width="30%" className="mt-2" />
                  </div>
                  <SkeletonBox height={20} width={48} radius={999} />
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

  const stats = data ? [
    { label: "Project", value: data.projects.length },
    { label: "Agent", value: data.agents.length },
    { label: "Running tasks", value: data.taskCounts.byStatus.running ?? 0 },
    { label: "Needs approval", value: data.approvals.length },
    { label: "Failed tasks", value: data.taskCounts.byStatus.failed ?? 0 },
    { label: "Total task", value: data.taskCounts.total },
  ] : [];

  const content = data ? (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="mt-1 text-sm text-gray-500">Overview of all projects and agents.</p>
        </div>
        <button
          type="button"
          onClick={openNewProject}
          className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          + Project
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {stats.map((s, i) => (
          <BlurFade key={s.label} delay={i * 0.05} inView>
            <Card className="relative overflow-hidden py-3">
              <CardContent className="p-3">
                <p className="text-2xl font-semibold"><TextMorph>{s.value}</TextMorph></p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </CardContent>
            </Card>
          </BlurFade>
        ))}
      </div>

      {data.approvals.length > 0 && (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Needs approval ({data.approvals.length})</h2>
            <Link href="/inbox" className="text-xs font-medium text-[#5147b4] hover:underline">View inbox →</Link>
          </div>
          <div className="mt-2 grid gap-2">
            {data.approvals.slice(0, 3).map((a) => (
              <div key={a._id} className="rounded-xl border border-[#ebe9f0] p-3 dark:border-gray-800">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{a.summary}</p>
                    <p className="mt-1 text-xs text-gray-500">{a.projectName}{a.taskTitle ? ` · ${a.taskTitle}` : ""} · {KIND_LABEL[a.kind] ?? a.kind}</p>
                  </div>
                  <Link href={`/chats/${a.projectId}`} className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Open</Link>
                </div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => approve({ approvalId: a._id })} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">Approve</button>
                  <button onClick={() => reject({ approvalId: a._id })} className="rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-semibold dark:bg-gray-800 dark:text-white">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Project</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {data.perProject.map((p) => (
            <Link key={p._id} href={`/chats/${p._id}`} className="rounded-xl border border-gray-200 p-4 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
              <p className="font-medium">{p.name}</p>
              <p className="mt-1 text-xs text-gray-500">{p.totalTasks} tasks · {p.running} running · {p.pendingApprovals} pending · {p.failed} failed</p>
              <p className="mt-1 truncate text-xs text-gray-400">{p.workspacePath}</p>
            </Link>
          ))}
          {data.perProject.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400 dark:border-gray-700 sm:col-span-2">
              No projects yet. Add a project folder with the + Project button.
            </div>
          )}
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-sm font-semibold">Recent tasks</h2>
          <div className="mt-2 grid gap-2">
            {data.recentTasks.slice(0, 3).map((t) => (
              <Link key={t._id} href={`/chats/${t.projectId}`} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="text-xs text-gray-500">{t.projectName}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_PILL[t.status] ?? "bg-gray-100 text-gray-600"}`}>{t.status}</span>
              </Link>
            ))}
            {data.recentTasks.length === 0 && <p className="text-sm text-gray-400">No tasks yet.</p>}
          </div>
        </section>

        <section id="team">
          <h2 className="text-sm font-semibold">Team ({data.agents.length})</h2>
          <div className="mt-2 grid gap-2">
            {data.agents.map((a) => (
              <div key={a._id} className="group flex items-center gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <AgentAvatar name={roleLabel(a.role)} size={32} status={a.status} avatarParams={a.avatarParams} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{roleLabel(a.role)}</p>
                  <p className="text-xs text-gray-500">{a.status}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveAgent(a._id, roleLabel(a.role))}
                  disabled={removingAgentId === a._id}
                  className="rounded-lg p-1.5 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 max-[979px]:opacity-100 disabled:opacity-50"
                  title={`Delete ${roleLabel(a.role)}`}
                  aria-label={`Delete ${roleLabel(a.role)}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
              {data.agents.length === 0 && <p className="text-sm text-gray-400">No agents yet. Create one from the sidebar (Team → +).</p>}
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
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-4xl">
          <Skeleton loading={data === undefined} skeleton={<OverviewSkeleton />} label="Loading overview">
            {content}
          </Skeleton>
        </div>
      </main>
    </div>
  );
}
