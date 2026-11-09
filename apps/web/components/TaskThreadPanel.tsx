"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import MessageText from "./chat/MessageText";
import { roleLabel } from "@/lib/agentRoles";
import ApprovalCard from "./ApprovalCard";
import DiffCard from "./DiffCard";
import { Send, Loader2 as SendLoader, RotateCcw } from "lucide-react";
import {
  Check,
  ChevronLeft,
  X,
} from "lucide-react";

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;

export default function TaskThreadPanel({
  taskId,
  collapsed,
  panelWidth,
  onPanelWidthChange,
  onToggle,
  onClose,
}: {
  taskId: string | null;
  collapsed: boolean;
  panelWidth: number;
  onPanelWidthChange: (width: number) => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      // Panel is right-docked: width shrinks as the handle moves right.
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
      onPanelWidthChange(newWidth);
    };

    const handleMouseUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onPanelWidthChange]);
  const task = useQuery(api.tasks.get, taskId ? { taskId: taskId as any } : "skip");
  const taskExists = Boolean(task);
  const project = useQuery(api.projects.get, task?.projectId ? { projectId: task.projectId } : "skip");
  const messages = useQuery(api.messages.listByTask, taskExists ? { taskId: taskId as any } : "skip");
  // Canonical event stream (plan 016): the UI reads this instead of the raw
  // worker/provider vocabulary.
  const agentEvents = useQuery(api.orchestration.listAgentEvents, taskExists ? { taskId: taskId as any } : "skip");
  const fileChanges = useQuery(api.fileChanges.listByTask, taskExists ? { taskId: taskId as any } : "skip");
  const agents = useQuery(api.agents.list, {});
  const execution = useQuery(
    api.executionView.getForTask,
    taskExists ? { taskId: taskId as any } : "skip"
  );

  if (!taskId) return null;

  if (collapsed) {
    return (
      <motion.aside
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={{ duration: 0.2, ease: "easeOut" }}
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

  // ponytail: Checklist (QA/verification results) only renders when
  // task.check events exist. Verification is disabled in dev
  // (ORCHESTRATOR_VERIFICATION_ENABLED=false) so the section was always
  // empty. Add when verification is re-enabled.
  const checks = (agentEvents ?? []).filter((e: any) => e.type === "tool.completed");
  const taskStatus = (task as any)?.status;
  // Scope the "thinking" banner to THIS task: a globally-working agent from
  // an old/failed task (stale `status` in the DB) used to leak "Backend is
  // thinking" into every thread of the project.
  const assignedIds = (task as any)?.assignedAgentIds as string[] | undefined;
  const workingAgent =
    taskStatus === "running"
      ? (agents ?? []).find(
          (agent: any) =>
            agent.status === "working" &&
            (!assignedIds?.length || assignedIds.includes(agent._id))
        )
      : undefined;
  const threadOptions: string[] = Array.isArray((task as any)?.pendingOptions)
    ? (task as any).pendingOptions
    : [];
  const sendThreadMessage = useMutation(api.messages.insertThreadMessage);
  const retryTask = useMutation(api.tasks.retry);
  const cancelTask = useMutation(api.tasks.cancel);
  const answerQuestion = useMutation(api.tasks.answerQuestion);
  const steerTask = useMutation(api.tasks.steerTask);
  const [retrying, setRetrying] = useState(false);
  const [steering, setSteering] = useState(false);
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const hold = useMutation(api.approvals.hold);
  const [reply, setReply] = useState("");
  const [alsoSendToChat, setAlsoSendToChat] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);

  const submitReply = async () => {
    const text = reply.trim();
    if (!text || !task) return;
    setSendingReply(true);
    try {
      await sendThreadMessage({ projectId: task.projectId, taskId: task._id, content: text, alsoSendToChat });
      setReply("");
    } finally {
      setSendingReply(false);
    }
  };
  const submitAnswer = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !task) return;
    setSendingReply(true);
    try {
      await answerQuestion({ taskId: task._id as any, answer: trimmed });
      setReply("");
    } catch {
      /* status flips via the query stream */
    } finally {
      setSendingReply(false);
    }
  };
  const submitSteer = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !task) return;
    setSteering(true);
    try {
      await steerTask({ taskId: task._id as any, instruction: trimmed });
      setReply("");
    } catch {
      /* status flips via the query stream */
    } finally {
      setSteering(false);
    }
  };
  const statusLabel = taskStatus === "done"
    ? "Completed"
    : taskStatus === "needs_approval" || taskStatus === "waiting_input"
      ? "Needs you"
      : taskStatus === "rejected"
        ? "Rejected"
        : taskStatus === "failed"
          ? "Failed"
          : taskStatus === "running"
            ? "Running"
            : "Queued";
  const pendingApprovals = ((execution as any)?.approvals ?? []).filter((a: any) => a.status === "pending");
  const agentById = (id: string | undefined) => ((agents as any) ?? []).find((a: any) => a._id === id);
  const ctoMessages = (messages ?? []).filter((m: any) => {
    const role = agentById(m.agentId)?.role;
    return role === "cto" || role === "reviewer";
  });
  // Agent activity only: the user's own messages live in chat, not the
  // thread. The replies divider counts agent replies only.
  // Delegation handoff rows (`@Reviewer <reasoning>`, written by the
  // worker for agent-to-agent addressing) are not replies: counting them
  // inflated the divider and printed a raw `@Mention` bubble. Exclude them;
  // the handoff itself is recorded via `recordDelegation`.
  const isDelegationHandoff = (m: any) => typeof m.content === "string" && /^@[\w-]+\s/.test(m.content);
  const agentReplies = (messages ?? []).filter(
    (m: any) => m.authorType === "agent" && !ctoMessages.includes(m) && !isDelegationHandoff(m)
  );
  return (
    <div className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-[#ebe9f0] bg-white/90 shadow-[-8px_0_24px_rgba(40,35,80,0.04)] backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80 max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-l-0 max-[979px]:border-t max-[979px]:flex-row">
      <div
        onMouseDown={handleMouseDown}
        className="group absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50 active:bg-blue-400/70 z-10 max-[979px]:hidden"
        title="Drag to resize"
      >
        <div className="absolute left-0 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-gray-600" />
      </div>
      <motion.aside
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{ width: panelWidth, marginLeft: 6 }}
        className="flex h-full min-h-0 flex-col overflow-hidden max-[979px]:h-auto max-[979px]:w-full max-[979px]:flex-row"
      >
      <header className="flex min-h-[66px] items-center justify-between border-b border-[#ebe9f0] bg-white/50 px-4 py-3.5 dark:border-gray-800 dark:bg-gray-950/20">
        <div>
          <h2 className="truncate text-sm font-semibold">{(task as any)?.title ?? "Task thread"}</h2>
          <p className="mt-0.5 text-[11px] text-gray-400">Task thread · {(project as any)?.name ?? "Workspace"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${taskStatus === "done" ? "bg-[#e6f5ec] text-[#348d5c]" : taskStatus === "failed" || taskStatus === "rejected" ? "bg-red-100 text-red-700" : "bg-[#fff0df] text-[#bd6c23]"}`}>
            {statusLabel}
          </span>
          <button type="button" onClick={onClose} title="Close task thread" aria-label="Close task thread" className="rounded-lg p-1 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
      </header>

      <div className="flex items-center gap-1.5 px-4 pt-3" />
      {workingAgent && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
          <span>{roleLabel(workingAgent.role)} is thinking</span>
          <span className="flex gap-0.5">
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:120ms]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:240ms]" />
          </span>
        </div>
      )}

      <div className="h-0 min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain bg-[#fcfcfe] p-4 dark:bg-gray-950/40">
        {taskStatus === "failed" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
            <p className="font-semibold">Task failed{(task as any)?.errorMessage ? `: ${(task as any).errorMessage}` : ""}</p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await retryTask({ taskId: taskId as any });
                  } catch {
                    /* status flips via the task query stream */
                  } finally {
                    setRetrying(false);
                  }
                }}
                className="flex items-center gap-1.5 rounded-xl bg-[#635bff] px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-[#5346d8] disabled:opacity-50"
              >
                <RotateCcw size={14} className={retrying ? "animate-spin" : ""} /> Retry task
              </button>
            </div>
          </div>
        )}
        {taskStatus === "running" && (
          <div className="mx-4 mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-300">
            <p className="font-semibold">Task is running</p>
            <p className="mt-0.5">Reply below steers the in-flight agent — it adjusts its next step without a new task.</p>
          </div>
        )}
        {pendingApprovals.map((a: any) => (
          <ApprovalCard
            key={a._id}
            approval={a}
            taskTitle={(task as any)?.title}
            onApprove={(approvalId) => approve({ approvalId: approvalId as any })}
            onReject={(approvalId) => reject({ approvalId: approvalId as any })}
            onHold={(approvalId) => hold({ approvalId: approvalId as any })}
          />
        ))}
        {taskStatus === "waiting_input" && (task as any)?.pendingQuestion && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
            <p className="font-semibold">The team asked you:</p>
            <p className="mt-1 whitespace-pre-wrap break-words">{(task as any).pendingQuestion}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {threadOptions.map((option, index) => (
                <button
                  key={`${index}-${option}`}
                  type="button"
                  disabled={sendingReply}
                  onClick={() => void submitAnswer(option)}
                  className="rounded-xl border border-amber-300 bg-white/80 px-3 py-2 text-[13px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
                >
                  <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    {String.fromCharCode(65 + index)}
                  </span>
                  {option}
                </button>
              ))}
              <button
                type="button"
                onClick={() => task && void cancelTask({ taskId: task._id as any })}
                className="rounded-xl border border-amber-300 px-3 py-2 text-[13px] font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
              >
                Cancel task
              </button>
            </div>
          </div>
        )}
        {/* Diffs render inline under the CTO summary (see ctoMessages).
            This top section is only the fallback for tasks with no CTO
            messages at all. */}
        {ctoMessages.length === 0 && fileChanges && fileChanges.length > 0 && (
          <section>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase text-gray-500">File changes</h4>
              <span className="text-[11px] font-mono text-gray-400">
                {fileChanges.length} file{fileChanges.length > 1 ? "s" : ""}
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {fileChanges.map((fc: any) => (
                <DiffCard
                  key={fc._id}
                  filePath={fc.filePath}
                  diff={fc.diff}
                  changeType={fc.changeType}
                  oldContent={fc.oldContent}
                  newContent={fc.newContent}
                />
              ))}
            </div>
          </section>
        )}
        {ctoMessages.map((m: any, index: number) => {
          const msgAgent = agentById(m.agentId);
          const isLastCto = index === ctoMessages.length - 1;
          return (
            <div key={m._id} className="flex gap-2">
              <AgentAvatar name={roleLabel(msgAgent?.role)} size={28} avatarParams={msgAgent?.avatarParams} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
                  {roleLabel(msgAgent?.role)}
                  <span className="rounded-full border border-gray-200 px-1.5 py-px text-[10px] font-medium text-gray-400 dark:border-gray-700">review</span>
                  <span className="font-normal text-gray-400">{m._creationTime ? new Date(m._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                </p>
                <MessageText content={m.content} />
                {/* The CTO's summary message carries the run's file diffs
                    inline, like a review note — not in a separate panel. */}
                {isLastCto && fileChanges && fileChanges.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {fileChanges.map((fc: any) => (
                      <DiffCard
                        key={fc._id}
                        filePath={fc.filePath}
                        diff={fc.diff}
                        changeType={fc.changeType}
                        oldContent={fc.oldContent}
                        newContent={fc.newContent}
                      />
                    ))}
                    <div className="flex flex-wrap gap-1.5">
                      {(agentEvents ?? []).some((e: any) => e.type === "agent.completed") && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                          <Check size={11} /> Approved
                        </span>
                      )}
                      {!fileChanges.some((fc: any) => /(^|\/)package(-lock)?\.json$/.test(fc.filePath) || /pnpm-lock\.yaml$/.test(fc.filePath) || fc.filePath.endsWith("yarn.lock")) && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                          no new packages
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {agentReplies.length > 0 && (
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[11px] font-medium text-gray-400">{agentReplies.length} replies</span>
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
          </div>
        )}
        {agentReplies.map((m: any) => {
          const msgAgent = (agents as any)?.find((a: any) => a._id === m.agentId);
          return (
          <div key={m._id} className="flex gap-2">
            <AgentAvatar name={roleLabel(msgAgent?.role)} size={28} avatarParams={msgAgent?.avatarParams} />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
                {roleLabel(msgAgent?.role)}
              </p>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1"><MessageText content={m.content} /></div>
                <span className="shrink-0 pt-0.5 text-[10px] text-gray-400">
                  {m._creationTime ? new Date(m._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
            </div>
          </div>
          );
        })}
        {checks.length > 0 && (
          <section className="border-t border-gray-200 pt-3 dark:border-gray-800">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Checks</span>
              <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
            </div>
            <div className="mt-3 space-y-2">
              {Array.from(new Map(checks.map((event: any) => [event.payload?.label, event])).values()).map((event: any) => {
                const passed = event.payload?.status === "passed" || event.payload?.status === "clean";
                return <div key={event._id} className="flex items-center gap-2 text-sm"><span className={passed ? "text-emerald-600" : "text-amber-600"}>{passed ? "✓" : "◔"}</span><span className="flex-1">{event.payload?.label ?? "QA check"}</span><span className="text-xs text-gray-400">{passed ? "clean" : event.payload?.status}</span></div>;
              })}
            </div>
          </section>
        )}
      </div>

      <form
        className="shrink-0 border-t border-[#ebe9f0] bg-white/80 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80"
        onSubmit={(event) => {
          event.preventDefault();
          if (taskStatus === "waiting_input") void submitAnswer(reply);
          else if (taskStatus === "running") void submitSteer(reply);
          else void submitReply();
        }}
      >
        <div className="rounded-2xl border border-[#e5e3eb] bg-white px-4 pb-3 pt-3.5 shadow-sm transition focus-within:border-[#a29ae8] focus-within:ring-2 focus-within:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-900">
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (taskStatus === "waiting_input") void submitAnswer(reply);
                else if (taskStatus === "running") void submitSteer(reply);
                else void submitReply();
              }
            }}
            rows={2}
            placeholder={
              taskStatus === "waiting_input"
                ? "Answer to continue the task…"
                : taskStatus === "running"
                  ? "Steer the running task…"
                  : "Reply to the thread"
            }
            className="w-full resize-none bg-transparent px-0.5 text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
          />
          <div className="mt-1 flex items-center gap-2">
            {taskStatus !== "waiting_input" && taskStatus !== "running" && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={alsoSendToChat}
                  onChange={(event) => setAlsoSendToChat(event.target.checked)}
                  className="rounded"
                />
                Also send to chat
              </label>
            )}
            <button
              type="submit"
              disabled={sendingReply || steering || !reply.trim()}
              aria-label={
                taskStatus === "waiting_input"
                  ? "Send answer"
                  : taskStatus === "running"
                    ? "Steer task"
                    : "Send reply"
              }
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm transition hover:bg-[#5346d8] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sendingReply || steering ? <SendLoader size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      </form>
      </motion.aside>
    </div>
  );
}