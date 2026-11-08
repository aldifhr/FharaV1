"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import InitialAvatar from "./InitialAvatar";
import { roleLabel } from "@/lib/agentRoles";
import ApprovalCard from "./ApprovalCard";
import DiffCard from "./DiffCard";
import { Send, Loader2 as SendLoader } from "lucide-react";
import {
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
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
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
  const events = useQuery(api.taskEvents.listByTask, taskExists ? { taskId: taskId as any } : "skip");
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
  const checks = (events ?? []).filter((e: any) => e.type === "task.check");
  const errors = (events ?? []).filter((e: any) => e.type === "task.error");
  const workingAgent = (agents ?? []).find((agent: any) => agent.status === "working");
  const taskStatus = (task as any)?.status;
  const sendThreadMessage = useMutation(api.messages.insertThreadMessage);
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
  const pendingApprovals = ((execution as any)?.approvals ?? []).filter((a: any) => a.status === "pending");
  const agentById = (id: string | undefined) => ((agents as any) ?? []).find((a: any) => a._id === id);
  const ctoMessages = (messages ?? []).filter((m: any) => {
    const role = agentById(m.agentId)?.role;
    return role === "cto" || role === "reviewer";
  });
  // User messages are the task request — not replies. They render first
  // and are excluded from the reply count (counting the user's own
  // command as a "reply" was the bug).
  const userMessages = (messages ?? []).filter((m: any) => m.authorType === "user");
  const agentReplies = (messages ?? []).filter(
    (m: any) => m.authorType === "agent" && !ctoMessages.includes(m)
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

      <div className="flex items-center gap-1.5 px-4 pt-3">
        {(agents as any)?.find((a: any) => a.role === "cto") && (
          <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700 dark:text-white">
            <AgentAvatar name="CTO" size={16} avatarParams={(agents as any)?.find((a: any) => a.role === "cto")?.avatarParams} /> CTO · review
          </span>
        )}
      </div>
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
        {taskStatus === "failed" && (task as any)?.errorMessage && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <p className="font-semibold">Task failed</p>
            <p className="mt-1 break-words">{(task as any).errorMessage}</p>
          </div>
        )}
        {errors.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <p className="font-semibold">Agent error</p>
            <p className="mt-1 break-words">{errors[errors.length - 1].payload?.message ?? "Task failed to process."}</p>
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
        {fileChanges && fileChanges.length > 0 && (
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
        {userMessages.map((m: any) => {
          // The task command may carry planner-only context (appended for
          // ambiguous short commands) — show the human part only.
          const raw: string = m.content ?? "";
          const marker = "\n\n--- Conversation context ---";
          const head = raw.includes(marker) ? raw.slice(0, raw.indexOf(marker)) : raw;
          return (
          <div key={m._id} className="flex gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white">U</div>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
                You
                <span className="font-normal text-gray-400">{m._creationTime ? new Date(m._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm dark:text-white">{head}</p>
            </div>
          </div>
          );
        })}
        {ctoMessages.map((m: any) => {
          const msgAgent = agentById(m.agentId);
          return (
            <div key={m._id} className="flex gap-2">
              <AgentAvatar name={roleLabel(msgAgent?.role)} size={28} avatarParams={msgAgent?.avatarParams} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
                  {roleLabel(msgAgent?.role)}
                  <span className="rounded-full border border-gray-200 px-1.5 py-px text-[10px] font-medium text-gray-400 dark:border-gray-700">review</span>
                  <span className="font-normal text-gray-400">{m._creationTime ? new Date(m._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm dark:text-white">{m.content}</p>
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
            <InitialAvatar name={roleLabel(msgAgent?.role)} size={28} />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
                {roleLabel(msgAgent?.role)}
              </p>
              <div className="flex items-center gap-2">
                <p className="whitespace-pre-wrap break-words text-sm dark:text-white">{m.content}</p>
                <span className="shrink-0 text-[10px] text-gray-400">
                  {m._creationTime ? new Date(m._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
            </div>
          </div>
          );
        })}
        {checks.length > 0 && (
          <section className="border-t border-gray-200 pt-3 dark:border-gray-800">
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              <span>Checks</span><span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
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
        onSubmit={(event) => { event.preventDefault(); void submitReply(); }}
      >
        <div className="rounded-2xl border border-[#e5e3eb] bg-white px-4 pb-3 pt-3.5 shadow-sm transition focus-within:border-[#a29ae8] focus-within:ring-2 focus-within:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-900">
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitReply();
              }
            }}
            rows={2}
            placeholder="Reply to the thread"
            className="w-full resize-none bg-transparent px-0.5 text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
          />
          <div className="mt-1 flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                checked={alsoSendToChat}
                onChange={(event) => setAlsoSendToChat(event.target.checked)}
                className="rounded"
              />
              Also send to chat
            </label>
            <button
              type="submit"
              disabled={sendingReply || !reply.trim()}
              aria-label="Send reply"
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm transition hover:bg-[#5346d8] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sendingReply ? <SendLoader size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      </form>
      </motion.aside>
    </div>
  );
}