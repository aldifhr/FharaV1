"use client";

import { useEffect, useState } from "react";
import IconRail, { type WorkspaceSection } from "../../../components/IconRail";
import Sidebar from "../../../components/Sidebar";
import ChatPanel from "../../../components/ChatPanel";
import TaskThreadPanel from "../../../components/TaskThreadPanel";
import AgentAvatar from "../../../components/AgentAvatar";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "framer-motion";
import { Trash2, Activity as ActivityIcon, AlertTriangle, CheckCircle2, Info, Loader2, FileDiff, Brain, XCircle } from "lucide-react";
import { BlurFade } from "@/components/ui/blur-fade";
import ConfirmDialog, { type ConfirmRequest } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toasts";
import { api } from "../../../../api/convex/_generated/api";

type Agent = { _id: string; name: string; role: string; status: "idle" | "working" | "queued" | "needs_you"; llmModel?: string; llmProvider?: string; llmApiKeyConfigured?: boolean; avatarParams?: any };
type Task = { _id: string; title: string; status: string };

function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-md bg-gray-200/80 dark:bg-gray-800 ${className}`} />;
}

function SectionLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-6 space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="mt-3 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

const STATUS_META: Record<string, { label: string; pill: string }> = {
  queued: { label: "Queued", pill: "bg-amber-100 text-amber-700" },
  running: { label: "Running", pill: "bg-sky-100 text-sky-700" },
  needs_approval: { label: "Needs approval", pill: "bg-rose-100 text-rose-700" },
  done: { label: "Completed", pill: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "Rejected", pill: "bg-gray-200 text-gray-600" },
  failed: { label: "Failed", pill: "bg-red-100 text-red-700" },
};

function Board({ tasks, onSelect, onDelete }: { tasks: Task[] | undefined; onSelect: (id: string) => void; onDelete: (task: Task) => void }) {
  if (tasks === undefined) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" role="status" aria-label="Loading board">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="rounded-xl border border-gray-200 bg-gray-50/60 p-2 dark:border-gray-800 dark:bg-gray-900/50">
            <Skeleton className="mb-3 h-4 w-3/5" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="mt-2 h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }
  const columns = ["queued", "running", "needs_approval", "done", "failed"].map((status) => ({
    status,
    meta: STATUS_META[status],
    items: (tasks ?? []).filter((t) => t.status === status),
  }));
  const rejected = (tasks ?? []).filter((t) => t.status === "rejected");
  return (
    <motion.div layout className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {columns.map((col) => (
        <div key={col.status} className="rounded-xl border border-gray-200 bg-gray-50/60 p-2 dark:border-gray-800 dark:bg-gray-900/50">
          <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{col.meta.label} ({col.items.length})</p>
          <div className="grid gap-2">
            {col.items.map((t) => (
              <div key={t._id} className="group rounded-lg border border-gray-200 bg-white p-3 shadow-sm hover:border-[#a29ae8] dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-start gap-2">
                  <button onClick={() => onSelect(t._id)} className="min-w-0 flex-1 text-left">
                    <p className="line-clamp-2 text-sm font-medium dark:text-white">{t.title}</p>
                    <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${col.meta.pill}`}>{col.meta.label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(t)}
                    disabled={t.status === "running"}
                    title={t.status === "running" ? "Running tasks cannot be deleted" : "Delete task"}
                    aria-label={`Delete task ${t.title}`}
                    className="rounded-md p-1 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            {!col.items.length && <p className="px-1 py-3 text-center text-xs text-gray-400">Empty</p>}
          </div>
        </div>
      ))}
      {rejected.length > 0 && (
        <p className="text-xs text-gray-400 sm:col-span-2 xl:col-span-5">{rejected.length} rejected task(s) hidden.</p>
      )}
    </motion.div>
  );
}

