"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import { AnimatedTooltip } from "@/components/ui/animated-tooltip";
import { avatarUrl, defaultAvatarParams } from "@/lib/avatar";
import DiffCard from "./DiffCard";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { Bell, MoreHorizontal, PanelRight, Send, Trash2 } from "lucide-react";

type Props = {
  projectId: string;
  tab: "chat" | "tasks";
  setTab: (t: "chat" | "tasks") => void;
  onSelectTask: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  selectedTaskId: string | null;
};

export default function ChatPanel({ projectId, tab, setTab, onSelectTask, onOpenAgent, selectedTaskId }: Props) {
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const project = useQuery(api.projects.get, { projectId: projectId as any });
  const messages = useQuery(api.messages.listByProject, { projectId: projectId as any });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  const allAgents = useQuery(api.agents.list, {});
  const projectAgentIds = project?.agentIds;
  const agents = (projectAgentIds
    ? (allAgents ?? []).filter((agent: any) => (projectAgentIds as readonly string[]).includes(agent._id))
    : (allAgents ?? [])) as any[];
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId) ?? tasks?.[0];
  const fileChangesByTask = useQuery(api.fileChanges.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const selectedTaskMessages = selectedTask
    ? (messages ?? []).filter((message: any) => message.taskId === selectedTask._id)
    : [];
  const agentMessages = (messages ?? []).filter((message: any) => message.authorType === "agent");
  const latestAgentMessage = [...selectedTaskMessages].reverse().find((message: any) => message.authorType === "agent");

  const createTask = useMutation(api.tasks.createFromCommand);
  const removeTask = useMutation(api.tasks.remove);
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [deleting, setDeleting] = useState(false);

  const deleteTask = (task: any) => {
    setConfirmReq({
      title: `Delete task “${task.title}”?`,
      message: "All history for this task will be permanently deleted.",
      onOk: () => { void confirmDeleteTask(task); },
    });
  };

  const confirmDeleteTask = async (task: any) => {
    setDeleting(true);
    try {
      await removeTask({ taskId: task._id });
      if (selectedTaskId === task._id) onSelectTask("");
      toast("success", "Task deleted", task.title);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete task", err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setDeleting(false);
    }
  };

  const submit = async () => {
    if (!command.trim()) return;
    setError("");
    setSending(true);
    try {
      await createTask({ projectId: projectId as any, command: command.trim() });
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send command");
    } finally {
      setSending(false);
    }
  };

  const headerAgents = agents.slice(0, 6);
  const workingAgents = agents.filter((agent: any) => agent.status === "working");
  const taskErrors = (taskEvents ?? []).filter((event: any) => event.type === "task.error");
  const diffStats = (fileChangesByTask ?? []).reduce(
    (stats, fileChange: any) => {
      for (const line of fileChange.diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) stats.added += 1;
        if (line.startsWith("-")) stats.removed += 1;
      }
      return stats;
    },
    { added: 0, removed: 0 }
  );
  const formatMessageTime = (createdAt: number) => {
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
    if (elapsedMinutes < 1) return "just now";
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;
    return `${Math.floor(elapsedHours / 24)}d ago`;
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center gap-3 border-b border-[#ebe9f0] px-5 py-3 dark:border-gray-800">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e6f4ed] text-sm font-bold text-[#3d9b67]">
          {(project as any)?.name?.slice(0, 2).toUpperCase() ?? "AW"}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{(project as any)?.name ?? "Agent Workspace"}</h1>
          <div className="flex items-center gap-2">
            <div className="relative flex items-center pl-1" aria-label={`${agents.length} agents`}>
              <div
                className="flex items-center"
                onMouseLeave={() => setActiveAgentId(null)}
              >
                {headerAgents.map((a: any) => (
                  <button
                    key={a._id}
                    type="button"
                    onClick={() => onOpenAgent?.(a._id)}
                    title={`${a.name} · Open agent`}
                    aria-label={`Open agent ${a.name}`}
                    className={`-ml-1.5 rounded-full p-0 first:ml-0 ${
                      activeAgentId && activeAgentId !== a._id
                        ? "opacity-40"
                        : "opacity-100 transition hover:opacity-70"
                    }`}
                    onMouseEnter={() => setActiveAgentId(a._id)}
                  >
                    <AgentAvatar name={a.name} size={28} status={a.status} avatarParams={a.avatarParams} />
                  </button>
                ))}
              </div>
              {activeAgentId && (
                <span className="pointer-events-none absolute left-0 top-full z-30 mt-2">
                  <AnimatedTooltip
                    items={(() => {
                      const a = agents.find((x: any) => x._id === activeAgentId);
                      return a
                        ? [{
                            id: a._id,
                            name: a.name,
                            designation: `${a.role} · ${a.status}`,
                            image: avatarUrl(a.avatarParams ?? defaultAvatarParams(a.name)),
                            size: 28,
                          }]
                        : [];
                    })()}
                  />
                </span>
              )}
              {agents.length > headerAgents.length && (
                <button
                  type="button"
                  onClick={() => onOpenAgent?.(agents[headerAgents.length]._id)}
                  title={`+${agents.length - headerAgents.length} more — open agents`}
                  aria-label={`Open ${agents.length - headerAgents.length} more agents`}
                  className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600 ring-1 ring-white transition hover:bg-gray-200"
                >
                  +{agents.length - headerAgents.length}
                </button>
              )}
            </div>
            <span className="text-xs text-gray-500">{agents.length} {agents.length === 1 ? "agent" : "agents"}</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button className="text-gray-400 hover:text-gray-700" title="Panel"><PanelRight size={15} /></button>
          <button className="text-gray-400 hover:text-gray-700" title="Notifications"><Bell size={15} /></button>
          <button className="text-gray-400 hover:text-gray-700" title="More"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="flex gap-2 border-b border-[#ebe9f0] px-5 dark:border-gray-800">
        {(["chat", "tasks"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-[13px] capitalize ${tab === t ? "border-[#6252d8] font-semibold text-[#5147b4]" : "border-transparent text-gray-500"}`}>
            {t}{t === "tasks" && tasks?.length ? ` ${tasks.length}` : ""}
          </button>
        ))}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto bg-transparent p-5">
        {taskErrors.map((event: any, index: number) => (
          <div key={`task-error-${index}`} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="font-semibold">Agent error:</span> {event.payload?.message ?? "Task failed to process."}
          </div>
        ))}
        {tab === "chat" ? (
          <>
            {agentMessages.map((m: any, index: number) => (
                <motion.div
                  key={m._id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.18) }}
                  className="flex gap-3"
                >
                <AgentAvatar
                  name={(agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent"}
                  size={32}
                  avatarParams={(agents as any)?.find((a: any) => a._id === m.agentId)?.avatarParams}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="text-[13px] font-semibold text-[#34323d]">{(agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent"}</p>
                    <span className="text-[11px] text-gray-400">{formatMessageTime(m._creationTime)}</span>
                  </div>
                  <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[#4c4a55]">{m.content}</p>
                  {fileChangesByTask?.length && m.taskId === selectedTask?._id && m._id === latestAgentMessage?._id ? (
                    <div className="mt-2">
                      <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600">
                        Changed {(fileChangesByTask as any).length} files
                        <span className="text-emerald-600">+{diffStats.added}</span>
                        <span className="text-rose-500">−{diffStats.removed}</span>
                      </p>
                      {(fileChangesByTask as any).map((fc: any) => (
                        <DiffCard key={fc._id} filePath={fc.filePath} diff={fc.diff} changeType={fc.changeType} />
                      ))}
                    </div>
                  ) : null}
                </div>
              </motion.div>
            ))}
            {!agentMessages.length && <p className="text-sm text-gray-400">No agent reports yet.</p>}
            {workingAgents.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <span>{workingAgents.map((agent: any) => agent.name).join(", ")} is thinking</span>
                <span className="flex gap-0.5" aria-label="Agent is thinking">
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
                </span>
              </div>
            )}
          </>
        ) : (
          <motion.div key="tasks" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="space-y-2">
            <AnimatePresence initial={false}>
            {(tasks ?? []).map((t: any) => (
              <motion.div key={t._id} layout initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96, height: 0, marginBottom: 0 }} className="group flex w-full items-center justify-between rounded-xl border border-gray-200 p-3 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                <button onClick={() => onSelectTask(t._id)} className="min-w-0 flex-1 text-left">
                <div>
                  <p className="text-sm font-medium dark:text-white">{t.title}</p>
                  <p className="text-xs text-gray-500">{t.status}</p>
                </div>
                </button>
                <div className="ml-3 flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${t.status === "done" ? "bg-emerald-100 text-emerald-700" : t.status === "needs_approval" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>
                  {t.status}
                </span>
                <button
                  type="button"
                    onClick={() => deleteTask(t)}
                  disabled={t.status === "running"}
                  title={t.status === "running" ? "Running tasks cannot be deleted" : "Delete task"}
                  aria-label={`Delete task ${t.title}`}
                  className="rounded-md p-1 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
                </div>
              </motion.div>
            ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      <ConfirmDialog request={confirmReq} pending={deleting} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      {tab === "tasks" && <div className="border-t border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/70">
        <div className="flex gap-2">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Give the agent team a command…"
            className="flex-1 rounded-xl border border-[#e5e3eb] bg-[#fbfbfd] px-3 py-2.5 text-sm outline-none focus:border-[#a29ae8] focus:ring-2 focus:ring-[#e5e1ff]"
          />
          <button onClick={() => void submit()} disabled={sending || !command.trim()} className="flex items-center gap-1 rounded-xl bg-[#6252d8] px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#5345c2] disabled:cursor-not-allowed disabled:opacity-50">
            <Send size={16} /> {sending ? "Sending…" : "Send"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>}
    </main>
  );
}
