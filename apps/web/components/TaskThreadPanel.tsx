"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "@/api/convex/_generated/api";
import MessageText from "./chat/MessageText";
import { roleLabel } from "@/lib/agentRoles";
import { TASK_STATUS_PILL, NEUTRAL_PILL, subtaskStatusMeta, taskStatusLabel } from "@/lib/taskStatus";
import ApprovalCard from "./ApprovalCard";
import DiffCard from "./DiffCard";
import InitialAvatar from "./InitialAvatar";
import ChatCard from "./chat/cards/ChatCard";
import ReviewSnippet from "./chat/cards/ReviewSnippet";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { Skeleton } from "@/app/WorkspaceContext";
import { ArrowLeft, Check, ChevronLeft, Loader2 as SendLoader, RotateCcw, Send, X } from "lucide-react";

const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const KEYBOARD_STEP = 16;

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");
const timeOf = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";

export default function TaskThreadPanel({
  taskId,
  collapsed,
  panelWidth,
  fullScreen = false,
  onPanelWidthChange,
  onToggle,
  onClose,
}: {
  taskId: string | null;
  collapsed: boolean;
  panelWidth: number;
  /** Phone layout: the thread fills the screen as a sheet. */
  fullScreen?: boolean;
  onPanelWidthChange: (width: number) => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  // ── Every hook runs on every render, before any early return (Rules of
  // Hooks). Returning before these crashed the panel when `collapsed` or
  // `taskId` changed on the same instance.
  const toast = useToast();
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);

  const task = useQuery(api.tasks.get, taskId ? { taskId: taskId as any } : "skip");
  const taskExists = Boolean(task);
  const project = useQuery(api.projects.get, task?.projectId ? { projectId: task.projectId } : "skip");
  const messages = useQuery(api.messages.listByTask, taskExists ? { taskId: taskId as any } : "skip");
  // Canonical event stream (plan 016): the UI reads this instead of the raw
  // worker/provider vocabulary.
  const agentEvents = useQuery(api.orchestration.listAgentEvents, taskExists ? { taskId: taskId as any } : "skip");
  const fileChanges = useQuery(api.fileChanges.listByTask, taskExists ? { taskId: taskId as any } : "skip");
  const agents = useQuery(api.agents.list, {});
  const execution = useQuery(api.executionView.getForTask, taskExists ? { taskId: taskId as any } : "skip");

  const sendThreadMessage = useMutation(api.messages.insertThreadMessage);
  const retryTask = useMutation(api.tasks.retry);
  const cancelTask = useMutation(api.tasks.cancel);
  const answerQuestion = useMutation(api.tasks.answerQuestion);
  const steerTask = useMutation(api.tasks.steerTask);
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const hold = useMutation(api.approvals.hold);
  const [retrying, setRetrying] = useState(false);
  const [steering, setSteering] = useState(false);
  const [reply, setReply] = useState("");
  const [alsoSendToChat, setAlsoSendToChat] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: PointerEvent) => {
      if (!resizingRef.current) return;
      // Panel is right-docked: width shrinks as the handle moves right.
      onPanelWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX)));
    };
    const handleUp = () => {
      resizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [isResizing, onPanelWidthChange]);

  // Escape closes the full-screen sheet on phones.
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmReq) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullScreen, onClose, confirmReq]);

  // ── Early returns (after all hooks) ────────────────────────────────────
  if (!taskId) return null;

  if (collapsed && !fullScreen) {
    return (
      <motion.aside
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex h-full w-11 shrink-0 items-start justify-center border-l border-[#ebe9f0] bg-white/80 pt-3 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80"
      >
        <button
          type="button"
          onClick={onToggle}
          title="Expand task thread"
          aria-label="Expand task thread"
          className="rounded-lg p-1.5 text-gray-500 outline-none hover:bg-gray-100 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <ChevronLeft size={17} />
        </button>
      </motion.aside>
    );
  }

  const shellClass = fullScreen
    ? "relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950"
    : "relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-[#ebe9f0] bg-white/90 shadow-[-8px_0_24px_rgba(40,35,80,0.04)] backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80";

  const closeButton = fullScreen ? (
    <button type="button" onClick={onClose} aria-label="Back to chat" className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-300 dark:hover:bg-gray-800">
      <ArrowLeft size={18} />
    </button>
  ) : null;
  const xButton = !fullScreen ? (
    <button type="button" onClick={onClose} title="Close task thread" aria-label="Close task thread" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-gray-100 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200">
      <X size={16} />
    </button>
  ) : null;

  const resizeHandle = !fullScreen ? (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task thread"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={panelWidth}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); onPanelWidthChange(Math.min(MAX_WIDTH, panelWidth + KEYBOARD_STEP)); }
        if (e.key === "ArrowRight") { e.preventDefault(); onPanelWidthChange(Math.max(MIN_WIDTH, panelWidth - KEYBOARD_STEP)); }
      }}
      className="group absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none outline-none hover:bg-[#635bff]/30 focus-visible:bg-[#635bff]/40 active:bg-[#635bff]/50"
      title="Drag to resize"
    >
      <div className="absolute left-0 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-gray-600" />
    </div>
  ) : null;

  const asideStyle = fullScreen ? undefined : { width: panelWidth, marginLeft: 6 };

  // Loading / deleted states (previously both read "Queued" forever).
  if (task === undefined || task === null) {
    return (
      <div className={shellClass}>
        {resizeHandle}
        <aside style={asideStyle} className="flex h-full min-h-0 flex-col">
          <header className="flex min-h-[60px] items-center gap-2 border-b border-[#ebe9f0] px-4 py-3 dark:border-gray-800">
            {closeButton}
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{task === null ? "Task not found" : "Loading task…"}</h2>
            {xButton}
          </header>
          {task === undefined ? (
            <div className="space-y-3 p-4" role="status" aria-label="Loading task">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ) : (
            <p className="p-4 text-sm text-gray-600 dark:text-gray-300">This task was deleted or is no longer available.</p>
          )}
        </aside>
      </div>
    );
  }

  // ponytail: Checklist (QA/verification results) only renders when
  // tool.completed events exist (verification is disabled in dev).
  const checks = (agentEvents ?? []).filter((e: any) => e.type === "tool.completed");
  const taskStatus = (task as any).status as string;
  const threadOptions: string[] = Array.isArray((task as any).pendingOptions) ? (task as any).pendingOptions : [];
  const subtasks: any[] = [...((execution as any)?.subtasks ?? [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));

  const submitReply = async () => {
    const text = reply.trim();
    if (!text) return;
    setSendingReply(true);
    try {
      await sendThreadMessage({ projectId: task.projectId, taskId: task._id, content: text, alsoSendToChat });
      setReply("");
    } catch (err) {
      toast("error", "Couldn't send reply", errorText(err));
    } finally {
      setSendingReply(false);
    }
  };
  const submitAnswer = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSendingReply(true);
    try {
      await answerQuestion({ taskId: task._id as any, answer: trimmed });
      setReply("");
    } catch (err) {
      toast("error", "Couldn't send answer", errorText(err));
    } finally {
      setSendingReply(false);
    }
  };
  const submitSteer = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSteering(true);
    try {
      await steerTask({ taskId: task._id as any, instruction: trimmed });
      setReply("");
      toast("success", "Sent to the running agent");
    } catch (err) {
      toast("error", "Couldn't steer the task", errorText(err));
    } finally {
      setSteering(false);
    }
  };
  const submit = () => {
    if (sendingReply || steering) return;
    if (taskStatus === "waiting_input") void submitAnswer(reply);
    else if (taskStatus === "running") void submitSteer(reply);
    else void submitReply();
  };
  const doRetry = async () => {
    setRetrying(true);
    try {
      await retryTask({ taskId: task._id as any });
      toast("success", "Task re-queued");
    } catch (err) {
      toast("error", "Couldn't retry task", errorText(err));
    } finally {
      setRetrying(false);
    }
  };
  const askCancel = () =>
    setConfirmReq({
      title: "Cancel this task?",
      message: "The task stops and is marked as cancelled. You can retry it later.",
      confirmLabel: "Cancel task",
      onOk: () => {
        void cancelTask({ taskId: task._id as any })
          .then(() => setConfirmReq(null))
          .catch((err) => {
            setConfirmReq(null);
            toast("error", "Couldn't cancel task", errorText(err));
          });
      },
    });

  const pendingApprovals = ((execution as any)?.approvals ?? []).filter((a: any) => a.status === "pending");
  const approvedByHuman = ((execution as any)?.approvals ?? []).some((a: any) => a.status === "approved");
  const agentById = (id: string | undefined) => ((agents as any) ?? []).find((a: any) => a._id === id);
  const ctoMessages = (messages ?? []).filter((m: any) => {
    if (m.authorType !== "agent") return false;
    const role = agentById(m.agentId)?.role;
    return role === "cto" || role === "reviewer";
  });
  // Delegation handoff rows (`@Reviewer <reasoning>`, written by the worker
  // for agent-to-agent addressing) are not replies; the handoff is recorded
  // via `recordDelegation`.
  const isDelegationHandoff = (m: any) => m.authorType === "agent" && typeof m.content === "string" && /^@[\w-]+\s/.test(m.content);
  // Agent replies plus the user's own replies/steers, so the user can see
  // that what they sent went through.
  const threadReplies = (messages ?? []).filter(
    (m: any) => (m.authorType === "agent" && !ctoMessages.includes(m) && !isDelegationHandoff(m)) || m.authorType === "user",
  );
  const replyCount = threadReplies.length;
  const busy = sendingReply || steering;

  return (
    <div className={shellClass}>
      {resizeHandle}
      <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <motion.aside
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={asideStyle}
        className="flex h-full min-h-0 flex-col overflow-hidden"
      >
        <header className="flex min-h-[60px] items-start justify-between gap-2 border-b border-[#ebe9f0] bg-white/50 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] dark:border-gray-800 dark:bg-gray-950/20">
          {closeButton}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">{(task as any).title}</h2>
              <span className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-4 ${TASK_STATUS_PILL[taskStatus] ?? NEUTRAL_PILL}`}>
                {taskStatusLabel(taskStatus)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">Task thread · {(project as any)?.name ?? "Workspace"}</p>
          </div>
          {xButton}
        </header>

        <div className="h-0 min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain bg-[#fcfcfe] p-4 dark:bg-gray-950/40">
          {(taskStatus === "failed" || taskStatus === "rejected") && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
              <p className="font-semibold">
                {taskStatus === "rejected" ? "Task rejected" : "Task failed"}
                {(task as any).errorMessage ? `: ${(task as any).errorMessage}` : ""}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={retrying}
                  onClick={() => void doRetry()}
                  className="flex items-center gap-1.5 rounded-xl bg-[#635bff] px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm outline-none hover:bg-[#5346d8] focus-visible:ring-2 focus-visible:ring-[#635bff]/50 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-950"
                >
                  <RotateCcw size={14} className={retrying ? "animate-spin" : ""} /> Retry task
                </button>
              </div>
            </div>
          )}
          {taskStatus === "running" && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-300">
              <p className="font-semibold">Task is running</p>
              <p className="mt-0.5">A reply below steers the in-flight agent: it adjusts its next step without a new task.</p>
            </div>
          )}
          {pendingApprovals.map((a: any) => (
            <ApprovalCard
              key={a._id}
              approval={a}
              taskTitle={(task as any).title}
              onApprove={(approvalId) => approve({ approvalId: approvalId as any })}
              onReject={(approvalId) => reject({ approvalId: approvalId as any })}
              onHold={(approvalId) => hold({ approvalId: approvalId as any })}
            />
          ))}
          {taskStatus === "waiting_input" && (task as any).pendingQuestion && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
              <p className="font-semibold">The team asked you:</p>
              <p className="mt-1 whitespace-pre-wrap break-words">{(task as any).pendingQuestion}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {threadOptions.map((option, index) => (
                  <button
                    key={`${index}-${option}`}
                    type="button"
                    disabled={sendingReply}
                    onClick={() => void submitAnswer(option)}
                    className="rounded-xl border border-amber-300 bg-white/80 px-3 py-2 text-left text-[13px] font-semibold text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  >
                    <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                      {String.fromCharCode(65 + index)}
                    </span>
                    {option}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={askCancel}
                  className="rounded-xl border border-amber-300 px-3 py-2 text-[13px] font-semibold text-amber-700 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-400/60 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                >
                  Cancel task
                </button>
              </div>
            </div>
          )}
          {subtasks.length > 0 && (
            <section aria-label="Subtasks">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Subtasks</h3>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {subtasks.filter((s) => s.status === "completed").length}/{subtasks.length}
                </span>
                <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
              </div>
              <ul className="mt-2 space-y-1.5">
                {subtasks.map((s: any) => {
                  const meta = subtaskStatusMeta(s.status);
                  const Icon = meta.icon;
                  const agent = agentById(s.assignedAgentId);
                  return (
                    <li key={s._id} className="flex items-center gap-2 text-xs">
                      <Icon size={13} className={`shrink-0 ${meta.cls}${s.status === "running" ? " animate-spin" : ""}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
                        {s.title}
                        {typeof s.reviewRound === "number" && s.reviewRound > 1 ? (
                          <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">(round {s.reviewRound})</span>
                        ) : null}
                      </span>
                      {agent && <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">{roleLabel(agent.role)}</span>}
                      <span className={`shrink-0 text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {/* Diffs render inline under the CTO summary (see ctoMessages).
              This top section is only the fallback for tasks with no CTO
              messages at all. */}
          {ctoMessages.length === 0 && fileChanges && fileChanges.length > 0 && (
            <section>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">File changes</h3>
                <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
                  {fileChanges.length} file{fileChanges.length > 1 ? "s" : ""}
                </span>
              </div>
              <div className="mt-2 space-y-2">
                {fileChanges.map((fc: any) => (
                  <DiffCard key={fc._id} filePath={fc.filePath} diff={fc.diff} changeType={fc.changeType} oldContent={fc.oldContent} newContent={fc.newContent} />
                ))}
              </div>
            </section>
          )}
          {ctoMessages.map((m: any, index: number) => {
            const msgAgent = agentById(m.agentId);
            const isLastCto = index === ctoMessages.length - 1;
            const isReview = !m.card;
            return (
              <div key={m._id} className="flex gap-2.5">
                <InitialAvatar name={roleLabel(msgAgent?.role)} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-800 dark:text-neutral-100">
                    {roleLabel(msgAgent?.role)}
                    {isReview && (
                      <span className="rounded-md border border-[#e3e1ea] px-1.5 py-px text-[11px] font-medium text-[#8a8796] dark:border-white/15 dark:text-neutral-400">review</span>
                    )}
                    <span className="text-[11px] font-normal text-[#8a8796] dark:text-neutral-400">{timeOf(m._creationTime)}</span>
                  </p>
                  {m.content?.trim() ? <MessageText content={m.content} /> : null}
                  {m.card && (
                    <div className="mt-2">
                      <ChatCard card={m.card} />
                    </div>
                  )}
                  {/* The CTO's latest review note carries a snippet of the
                      run's diff and its status chips; the full diff is one
                      click away. */}
                  {isLastCto && isReview && fileChanges && fileChanges.length > 0 && (
                    <ReviewSnippet
                      files={fileChanges as any}
                      approved={approvedByHuman}
                      completed={(agentEvents ?? []).some((e: any) => e.type === "agent.completed")}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {replyCount > 0 && (
            <div className="flex items-center gap-3 pt-1">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
              <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
            </div>
          )}
          {threadReplies.map((m: any) => {
            if (m.authorType === "user") {
              return (
                <div key={m._id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#eeecfb] px-3 py-2 dark:bg-indigo-950/50">
                    <p className="text-[11px] font-semibold text-[#5147b4] dark:text-indigo-300">
                      You <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">{timeOf(m._creationTime)}</span>
                    </p>
                    <MessageText content={m.content} />
                  </div>
                </div>
              );
            }
            const msgAgent = agentById(m.agentId);
            return (
              <div key={m._id} className="flex gap-2.5">
                <InitialAvatar name={roleLabel(msgAgent?.role)} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-800 dark:text-neutral-100">
                    {roleLabel(msgAgent?.role)}
                    <span className="text-[11px] font-normal text-[#8a8796] dark:text-neutral-400">{timeOf(m._creationTime)}</span>
                  </p>
                  {m.content?.trim() ? <MessageText content={m.content} /> : null}
                  {m.card && (
                    <div className="mt-2">
                      <ChatCard card={m.card} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {checks.length > 0 && (
            <section className="border-t border-gray-200 pt-3 dark:border-gray-800">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Checks</h3>
                <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
              </div>
              <div className="mt-3 space-y-2">
                {Array.from(new Map(checks.map((event: any) => [event.payload?.label, event])).values()).map((event: any) => {
                  const passed = event.payload?.status === "passed" || event.payload?.status === "clean";
                  return (
                    <div key={event._id} className="flex items-center gap-2 text-sm">
                      <span aria-hidden="true" className={passed ? "text-emerald-600" : "text-amber-600"}>{passed ? "✓" : "◔"}</span>
                      <span className="flex-1">{event.payload?.label ?? "QA check"}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">{passed ? "clean" : event.payload?.status ?? "not run"}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <form
          className="shrink-0 border-t border-[#ebe9f0] bg-white/80 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="rounded-2xl border border-[#e5e3eb] bg-white px-4 pb-3 pt-3 shadow-sm transition focus-within:border-[#a29ae8] focus-within:ring-2 focus-within:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-900">
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={2}
              aria-label={taskStatus === "waiting_input" ? "Answer the team" : taskStatus === "running" ? "Steer the running task" : "Reply to the thread"}
              placeholder={
                taskStatus === "waiting_input"
                  ? "Answer to continue the task…"
                  : taskStatus === "running"
                    ? "Steer the running task…"
                    : "Reply to the thread"
              }
              className="w-full resize-none bg-transparent px-0.5 text-base leading-6 text-gray-900 outline-none placeholder:text-gray-400 sm:text-[15px] dark:text-white dark:placeholder:text-gray-500"
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
              <span className="ml-auto hidden text-[11px] text-gray-500 sm:block dark:text-gray-400">Enter to send · Shift+Enter for a new line</span>
              <button
                type="submit"
                disabled={busy || !reply.trim()}
                aria-label={taskStatus === "waiting_input" ? "Send answer" : taskStatus === "running" ? "Steer task" : "Send reply"}
                className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm outline-none transition hover:bg-[#5346d8] focus-visible:ring-2 focus-visible:ring-[#635bff]/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 sm:ml-0 sm:h-8 sm:w-8 dark:focus-visible:ring-offset-gray-900"
              >
                {busy ? <SendLoader size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </form>
      </motion.aside>
    </div>
  );
}