function SectionPage({
  section, projectId, agents, tasks, onSelectTask, highlightAgentId,
}: {
  section: Exclude<WorkspaceSection, "chat" | "board">;
  projectId: string;
  agents: Agent[] | undefined;
  tasks: Task[] | undefined;
  onSelectTask: (id: string) => void;
  highlightAgentId?: string | null;
}) {
  const events = useQuery(api.taskEvents.listByProject, section === "activity" ? { projectId: projectId as never } : "skip");
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const pending = useQuery(api.approvals.listPendingAll, {});
  const mine = (pending ?? []).filter((a: any) => a.projectId === projectId);
  const project = useQuery(api.projects.get, { projectId: projectId as never });

  const titles: Record<typeof section, string> = {
    team: "Team", activity: "Activity", health: "Agent health", integrations: "Integrations", memory: "Memory",
  };
  const subs: Record<typeof section, string> = {
    team: "Agents assigned to this project.",
    activity: "Recent task events for this project.",
    health: "Agent status and LLM configuration.",
    integrations: "External integrations for this project.",
    memory: "Project decisions and context.",
  };

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0 flex-1 overflow-y-auto bg-transparent p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl font-semibold">{titles[section]}</h1>
        <p className="mt-1 text-sm text-gray-500">{subs[section]}</p>

        {section === "team" && (
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {(agents ?? []).map((agent) => (
              <div
                key={agent._id}
                className={`flex items-center gap-3 rounded-xl border p-4 transition ${
                  agent._id === highlightAgentId
                    ? "border-[#6252d8] bg-[#6252d8]/5 shadow-sm dark:border-violet-400 dark:bg-violet-500/10"
                    : "border-gray-200 dark:border-gray-800"
                }`}
              >
                <AgentAvatar name={agent.name} size={36} status={agent.status} avatarParams={agent.avatarParams} />
                <div className="min-w-0">
                  <p className="font-medium dark:text-white">{agent.name}</p>
                  <p className="text-xs text-gray-500">{agent.role} · {agent.status}</p>
                  <p className="text-xs text-gray-400">{agent.llmProvider ?? "—"}{agent.llmModel ? ` · ${agent.llmModel}` : ""} · API key {agent.llmApiKeyConfigured ? "saved" : "not set"}</p>
                </div>
              </div>
            ))}
            {agents === undefined ? <SectionLoading rows={2} /> : !agents.length && <p className="text-sm text-gray-400">No agents assigned to this project yet.</p>}
          </div>
        )}

        {section === "activity" && (
          <div className="mt-6">
            {events !== undefined && events.length > 0 && (
              <div className="mb-4 flex gap-2">
                {(() => {
                  const list = events ?? [];
                  const errors = list.filter((e) => e.type === "task.error").length;
                  const stages = list.filter((e) => e.type === "task.stage").length;
                  const files = list.filter((e) => e.type === "fileChanges.updated").length;
                  return (
                    <>
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">{list.length} events</span>
                      {stages > 0 && <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:bg-sky-950">{stages} stages</span>}
                      {files > 0 && <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 dark:bg-violet-950">{files} file updates</span>}
                      {errors > 0 && <span className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:bg-red-950">{errors} errors</span>}
                    </>
                  );
                })()}
              </div>
            )}
            {events === undefined && <SectionLoading rows={5} />}
            {events?.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400 dark:border-gray-700">
                <ActivityIcon size={24} className="mx-auto mb-2 opacity-50" />
                No activity yet. Task events will appear here.
              </div>
            )}
            {events && events.length > 0 && (
              <div className="relative ml-3 border-l-2 border-gray-200 pl-5 dark:border-gray-800">
                {(events ?? []).slice(0, 30).map((e, i) => {
                  const type = e.type as string;
                  const isError = type === "task.error";
                  const isStage = type === "task.stage";
                  const isFile = type === "fileChanges.updated";
                  const isContext = type === "agent.context";
                  const isStatus = type === "task.status";
                  const icon = isError ? <XCircle size={13} /> : isStage ? <Loader2 size={13} className="animate-spin" /> : isFile ? <FileDiff size={13} /> : isContext ? <Brain size={13} /> : <Info size={13} />;
                  const dotCls = isError ? "bg-red-500" : isStage ? "bg-sky-500" : isFile ? "bg-violet-500" : isStatus ? "bg-emerald-500" : "bg-gray-400";
                  const pillCls = isError ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : isStage ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400" : isFile ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
                  const msg = e.payload?.message ? String(e.payload.message) : null;
                  const time = e._creationTime ? new Date(e._creationTime).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
                  return (
                    <div key={`${e._id}-${i}`} className="relative pb-3">
                      <span className={`absolute -left-[25px] top-1 flex h-4 w-4 items-center justify-center rounded-full text-white ${dotCls}`}>
                        {icon}
                      </span>
                      <BlurFade delay={Math.min(i * 0.03, 0.4)} inView>
                        <div className={`rounded-lg px-3 py-2.5 text-sm ${isError ? "border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40" : "border border-gray-200 dark:border-gray-800"}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ${pillCls}`}>{type}</span>
                            {time && <span className="text-[11px] text-gray-400">{time}</span>}
                          </div>
                          {msg && <p className={`mt-1.5 break-words leading-5 ${isError ? "text-red-700 dark:text-red-300" : "text-gray-600 dark:text-gray-300"}`}>{msg}</p>}
                        </div>
                      </BlurFade>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {section === "health" && (
          <div className="mt-6 space-y-2">
            {(agents ?? []).map((agent) => (
              <div key={agent._id} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <AgentAvatar name={agent.name} size={32} status={agent.status} avatarParams={agent.avatarParams} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium dark:text-white">{agent.name}</p>
                  <p className="text-xs text-gray-500">Status: {agent.status}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${agent.status === "working" ? "bg-sky-100 text-sky-700" : agent.status === "needs_you" ? "bg-rose-100 text-rose-700" : "bg-gray-100 text-gray-600"}`}>
                  {agent.status}
                </span>
              </div>
            ))}
            {agents === undefined ? <SectionLoading rows={3} /> : !agents.length && <p className="text-sm text-gray-400">No agents assigned to this project yet.</p>}
          </div>
        )}

        {section === "integrations" && (
          <div className="mt-6 space-y-3">
            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <p className="font-medium dark:text-white">Project</p>
              <p className="mt-1 text-sm text-gray-500">{project?.name ?? "…"}</p>
              <p className="text-xs text-gray-400">{project?.workspacePath ?? ""}</p>
              <p className="mt-1 text-xs text-gray-500">{(project as any)?.agentIds?.length ?? agents?.length ?? 0} agents assigned · {tasks?.length ?? 0} tasks recorded</p>
            </div>
            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <p className="font-medium dark:text-white">Pending approvals ({mine.length})</p>
              {mine.map((a) => (
                <div key={a._id} className="mt-2 flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate dark:text-white">{a.summary}</span>
                  <span className="flex shrink-0 gap-2">
                    <button onClick={() => approve({ approvalId: a._id })} className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white">Approve</button>
                    <button onClick={() => reject({ approvalId: a._id })} className="rounded-lg bg-gray-200 px-2 py-1 text-xs font-semibold dark:bg-gray-700 dark:text-white">Reject</button>
                  </span>
                </div>
              ))}
              {!mine.length && <p className="mt-1 text-sm text-gray-400">No pending approvals.</p>}
            </div>
            <p className="text-xs text-gray-400">MCP / webhook integrations are not available in the backend yet — this page shows the available real data (project + approvals).</p>
          </div>
        )}

        {section === "memory" && (
          <div className="mt-6 space-y-2">
            {(events ?? []).slice(0, 20).map((e, i) => {
              const msg = e.payload?.message ?? e.payload?.summary ?? e.payload?.decision;
              if (!msg) return null;
              return (
                <div key={`${e._id}-${i}`} className="rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
                  <span className="font-medium dark:text-white">{e.type}</span>
                  <span className="text-gray-500"> — {String(msg).slice(0, 200)}</span>
                </div>
              );
            })}
            {events === undefined ? <SectionLoading rows={3} /> : !events.length && <p className="text-sm text-gray-400">No project memory yet. Memory is built from task events (decisions, summaries, and errors) — there is no dedicated memory table yet.</p>}
          </div>
        )}
      </div>
    </motion.section>
  );
}

export default function WorkspaceClient({
  projectId,
  initialSection = "chat",
}: {
  projectId: string;
  initialSection?: WorkspaceSection;
}) {
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [section, setSection] = useState<WorkspaceSection>(initialSection);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [threadCollapsed, setThreadCollapsed] = useState(false);
  const [highlightAgentId, setHighlightAgentId] = useState<string | null>(null);

  const openAgent = (agentId: string) => {
    setSection("team");
    setHighlightAgentId(agentId);
  };
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as never });
  const allAgents = useQuery(api.agents.list, {});
  const project = useQuery(api.projects.get, { projectId: projectId as never });
  const projectAgentIds = project?.agentIds;
  const agents = projectAgentIds
    ? allAgents?.filter((agent) => projectAgentIds.includes(agent._id))
    : allAgents;
  const removeTask = useMutation(api.tasks.remove);
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);

  const deleteTask = (task: Task) => {
    setConfirmReq({
      title: `Delete task "${task.title}"?`,
      message: "This task and all of its history will be deleted permanently.",
      onOk: () => { void confirmDeleteTask(task); },
    });
  };

  const confirmDeleteTask = async (task: Task) => {
    try {
      await removeTask({ taskId: task._id as never });
      if (selectedTaskId === task._id) setSelectedTaskId(null);
      toast("success", "Task deleted", task.title);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete task", err instanceof Error ? err.message : "Failed to delete task");
    }
  };

  useEffect(() => {
    setSection("chat");
    setTab("chat");
    setSelectedTaskId(null);
  }, [projectId]);

  useEffect(() => {
    if (!selectedTaskId && tasks?.[0]) setSelectedTaskId(tasks[0]._id);
  }, [selectedTaskId, tasks]);

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-[#24232d] dark:text-gray-100 max-[979px]:h-auto max-[979px]:flex-col max-[979px]:overflow-y-auto">
      <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <IconRail
        projectId={projectId}
        activeSection={section}
        onSectionChange={(nextSection) => {
          setSection(nextSection);
          if (nextSection === "chat") setTab("chat");
          if (nextSection === "board") setTab("tasks");
        }}
      />
      <Sidebar projectId={projectId} />
      {section === "chat" ? (
        <ChatPanel
          projectId={projectId}
          tab={tab}
          setTab={setTab}
          onSelectTask={(taskId) => { setSelectedTaskId(taskId); setThreadCollapsed(false); }}
          onOpenAgent={openAgent}
          onToggleThread={() => setThreadCollapsed((collapsed) => !collapsed)}
          threadCollapsed={threadCollapsed}
          selectedTaskId={selectedTaskId}
        />
      ) : section === "board" ? (
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0 flex-1 overflow-y-auto bg-transparent p-6">
          <div className="mx-auto max-w-6xl">
            <h1 className="text-xl font-semibold">Board</h1>
            <p className="mt-1 text-sm text-gray-500">Tasks by status. Click a card to open its thread.</p>
            <div className="mt-6"><Board tasks={tasks} onSelect={(taskId) => { setSelectedTaskId(taskId); setThreadCollapsed(false); }} onDelete={(task) => deleteTask(task)} /></div>
          </div>
        </motion.section>
      ) : (
        <SectionPage section={section} projectId={projectId} agents={agents} tasks={tasks} highlightAgentId={highlightAgentId} onSelectTask={(taskId) => { setSelectedTaskId(taskId); setThreadCollapsed(false); }} />
      )}
      <AnimatePresence initial={false} mode="wait">
        {selectedTaskId && (
          <TaskThreadPanel
            key={selectedTaskId}
            taskId={selectedTaskId}
            collapsed={threadCollapsed}
            onToggle={() => setThreadCollapsed((collapsed) => !collapsed)}
            onClose={() => setSelectedTaskId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
