"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import DiffCard from "./DiffCard";
import { Bell, MoreHorizontal, PanelRight, Send } from "lucide-react";

type Props = {
  projectId: string;
  tab: "chat" | "tasks";
  setTab: (t: "chat" | "tasks") => void;
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string | null;
};

export default function ChatPanel({ projectId, tab, setTab, onSelectTask, selectedTaskId }: Props) {
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const project = useQuery(api.projects.get, { projectId: projectId as any });
  const messages = useQuery(api.messages.listByProject, { projectId: projectId as any });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  const agents = useQuery(api.agents.list, {});
  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId) ?? tasks?.[0];
  const fileChangesByTask = useQuery(api.fileChanges.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const selectedTaskMessages = selectedTask
    ? (messages ?? []).filter((message: any) => message.taskId === selectedTask._id)
    : [];

  const createTask = useMutation(api.tasks.createFromCommand);

  const submit = async () => {
    if (!command.trim()) return;
    setError("");
    setSending(true);
    try {
      await createTask({ projectId: projectId as any, command: command.trim() });
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Perintah gagal dikirim");
    } finally {
      setSending(false);
    }
  };

  const headerAgents = (agents ?? []).slice(0, 7);
  const workingAgents = (agents ?? []).filter((agent: any) => agent.status === "working");
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

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-[#ebe9f0] px-5 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e6f4ed] text-sm font-bold text-[#3d9b67]">
          {(project as any)?.name?.slice(0, 2).toUpperCase() ?? "AW"}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{(project as any)?.name ?? "Agent Workspace"}</h1>
          <p className="text-xs text-gray-500">{headerAgents.length} agent</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button className="text-gray-400 hover:text-gray-700" title="Panel"><PanelRight size={15} /></button>
          <button className="text-gray-400 hover:text-gray-700" title="Notifications"><Bell size={15} /></button>
          {headerAgents.map((a: any) => (
            <AgentAvatar key={a._id} name={a.name} size={28} status={a.status} avatarParams={a.avatarParams} />
          ))}
          <button className="text-gray-400 hover:text-gray-700" title="More"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="flex gap-2 border-b border-[#ebe9f0] px-5">
        {(["chat", "tasks"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-[13px] capitalize ${tab === t ? "border-[#6252d8] font-semibold text-[#5147b4]" : "border-transparent text-gray-500"}`}>
            {t}{t === "tasks" && tasks?.length ? ` ${tasks.length}` : ""}
          </button>
        ))}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto bg-[#fff] p-5">
        {taskErrors.map((event: any, index: number) => (
          <div key={`task-error-${index}`} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="font-semibold">Agent error:</span> {event.payload?.message ?? "Task gagal diproses."}
          </div>
        ))}
        {tab === "chat" ? (
          <>
            {(messages ?? []).map((m: any, index: number) => (
              <div key={m._id} className="flex gap-3">
                {m.authorType === "agent" ? (
                  <AgentAvatar
                    name={(agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent"}
                    size={32}
                    avatarParams={(agents as any)?.find((a: any) => a._id === m.agentId)?.avatarParams}
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white dark:bg-white dark:text-gray-900">U</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="text-[13px] font-semibold text-[#34323d]">
                      {m.authorType === "agent" ? ((agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent") : "You"}
                    </p>
                    <span className="text-[11px] text-gray-400">{index + 1} min ago</span>
                  </div>
                  <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[#4c4a55]">{m.content}</p>
                  {fileChangesByTask?.length && m.taskId === selectedTask?._id && m._id === selectedTaskMessages[0]?._id ? (
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
              </div>
            ))}
            {!messages?.length && <p className="text-sm text-gray-400">Belum ada pesan. Kirim perintah di bawah.</p>}
            {workingAgents.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <span>{workingAgents.map((agent: any) => agent.name).join(", ")} sedang berpikir</span>
                <span className="flex gap-0.5" aria-label="Agent sedang berpikir">
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-2">
            {(tasks ?? []).map((t: any) => (
              <button key={t._id} onClick={() => onSelectTask(t._id)} className="flex w-full items-center justify-between rounded-xl border border-gray-200 p-3 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                <div>
                  <p className="text-sm font-medium dark:text-white">{t.title}</p>
                  <p className="text-xs text-gray-500">{t.status}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${t.status === "done" ? "bg-emerald-100 text-emerald-700" : t.status === "needs_approval" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>
                  {t.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[#ebe9f0] bg-white p-4">
        <div className="flex gap-2">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Beri perintah ke tim agent…"
            className="flex-1 rounded-xl border border-[#e5e3eb] bg-[#fbfbfd] px-3 py-2.5 text-sm outline-none focus:border-[#a29ae8] focus:ring-2 focus:ring-[#e5e1ff]"
          />
          <button onClick={() => void submit()} disabled={sending || !command.trim()} className="flex items-center gap-1 rounded-xl bg-[#6252d8] px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#5345c2] disabled:cursor-not-allowed disabled:opacity-50">
            <Send size={16} /> {sending ? "Mengirim…" : "Kirim"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    </main>
  );
}
