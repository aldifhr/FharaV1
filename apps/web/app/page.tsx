"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "../../api/convex/_generated/api";
import Link from "next/link";
import IconRail from "../components/IconRail";
import Modal from "../components/Modal";
import AgentAvatar from "../components/AgentAvatar";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { BorderBeam } from "@/components/ui/border-beam";

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

export default function Home() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center">Loading…</div>}>
      <HomePage />
    </Suspense>
  );
}

function HomePage() {
  const searchParams = useSearchParams();
  const data = useQuery(api.overview.get, {});
  const projects = useQuery(api.projects.list, {});
  const agents = useQuery(api.agents.list, {});
  const createProject = useMutation(api.projects.create);
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [desktopReady, setDesktopReady] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  useEffect(() => {
    setDesktopReady(Boolean(window.moagentDesktop));
  }, []);

  useEffect(() => {
    if (searchParams.get("new") === "project") {
      setIsCreateOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await createProject({ name, workspacePath, agentIds: selectedAgentIds as never[] });
      setName("");
      setWorkspacePath("");
      setSelectedAgentIds([]);
      setIsCreateOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSaving(false);
    }

  }

  async function handleSelectFolder() {
    if (!window.moagentDesktop) return;
    setSelectingFolder(true);
    setError("");
    try {
      const selectedPath = await window.moagentDesktop.selectFolder();
      if (selectedPath) {
        setWorkspacePath(selectedPath);
        if (!name) {
          const folderName = selectedPath.split(/[\\/]/).filter(Boolean).pop();
          if (folderName) setName(folderName);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select folder");
    } finally {
      setSelectingFolder(false);
    }
  }

  if (data === undefined || projects === undefined || agents === undefined) {
    return <div className="flex h-screen items-center justify-center">Loading…</div>;
  }

  const stats = [
    { label: "Project", value: data.projects.length },
    { label: "Agent", value: data.agents.length },
    { label: "Running tasks", value: data.taskCounts.byStatus.running ?? 0 },
    { label: "Needs approval", value: data.approvals.length },
    { label: "Failed tasks", value: data.taskCounts.byStatus.failed ?? 0 },
    { label: "Total task", value: data.taskCounts.total },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail onNewProject={() => setIsCreateOpen(true)} />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">Overview</h1>
              <p className="mt-1 text-sm text-gray-500">Overview of all projects and agents.</p>
            </div>
            <ShimmerButton
              shimmerDuration="2.5s"
              onClick={() => setIsCreateOpen(true)}
              className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium"
            >
              + Project
            </ShimmerButton>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {stats.map((s, i) => (
              <BlurFade key={s.label} delay={i * 0.05} inView>
                <div className="relative overflow-hidden rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                  <p className="text-2xl font-semibold"><NumberTicker value={s.value} /></p>
                  <p className="text-xs text-gray-500">{s.label}</p>
                  <BorderBeam size={60} duration={s.label === "Needs approval" && s.value > 0 ? 4 : 12} colorFrom="#6252d8" colorTo="#38bdf8" />
                </div>
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
                      <Link href={`/workspace/${a.projectId}`} className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Open</Link>
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
                <Link key={p._id} href={`/workspace/${p._id}`} className="rounded-xl border border-gray-200 p-4 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
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
              <h2 className="text-sm font-semibold">Task terbaru</h2>
              <div className="mt-2 grid gap-2">
                {data.recentTasks.map((t) => (
                  <Link key={t._id} href={`/workspace/${t.projectId}`} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
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

            <section>
              <h2 className="text-sm font-semibold">Agent ({data.agents.length})</h2>
              <div className="mt-2 grid gap-2">
                {data.agents.map((a) => (
                  <div key={a._id} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                    <AgentAvatar name={a.name} size={32} status={a.status} avatarParams={a.avatarParams} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{a.name}</p>
                      <p className="text-xs text-gray-500">{a.role} · {a.status}</p>
                    </div>
                    <span className="text-[11px] text-gray-400">{a.llmApiKeyConfigured ? "key ✓" : "key —"}</span>
                  </div>
                ))}
                {data.agents.length === 0 && <p className="text-sm text-gray-400">No agents yet. Create one from the sidebar (Team → +).</p>}
                <div className="flex gap-2 text-[11px] text-gray-400">
                  {Object.entries(data.agentByStatus).map(([s, n]) => <span key={s}>{s}: {n}</span>)}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>

      {isCreateOpen && (
        <Modal title="Add project" onClose={() => setIsCreateOpen(false)}>
          <form
            onSubmit={handleSubmit}
            className="mt-4 grid gap-3"
          >
              <label className="grid gap-1 text-sm">
                Project name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Contoh: MOAgent"
                  required
                  className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
                />
              </label>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Team project</legend>
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                  {agents.length === 0 && <p className="text-xs text-gray-400">Create an agent from Team first.</p>}
                  {agents.map((agent) => (
                    <label key={agent._id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedAgentIds.includes(agent._id)}
                        onChange={(event) =>
                          setSelectedAgentIds((current) =>
                            event.target.checked
                              ? [...current, agent._id]
                              : current.filter((id) => id !== agent._id)
                          )
                        }
                      />
                      <span>{agent.name}</span>
                      <span className="text-xs text-gray-400">{agent.role}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="grid gap-1 text-sm">
                Path folder Windows
                <div className="flex gap-2">
                  <input
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    placeholder={"D:\\CODE\\MOAgent"}
                    required
                    className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
                  />
                  {desktopReady && (
                    <button
                      type="button"
                      onClick={handleSelectFolder}
                      disabled={selectingFolder}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 disabled:opacity-50"
                    >
                      {selectingFolder ? "..." : "Select"}
                    </button>
                  )}
                </div>
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={saving}
                className="mt-1 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? "Saving..." : "Add project"}
              </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
