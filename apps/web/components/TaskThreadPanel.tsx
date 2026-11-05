"use client";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "../../api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  GitBranch,
  ListTree,
  Loader2,
  MinusCircle,
  X,
  XCircle,
} from "lucide-react";

export default function TaskThreadPanel({
  taskId,
  collapsed,
  onToggle,
  onClose,
}: {
  taskId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const task = useQuery(api.tasks.get, taskId ? { taskId: taskId as any } : "skip");
  const taskExists = Boolean(task);
  const project = useQuery(api.projects.get, task?.projectId ? { projectId: task.projectId } : "skip");
  const messages = useQuery(api.messages.listByTask, taskExists ? { taskId: taskId as any } : "skip");
  const events = useQuery(api.taskEvents.listByTask, taskExists ? { taskId: taskId as any } : "skip");
  const agents = useQuery(api.agents.list, {});
  const execution = useQuery(
    api.executionView.getForTask,
    taskExists ? { taskId: taskId as any } : "skip"
  );

  if (!taskId) return null;

  if (collapsed) {
    return (
      <motion.aside
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 16 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="flex h-full w-11 shrink-0 items-start justify-center border-l border-[#ebe9f0] bg-white/80 pt-3 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80 max-[979px]:h-11 max-[979px]:w-full max-[979px]:items-center max-[979px]:border-l-0 max-[979px]:border-t max-[979px]:pt-0"
      >
        <button
          type="button"
          onClick={onToggle}
          title="Expand task thread"
          aria-label="Expand task thread"
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800"
        >
          <ChevronLeft size={17} className="max-[979px]:rotate-90" />
        </button>
      </motion.aside>
    );
  }

  const checks = (events ?? []).filter((e: any) => e.type === "task.check");
  const errors = (events ?? []).filter((e: any) => e.type === "task.error");
  const stages = (events ?? []).filter((e: any) => e.type === "task.stage");
  const workingAgent = (agents ?? []).find((agent: any) => agent.status === "working");
  const taskStatus = (task as any)?.status;
  const statusLabel = taskStatus === "done"
    ? "Completed"
    : taskStatus === "needs_approval"
      ? "Needs you"
      : taskStatus === "rejected"
        ? "Rejected"
        : taskStatus === "failed"
          ? "Failed"
          : taskStatus === "running"
            ? "Running"
            : "Queued";

  return (
    <motion.aside
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex h-full w-[318px] shrink-0 flex-col border-l border-[#ebe9f0] bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80 max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-l-0 max-[979px]:border-t"
    >
      <header className="flex items-center justify-between border-b border-[#ebe9f0] px-4 py-3.5 dark:border-gray-800">
        <div>
          <h2 className="truncate text-sm font-semibold">{(task as any)?.title ?? "Task thread"}</h2>
          <p className="mt-0.5 text-[11px] text-gray-400">Task thread · {(project as any)?.name ?? "Workspace"}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggle}
            title="Collapse task thread"
            aria-label="Collapse task thread"
            className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800"
          >
            <ChevronRight size={16} />
          </button>
          <button type="button" onClick={onClose} title="Close task thread" aria-label="Close task thread" className="rounded-lg p-1 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
      </header>

      <div className="flex gap-2 px-4 pt-3">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${taskStatus === "done" ? "bg-[#e6f5ec] text-[#348d5c]" : taskStatus === "failed" || taskStatus === "rejected" ? "bg-red-100 text-red-700" : "bg-[#fff0df] text-[#bd6c23]"}`}>
          {statusLabel}
        </span>
        {(agents as any)?.find((a: any) => a.role === "cto") && (
          <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700 dark:text-white">
            <AgentAvatar name="CTO" size={16} avatarParams={(agents as any)?.find((a: any) => a.role === "cto")?.avatarParams} /> CTO · review
          </span>
        )}
      </div>
      {workingAgent && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
          <span>{workingAgent.name} is thinking</span>
          <span className="flex gap-0.5">
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:120ms]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:240ms]" />
          </span>
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {execution && ((execution as any).subtasks?.length ?? 0) > 0 && (
          <section className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-gray-500">
                <ListTree size={13} /> Execution plan
              </h4>
              <span className="text-[10px] text-gray-400">
                {(execution as any).plan
                  ? `v${(execution as any).plan.version} · ${(execution as any).plan.createdBy}`
                  : "unplanned"}
              </span>
            </div>
            <div className="mt-2 space-y-1.5">
              {((execution as any).subtasks ?? []).map((subtask: any) => {
                const state = subtask.status as string;
                const Icon =
                  state === "completed"
                    ? CheckCircle2
                    : state === "failed"
                      ? XCircle
                      : state === "running"
                        ? Loader2
                        : state === "blocked" || state === "skipped"
                          ? MinusCircle
                          : Circle;
                const tone =
                  state === "completed"
                    ? "text-emerald-600"
                    : state === "failed"
                      ? "text-rose-600"
                      : state === "running"
                        ? "text-sky-600"
                        : state === "waiting_approval"
                          ? "text-amber-600"
                          : "text-gray-400";
                return (
                  <div key={subtask._id} className="rounded-md bg-white px-2 py-1.5 dark:bg-gray-950">
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} className={`${tone} ${state === "running" ? "animate-spin" : ""}`} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium dark:text-white">
                        {subtask.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-400">{subtask.kind}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 pl-[19px] text-[10px] text-gray-400">
                      <span className="truncate">{subtask.capability}</span>
                      {subtask.assignedAgentName && <span>· {subtask.assignedAgentName}</span>}
                      {subtask.dependencies?.length > 0 && (
                        <span className="flex items-center gap-0.5">
                          <GitBranch size={10} /> {subtask.dependencies.join(", ")}
                        </span>
                      )}
                    </div>
                    {subtask.error && (
                      <p className="mt-0.5 pl-[19px] text-[10px] text-rose-600">{subtask.error}</p>
                    )}
                  </div>
                );
              })}
            </div>
            {(execution as any).evaluation && (
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-gray-500">Verification</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-semibold ${
                    (execution as any).evaluation.verdict === "passed"
                      ? "bg-emerald-100 text-emerald-700"
                      : (execution as any).evaluation.verdict === "inconclusive"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-rose-100 text-rose-700"
                  }`}
                >
                  {(execution as any).evaluation.verdict}
                </span>
              </div>
            )}
          </section>
        )}
        {taskStatus === "failed" && (task as any)?.errorMessage && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <p className="font-semibold">Task failed</p>
            <p className="mt-1 break-words">{(task as any).errorMessage}</p>
          </div>
        )}
        {errors.map((event: any, index: number) => (
          <div key={`error-${index}`} className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <p className="font-semibold">Agent error</p>
            <p className="mt-1 break-words">{event.payload?.message ?? "Task failed to process."}</p>
          </div>
        ))}
        {stages.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
            {stages[stages.length - 1].payload?.message ?? `Stage: ${stages[stages.length - 1].payload?.stage}`}
          </div>
        )}
        {(messages ?? []).map((m: any) => (
          <div key={m._id} className="flex gap-2">
            {m.authorType === "agent" ? (
              <AgentAvatar name={(agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent"} size={28} avatarParams={(agents as any)?.find((a: any) => a._id === m.agentId)?.avatarParams} />
            ) : (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white">U</div>
            )}
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-gray-500">{m.authorType === "agent" ? ((agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent") : "You"}</p>
              <div className="flex items-center gap-2">
                <p className="text-sm dark:text-white">{m.content}</p>
                <span className="shrink-0 text-[10px] text-gray-400">
                  {m._creationTime ? new Date(m._creationTime).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
            </div>
          </div>
        ))}
        <div>
          <h4 className="text-xs font-semibold uppercase text-gray-500">Checklist</h4>
          {checks.length === 0 && <p className="mt-1 text-xs text-gray-400">No checks yet.</p>}
          {checks.map((e: any, i: number) => (
            <div key={i} className="mt-1 flex items-center justify-between text-xs dark:text-white">
              <span>QA · {e.payload.label}</span>
              <span className={`rounded-full px-2 py-0.5 font-semibold ${e.payload.status === "passed" || e.payload.status === "clean" ? "bg-emerald-100 text-emerald-700" : e.payload.status === "inconclusive" || e.payload.status === "running" ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>
                {e.payload.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.aside>
  );
}
