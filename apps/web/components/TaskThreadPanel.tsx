"use client";
import { useQuery } from "convex/react";
import { api } from "../../api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import { X } from "lucide-react";

export default function TaskThreadPanel({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const task = useQuery(api.tasks.get, taskId ? { taskId: taskId as any } : "skip");
  const messages = useQuery(api.messages.listByTask, taskId ? { taskId: taskId as any } : "skip");
  const events = useQuery(api.taskEvents.listByTask, taskId ? { taskId: taskId as any } : "skip");
  const agents = useQuery(api.agents.list, {});

  if (!taskId) return null;

  const checks = (events ?? []).filter((e: any) => e.type === "task.check");
  const errors = (events ?? []).filter((e: any) => e.type === "task.error");
  const stages = (events ?? []).filter((e: any) => e.type === "task.stage");
  const workingAgent = (agents ?? []).find((agent: any) => agent.status === "working");

  return (
    <aside className="flex h-full w-[318px] shrink-0 flex-col border-l border-[#ebe9f0] bg-white max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-l-0 max-[979px]:border-t">
      <header className="flex items-center justify-between border-b border-[#ebe9f0] px-4 py-3.5">
        <div>
          <h2 className="truncate text-sm font-semibold">{(task as any)?.title ?? "Task thread"}</h2>
          <p className="mt-0.5 text-[11px] text-gray-400">Task thread · {(task as any)?.projectId ? "Atlas" : "Workspace"}</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
      </header>

      <div className="flex gap-2 px-4 pt-3">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${(task as any)?.status === "done" ? "bg-[#e6f5ec] text-[#348d5c]" : "bg-[#fff0df] text-[#bd6c23]"}`}>
          {(task as any)?.status === "done" ? "Approved" : "Needs you"}
        </span>
        {(agents as any)?.find((a: any) => a.role === "cto") && (
          <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700 dark:text-white">
            <AgentAvatar name="CTO" size={16} avatarParams={(agents as any)?.find((a: any) => a.role === "cto")?.avatarParams} /> CTO · review
          </span>
        )}
      </div>
      {workingAgent && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
          <span>{workingAgent.name} sedang berpikir</span>
          <span className="flex gap-0.5">
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:120ms]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:240ms]" />
          </span>
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {errors.map((event: any, index: number) => (
          <div key={`error-${index}`} className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <p className="font-semibold">Agent error</p>
            <p className="mt-1 break-words">{event.payload?.message ?? "Task gagal diproses."}</p>
          </div>
        ))}
        {stages.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
            {stages[stages.length - 1].payload?.message ?? `Tahap: ${stages[stages.length - 1].payload?.stage}`}
          </div>
        )}
        {(messages ?? []).map((m: any) => (
          <div key={m._id} className="flex gap-2">
            <AgentAvatar name={(agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "A"} size={28} avatarParams={(agents as any)?.find((a: any) => a._id === m.agentId)?.avatarParams} />
            <p className="text-sm dark:text-white">{m.content}</p>
          </div>
        ))}
        <div>
          <h4 className="text-xs font-semibold uppercase text-gray-500">Checklist</h4>
          {checks.length === 0 && <p className="mt-1 text-xs text-gray-400">Belum ada pengecekan.</p>}
          {checks.map((e: any, i: number) => (
            <div key={i} className="mt-1 flex items-center justify-between text-xs dark:text-white">
              <span>QA · {e.payload.label}</span>
              <span className={`rounded-full px-2 py-0.5 font-semibold ${e.payload.status === "clean" ? "bg-emerald-100 text-emerald-700" : e.payload.status === "running" ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>
                {e.payload.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
