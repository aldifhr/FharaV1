import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/api/convex/_generated/api";
import { roleLabel } from "@/lib/agentRoles";
import AgentAvatar from "../AgentAvatar";
import { Bell, Check, CheckCircle2, ExternalLink, Loader2, RotateCcw, XCircle } from "lucide-react";

export default function TaskCard({
  task,
  subtasks,
  pending,
  onApprove,
  onOpen,
  agents,
  approvalMode,
}: {
  task: any;
  subtasks: any[];
  pending: any[];
  onApprove: (approvalId: string) => void;
  onOpen: (taskId: string) => void;
  agents: any[];
  approvalMode: "ask" | "auto";
}) {
  const retryTask = useMutation(api.tasks.retry);
  const answerQuestion = useMutation(api.tasks.answerQuestion);
  const [retrying, setRetrying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const doneSubs = subtasks.filter((s) => s.status === "completed").length;
  const needsYou =
    task.status === "needs_approval" ||
    task.status === "waiting_input" ||
    pending.length > 0;
  const waitingForInput = task.status === "waiting_input" && Boolean(task.pendingQuestion);
  const isFailed = task.status === "failed" || task.status === "rejected";
  const badge =
    task.status === "done"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
      : task.status === "failed" || task.status === "rejected"
        ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
        : needsYou
          ? "bg-[#fff0df] text-[#bd6c23] dark:bg-orange-950 dark:text-orange-300"
          : "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300";
  const badgeLabel =
    task.status === "done" ? "Done" : task.status === "failed" ? "Failed" : needsYou ? "Needs you" : "In progress";
  const progress = subtasks.length ? Math.round((doneSubs / subtasks.length) * 100) : task.status === "done" ? 100 : 0;
  // Compact card: like the reference, the meta line names the agent
  // currently working the task (first running subtask, else first).
  const primarySubtask = subtasks.find((s) => s.status === "running") ?? subtasks[0];
  const primaryAgent = agents.find((a) => a._id === (primarySubtask as any)?.assignedAgentId);
  const statusIcon = needsYou
    ? <Bell size={15} className="shrink-0 text-orange-500" />
    : task.status === "done"
      ? <CheckCircle2 size={15} className="shrink-0 text-emerald-600" />
      : task.status === "failed" || task.status === "rejected"
        ? <XCircle size={15} className="shrink-0 text-red-500" />
        : <Loader2 size={15} className="shrink-0 animate-spin text-[#635bff]" />;

  return (
    <div className="space-y-1.5">
      <div
        onClick={() => onOpen(task._id)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(task._id);
          }
        }}
        className="cursor-pointer overflow-hidden rounded-2xl border border-[#e5e3eb] bg-white shadow-[0_1px_2px_rgba(30,25,60,.04)] transition hover:border-[#cfc9f5] dark:border-gray-800 dark:bg-gray-900 dark:hover:border-indigo-800"
      >
        <div className="flex items-center gap-2 px-3.5 pt-3">
          {statusIcon}
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold dark:text-white">{task.title}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge}`}>{badgeLabel}</span>
          <ExternalLink size={13} className="shrink-0 text-gray-300 dark:text-gray-600" />
        </div>
        <div className="flex items-center gap-1.5 px-3.5 pb-3 pt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          {primaryAgent && (
            <>
              <AgentAvatar name={roleLabel(primaryAgent.role)} size={16} avatarParams={primaryAgent.avatarParams} />
              <span>{roleLabel(primaryAgent.role)}</span>
            </>
          )}
          {task.branchName && (
            <span className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {task.branchName}
            </span>
          )}
          {subtasks.length > 0 && (
            <span>· {doneSubs} of {subtasks.length} subtasks</span>
          )}
        </div>
        <div className="h-1 bg-gray-100 dark:bg-gray-800" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-[#635bff] transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>
      {waitingForInput && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
          <p className="font-semibold">The team asked you:</p>
          <p className="mt-0.5 whitespace-pre-wrap">{task.pendingQuestion}</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answer.trim().length > 0 && !answering) {
                  setAnswering(true);
                  answerQuestion({ taskId: task._id as any, answer: answer.trim() })
                    .catch(() => undefined)
                    .finally(() => {
                      setAnswering(false);
                      setAnswer("");
                    });
                }
              }}
              placeholder="Reply to continue the task…"
              className="min-w-0 flex-1 rounded-lg border border-amber-200 bg-white/80 px-2.5 py-1.5 text-[13px] text-gray-800 placeholder:text-amber-400 focus:border-amber-300 focus:outline-none dark:border-amber-800 dark:bg-gray-900 dark:text-gray-100"
            />
            <button
              type="button"
              disabled={answering || answer.trim().length === 0}
              onClick={async () => {
                setAnswering(true);
                try {
                  await answerQuestion({ taskId: task._id as any, answer: answer.trim() });
                  setAnswer("");
                } catch {
                  /* status flips via the query stream */
                } finally {
                  setAnswering(false);
                }
              }}
              className="flex items-center gap-1.5 rounded-xl bg-[#635bff] px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-[#5346d8] disabled:opacity-50"
            >
              <Check size={14} /> Send
            </button>
          </div>
        </div>
      )}
      {isFailed && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
          <p className="font-semibold">Task failed{task.errorMessage ? `: ${task.errorMessage}` : ""}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await retryTask({ taskId: task._id as any });
                } catch {
                  /* the task row flips to queued via the query stream */
                } finally {
                  setRetrying(false);
                }
              }}
              className="flex items-center gap-1.5 rounded-xl bg-[#635bff] px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-[#5346d8] disabled:opacity-50"
            >
              <RotateCcw size={14} className={retrying ? "animate-spin" : ""} /> Retry task
            </button>
            <button type="button" onClick={() => onOpen(task._id)} className="rounded-xl border border-red-200 bg-white/60 px-3.5 py-2 text-[13px] font-semibold text-red-700 hover:bg-white dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              View thread
            </button>
          </div>
        </div>
      )}
      {(pending.length > 0 || task.status !== "done") && (
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <button type="button" onClick={() => onApprove(pending[0]._id)} className="flex items-center gap-1.5 rounded-xl bg-[#635bff] px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-[#5346d8]">
              <Check size={14} /> Approve
            </button>
          )}
          <button type="button" onClick={() => onOpen(task._id)} className="rounded-xl border border-[#e5e3eb] px-3.5 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
            Open thread
          </button>
          {pending.length === 0 && task.status !== "done" && approvalMode === "ask" && (
            <span className="ml-auto text-[11px] text-gray-400">Waits for approval before push</span>
          )}
        </div>
      )}
    </div>
  );
}
