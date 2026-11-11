"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { ReviewerSection, SecondOpinionButton } from "@/components/review/Reviewer";
import Link from "next/link";
import { motion } from "framer-motion";
import { api } from "@/api/convex/_generated/api";
import MessageText from "./chat/MessageText";
import { agentName, roleLabel } from "@/lib/agentRoles";
import { subtaskStatusMeta, taskStatusLabel } from "@/lib/taskStatus";
import ApprovalCard from "./ApprovalCard";
import ChangesPane, { ThreadTabs, useThreadView } from "./changes/ChangesPane";
import InitialAvatar from "./InitialAvatar";
import SubtaskActivity from "./SubtaskActivity";
import SubtaskLiveOutput from "./SubtaskLiveOutput";
import ChatCard from "./chat/cards/ChatCard";
import ReviewSnippet from "./chat/cards/ReviewSnippet";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import PauseResumeButton from "./PauseResumeButton";
import TaskHoldNotice from "./TaskHoldNotice";
import TaskQuestionCard from "./TaskQuestionCard";
import SystemLineRow from "./chat/SystemLineRow";
import { canReplyTo, systemLineText, threadBlockOf } from "@/lib/systemLine";
import Requirements from "./runs/Requirements";
import { useToast } from "./Toasts";
import { EditableTitle } from "./ThreadRename";
import { useSequencedEvents } from "@/lib/useSequencedEvents";
import { Skeleton } from "@/app/WorkspaceContext";
import { ArrowLeft, ArrowUpRight, AtSign, Check, ChevronLeft, Loader2 as SendLoader, Minimize2, Paperclip, Reply, RotateCcw, SendHorizontal, Square, X } from "lucide-react";
import { QuoteBar, QuotedSnippet, quoteOf, type ChatQuote } from "./chat/QuoteBlock";
import { clockTime } from "@/lib/format";
import { groupActivity, groupByIndex } from "@/lib/activityGroups";
import ActivityGroupRow from "./chat/ActivityGroupRow";
import { PERMISSION_MODE_LABELS, normalizePermissionMode } from "@/api/convex/lib/permissionModes";
import { refusalCopy } from "@/lib/taskInput";

const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 390;
const WIDE_WIDTH = 640;
const KEYBOARD_STEP = 16;
const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");
const timeOf = (ms?: number) => (ms ? clockTime(ms) : "");

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
  // Newest window, merged by sequence; a reconnect gap replays or re-snapshots.
  const convex = useConvex();
  const agentEventsWindow = useQuery(api.orchestration.listAgentEvents, taskExists ? { taskId: taskId as any } : "skip");
  const agentEvents = useSequencedEvents(taskExists ? taskId : null, agentEventsWindow as any[] | undefined, (afterSequence) =>
    convex.query(api.orchestration.agentEventsSince, { taskId: taskId as any, afterSequence }) as any
  );
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
  const respondCommand = useMutation(api.commandApprovals.respond);
  const [retrying, setRetrying] = useState(false);
  const [steering, setSteering] = useState(false);
  const [reply, setReply] = useState("");
  // Why the input guard refused the last steer/answer (quiet inline line).
  const [refusal, setRefusal] = useState<string | null>(null);
  const [alsoSendToChat, setAlsoSendToChat] = useState(false);
  // Thread "Reply": the message the next reply quotes.
  const [quote, setQuote] = useState<ChatQuote | null>(null);
  useEffect(() => setQuote(null), [taskId]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);
  const startReply = (m: any) => {
    setQuote(quoteOf(m, agents as any));
    requestAnimationFrame(() => replyRef.current?.focus());
  };
  const jumpTo = (messageId: string) => {
    const el = document.getElementById(`thread-message-${messageId}`);
    if (!el) {
      toast("info", "That message is not shown in this thread.");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(messageId);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1600);
  };
  const [sendingReply, setSendingReply] = useState(false);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const [threadView, setThreadView] = useThreadView(taskId);
  const replyRef = useRef<HTMLTextAreaElement>(null);

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
        className="flex h-full w-11 shrink-0 items-start justify-center border-l border-line bg-panel pt-4"
      >
        <button
          type="button"
          onClick={onToggle}
          title="Expand task thread"
          aria-label="Expand task thread"
          className="rounded-lg p-1.5 text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <ChevronLeft size={17} />
        </button>
      </motion.aside>
    );
  }

  const shellClass = fullScreen
    ? "relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-panel text-ink"
    : "relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-line bg-panel text-ink";

  const closeButton = fullScreen ? (
    <button type="button" onClick={onClose} aria-label="Back to chat" className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30">
      <ArrowLeft size={18} />
    </button>
  ) : null;
  const wide = panelWidth >= WIDE_WIDTH - 20;
  const headerBtn =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30";
  const xButton = !fullScreen ? (
    <>
      <button
        type="button"
        onClick={() => onPanelWidthChange(wide ? DEFAULT_WIDTH : WIDE_WIDTH)}
        title={wide ? "Narrow the thread" : "Widen the thread"}
        aria-label={wide ? "Narrow the thread" : "Widen the thread"}
        className={headerBtn}
      >
        {wide ? <Minimize2 size={15} /> : <ArrowUpRight size={16} />}
      </button>
      <button type="button" onClick={onClose} title="Close task thread" aria-label="Close task thread" className={headerBtn}>
        <X size={17} />
      </button>
    </>
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
      className="group absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none outline-none hover:bg-ink/20 focus-visible:bg-ink/20 active:bg-ink/20"
      title="Drag to resize"
    >
      <div className="absolute left-0 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-gray-600" />
    </div>
  ) : null;

  const asideStyle = fullScreen ? undefined : { width: panelWidth };

  // Loading / deleted states (previously both read "Queued" forever).
  if (task === undefined || task === null) {
    return (
      <div className={shellClass}>
        {resizeHandle}
        <aside style={asideStyle} className="flex h-full min-h-0 flex-col">
          <header className="flex min-h-[64px] items-center gap-2 border-b border-line px-5 py-3">
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
            <p className="p-5 text-[14px] text-ink-2">This task was deleted or is no longer available.</p>
          )}
        </aside>
      </div>
    );
  }

  // ponytail: Checklist (QA/verification results) only renders when
  // tool.completed events exist (verification is disabled in dev).
  const checks = (agentEvents ?? []).filter((e: any) => e.type === "tool.completed");
  const taskStatus = (task as any).status as string;
  const busy = sendingReply || steering;
  const subtasks: any[] = [...((execution as any)?.subtasks ?? [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));

  // Every reply lands in the thread (so the user sees it went through); a
  // running task is also steered, a waiting one is answered. "Also send to
  // chat" mirrors the reply into the project chat.
  const submit = async () => {
    const text = reply.trim();
    if (!text || busy) return;
    // A queued task takes the steer when the worker picks it up; a paused
    // one after Resume (plan 022).
    const steer = taskStatus === "running" || taskStatus === "queued" || taskStatus === "paused";
    const answer = taskStatus === "waiting_input";
    if (steer) setSteering(true);
    else setSendingReply(true);
    setRefusal(null);
    try {
      if (answer || steer) {
        const res = answer
          ? await answerQuestion({ taskId: task._id as any, answer: text, question: (task as any).pendingQuestion })
          : await steerTask({ taskId: task._id as any, instruction: text });
        // Refused by the input guard: say why under the composer and keep
        // the text, instead of a toast or a thread message that never landed.
        if (!res.applied) {
          setRefusal(refusalCopy(res.reason));
          return;
        }
      }
      await sendThreadMessage({
        projectId: task.projectId,
        taskId: task._id,
        content: text,
        alsoSendToChat,
        ...(quote ? { quotedMessageId: quote.messageId as any } : {}),
      });
      setReply("");
      setQuote(null);
      if (steer) toast("success", taskStatus === "paused" ? "Saved — the agent reads it after you resume" : "Sent to the running agent");
    } catch (err) {
      toast("error", answer ? "Couldn't send answer" : steer ? "Couldn't steer the task" : "Couldn't send reply", errorText(err));
    } finally {
      setSteering(false);
      setSendingReply(false);
    }
  };
  const submitAnswer = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSendingReply(true);
    setRefusal(null);
    try {
      const res = await answerQuestion({ taskId: task._id as any, answer: trimmed, question: (task as any).pendingQuestion });
      if (!res.applied) {
        setRefusal(refusalCopy(res.reason));
        return;
      }
      await sendThreadMessage({ projectId: task.projectId, taskId: task._id, content: trimmed, alsoSendToChat });
      setReply("");
    } catch (err) {
      toast("error", "Couldn't send answer", errorText(err));
    } finally {
      setSendingReply(false);
    }
  };
  const attachFile = async (file: File) => {
    if (file.size > 200_000) {
      toast("error", "File too large", "Attach text files up to 200 KB.");
      return;
    }
    const text = await file.text();
    if (text.includes("\u0000")) {
      toast("error", "Only text files can be attached", file.name);
      return;
    }
    const ext = file.name.split(".").pop() ?? "";
    setReply((r) => `${r}${r ? "\n\n" : ""}\`${file.name}\`:\n\`\`\`${ext}\n${text.trimEnd()}\n\`\`\`\n`);
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
      icon: "stop",
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
  // O4: the pinned block holds the final report (as the Response Owner), review notes and CTO
  // architecture decisions; everything else is a reply. System lines render as status rows.
  const responseOwner = (task as any).responseOwner as string | undefined;
  const blockOf = (m: any) => threadBlockOf(m, agentById(m.agentId)?.role, responseOwner);
  const ctoMessages = (messages ?? []).filter((m: any) => blockOf(m) !== null);
  // Delegation handoff rows (`@Reviewer <reasoning>`, written by the worker
  // for agent-to-agent addressing) are not replies; the handoff is recorded
  // via `recordDelegation`.
  const isDelegationHandoff = (m: any) => m.authorType === "agent" && typeof m.content === "string" && /^@[\w-]+\s/.test(m.content);
  // Agent replies plus the user's own replies/steers, so the user can see
  // that what they sent went through.
  // The task's own command (first user message) is the thread's subject,
  // not a reply.
  const commandMessageId = (messages ?? []).find((m: any) => m.authorType === "user")?._id;
  const threadReplies = (messages ?? []).filter(
    (m: any) =>
      (m.authorType === "agent" && !ctoMessages.includes(m) && !isDelegationHandoff(m)) ||
      (m.authorType === "user" && m._id !== commandMessageId),
  );
  const replyCount = threadReplies.filter((m: any) => systemLineText(m) === null).length;
  // Compact activity log: consecutive activity cards from one agent
  // collapse into one summary row (lib/activityGroups).
  const replyGroups = groupByIndex(
    groupActivity(threadReplies, {
      sameBlock: () => true,
      agentLabel: (agentId) => {
        const agent = agentById(agentId);
        return agent ? roleLabel(agent.role) : undefined;
      },
    })
  );

  const needsYou = taskStatus === "needs_approval" || taskStatus === "waiting_input" || pendingApprovals.length > 0;
  const pill = needsYou
    ? { label: "Needs you", cls: "bg-warn-soft text-warn" }
    : taskStatus === "running"
      ? { label: "In progress", cls: "bg-hover text-ink" }
      : taskStatus === "paused"
        ? { label: "Paused", cls: "bg-hover text-ink-2" }
      : taskStatus === "done"
        ? { label: "Done", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" }
        : taskStatus === "failed" || taskStatus === "rejected"
          ? { label: taskStatusLabel(taskStatus), cls: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" }
          : { label: taskStatusLabel(taskStatus), cls: "bg-hover text-ink-2" };
  const placeholder =
    taskStatus === "waiting_input"
      ? "Answer to continue the task"
      : taskStatus === "running"
        ? "Steer the running task"
        : taskStatus === "paused"
          ? "Steer the paused task (read after Resume)"
          : "Reply to the thread";
  /** Hover Reply on a thread message (text messages only). */
  const replyButton = (m: any) =>
    canReplyTo(m) ? (
      <button
        type="button"
        aria-label="Reply"
        title="Reply"
        onClick={() => startReply(m)}
        className="absolute right-0 top-0 flex h-7 w-7 items-center justify-center rounded-md text-ink-3 opacity-0 outline-none transition hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 group-hover:opacity-100 [@media(hover:none)]:hidden"
      >
        <Reply size={15} />
      </button>
    ) : null;
  const rowClass = (m: any) =>
    `group relative flex gap-3 rounded-xl transition-colors duration-700 ${flashId === String(m._id) ? "bg-hover" : ""}`;
  const quoteFor = (m: any) => {
    if (!m.quotedMessageId) return null;
    const quoted = (messages ?? []).find((q: any) => q._id === m.quotedMessageId);
    return <QuotedSnippet quote={quoted ? quoteOf(quoted, agents as any) : null} onJump={jumpTo} />;
  };

  const nameRow = (role: string | undefined, at: number, tag?: string) => (
    <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
      {roleLabel(role)}
      {tag && <span className="rounded-md border border-line px-1.5 py-px text-[12px] font-normal text-ink-2">{tag}</span>}
      <span className="text-[13px] font-normal text-ink-3">{timeOf(at)}</span>
    </p>
  );

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
        <header className="flex min-h-[64px] items-center gap-2 border-b border-line px-5 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          {closeButton}
          <div className="min-w-0 flex-1">
            <h2 className="min-w-0 text-[16px] font-semibold leading-tight text-ink"><EditableTitle title={(task as any).title} renameRef={{ taskId: String((task as any)._id) }} label="task" /></h2>
            <p className="mt-0.5 truncate text-[13px] text-ink-3">
              Task thread · {(project as any)?.name ?? "Workspace"}
              {" · "}
              <span title="Permission mode">{PERMISSION_MODE_LABELS[normalizePermissionMode((task as any).permissionMode)]}</span>
              {" · "}
              <Link href={`/runs/${(task as any)._id}`} className="underline-offset-2 hover:text-ink hover:underline">
                View trace
              </Link>
            </p>
          </div>
          <span className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[13px] font-medium leading-none ${pill.cls}`}>{pill.label}</span>
          {/* Plan 022: Pause / Resume beside Stop. Only Stop confirms. */}
          {(taskStatus === "running" || taskStatus === "queued" || taskStatus === "paused") && (
            <div className="flex shrink-0 items-center">
              <PauseResumeButton task={{ _id: (task as any)._id, title: (task as any).title, status: taskStatus }} size={15} />
              <button
                type="button"
                onClick={askCancel}
                title="Stop task"
                aria-label="Stop task"
                className="rounded-md p-1.5 text-ink-3 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-400/50 dark:hover:bg-red-950/50"
              >
                <Square size={14} />
              </button>
            </div>
          )}
          {xButton}
        </header>
        <ThreadTabs view={threadView} onChange={setThreadView} />
        {threadView === "changes" && <ChangesPane taskId={(task as any)._id} />}
        <div className={`${threadView === "changes" ? "hidden" : ""} shell-scroll h-0 min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5`}>
          {(taskStatus === "failed" || taskStatus === "rejected" || taskStatus === "cancelled") && (
            <div
              className={
                taskStatus === "cancelled"
                  ? "rounded-xl border border-line bg-hover p-3.5 text-[14px] text-ink-2"
                  : "rounded-xl border border-red-200 bg-red-50 p-3.5 text-[14px] text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300"
              }
            >
              <p className="font-medium">
                {taskStatus === "rejected" ? "Task rejected" : taskStatus === "cancelled" ? "Task cancelled" : "Task failed"}
                {(task as any).errorMessage ? `: ${(task as any).errorMessage}` : ""}
              </p>
              <button
                type="button"
                disabled={retrying}
                onClick={() => void doRetry()}
                className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas hover:bg-ink/85 disabled:opacity-50"
              >
                <RotateCcw size={14} className={retrying ? "animate-spin" : ""} /> Retry task
              </button>
            </div>
          )}
          <TaskHoldNotice task={task as any} />
          {pendingApprovals.map((a: any) => (
            <ApprovalCard
              key={a._id}
              approval={a}
              taskTitle={(task as any).title}
              onApprove={(approvalId) => approve({ approvalId: approvalId as any })}
              onReject={(approvalId) => reject({ approvalId: approvalId as any })}
              onHold={(approvalId) => hold({ approvalId: approvalId as any })}
              onRespond={(approvalId, decision) => respondCommand({ approvalId: approvalId as any, decision })}
            />
          ))}
          <TaskQuestionCard task={task as any} busy={sendingReply} onAnswer={(answer) => void submitAnswer(answer)} onCancel={askCancel} />
          {subtasks.length > 0 && (
            <section aria-label="Subtasks">
              <div className="flex items-center gap-3 text-[13px] text-ink-3">
                <span>Subtasks {subtasks.filter((s) => s.status === "completed").length}/{subtasks.length}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              <ul className="mt-2.5 space-y-2">
                {subtasks.map((s: any) => {
                  const meta = subtaskStatusMeta(s.status);
                  const Icon = meta.icon;
                  const agent = agentById(s.assignedAgentId);
                  return (
                    <li key={s._id} className="text-[14px]">
                      <div className="flex items-center gap-2.5">
                        <Icon size={15} className={`shrink-0 ${meta.cls}${s.status === "running" ? " animate-spin" : ""}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {s.title}
                          {typeof s.reviewRound === "number" && s.reviewRound > 1 ? <span className="ml-1 text-ink-3">(round {s.reviewRound})</span> : null}
                        </span>
                        {agent && <span className="shrink-0 text-[13px] text-ink-3">{agentName(agent)}</span>}
                        <span className={`w-16 shrink-0 text-right text-[13px] ${meta.cls}`}>{meta.label}</span>
                      </div>
                      {taskId && (s.status === "completed" || s.status === "failed" || s.status === "blocked") && (
                        <div className="mt-0.5 pl-[25px]">
                          <SecondOpinionButton taskId={taskId} subtaskKey={s.key} />
                        </div>
                      )}
                      {s.status === "running" && s.activity && (
                        <SubtaskActivity activity={s.activity} at={s.activityAt} />
                      )}
                      {s.status === "running" && taskId && <SubtaskLiveOutput taskId={taskId} subtaskKey={s.key} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {taskId && subtasks.length > 0 && (
            <ReviewerSection
              taskId={taskId}
              subtaskTitles={Object.fromEntries(subtasks.map((s: any) => [s.key, s.title]))}
              heading={(aside) => (
                <div className="flex items-center gap-3 text-[13px] text-ink-3">
                  <span>Reviewer</span>
                  <span className="h-px flex-1 bg-line" />
                  {aside}
                </div>
              )}
            />
          )}
          {taskId && subtasks.length > 0 && <Requirements taskId={taskId} variant="thread" />}
          {ctoMessages.length === 0 && fileChanges && fileChanges.length > 0 && (
            <button type="button" onClick={() => setThreadView("changes")} className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
              {fileChanges.length} file{fileChanges.length > 1 ? "s" : ""} changed · Open changes
            </button>
          )}
          {ctoMessages.map((m: any, index: number) => {
            const msgAgent = agentById(m.agentId);
            const isLastCto = index === ctoMessages.length - 1;
            const block = blockOf(m);
            const isReview = block !== "decision" && !m.card;
            return (
              <div key={m._id} id={`thread-message-${m._id}`} className={rowClass(m)}>
                {replyButton(m)}
                <InitialAvatar agent avatarParams={msgAgent?.avatarParams} name={roleLabel(msgAgent?.role)} size={30} />
                <div className="min-w-0 flex-1">
                  {nameRow(msgAgent?.role ?? (block === "report" ? responseOwner : undefined), m._creationTime, m.card ? undefined : block ?? undefined)}
                  {m.content?.trim() ? <MessageText content={m.content} size="sm" /> : null}
                  {m.card && (
                    <div className="mt-2.5">
                      <ChatCard card={m.card} />
                    </div>
                  )}
                  {/* The latest review note carries the run's diff snippet; the full diff is one click away. */}
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
            <div className="flex items-center gap-3 text-[13px] text-ink-3">
              <span>
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </span>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          {threadReplies.map((m: any, index: number) => {
            const isUser = m.authorType === "user";
            const msgAgent = isUser ? null : agentById(m.agentId);
            const group = replyGroups.get(index);
            const open = group ? (groupOpen[group.id] ?? group.expandedByDefault) : true;
            const summaryRow =
              group && index === group.start ? (
                <ActivityGroupRow
                  key={`group-${group.id}`}
                  group={group}
                  open={open}
                  onToggle={() => setGroupOpen((prev) => ({ ...prev, [group.id]: !open }))}
                />
              ) : null;
            if (!open) return summaryRow;
            const systemText = systemLineText(m);
            const row = systemText !== null ? (
              <SystemLineRow key={m._id} id={`thread-message-${m._id}`} text={systemText} time={timeOf(m._creationTime)} />
            ) : (
              <div key={m._id} id={`thread-message-${m._id}`} className={rowClass(m)}>
                {replyButton(m)}
                <InitialAvatar agent={!isUser} avatarParams={isUser ? undefined : msgAgent?.avatarParams} name={isUser ? "You" : roleLabel(msgAgent?.role)} size={30} />
                <div className="min-w-0 flex-1">
                  {isUser ? (
                    <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                      You <span className="text-[13px] font-normal text-ink-3">{timeOf(m._creationTime)}</span>
                    </p>
                  ) : (
                    nameRow(msgAgent?.role, m._creationTime)
                  )}
                  {quoteFor(m)}
                  {m.content?.trim() ? <MessageText content={m.content} size="sm" maskSecrets={isUser} /> : null}
                  {m.card && (
                    <div className="mt-2.5">
                      <ChatCard card={m.card} />
                    </div>
                  )}
                </div>
              </div>
            );
            return summaryRow ? [summaryRow, row] : row;
          })}
          {checks.length > 0 && (
            <section>
              <div className="flex items-center gap-3 text-[13px] text-ink-3">
                <span>Checks</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              <ul className="mt-2.5 space-y-2">
                {Array.from(new Map(checks.map((event: any) => [event.payload?.label, event])).values()).map((event: any) => {
                  const passed = event.payload?.status === "passed" || event.payload?.status === "clean";
                  const failed = event.payload?.status === "failed";
                  return (
                    <li key={event._id} className="flex items-center gap-2.5 text-[14px]">
                      {passed ? (
                        <Check size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                      ) : failed ? (
                        <X size={15} className="shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
                      ) : (
                        <SendLoader size={15} className="shrink-0 animate-spin text-warn" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-ink">{event.payload?.label ?? "QA check"}</span>
                      <span className="shrink-0 text-[13px] text-ink-3">{passed ? "clean" : (event.payload?.status ?? "running")}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <form
          className={`${threadView === "changes" ? "hidden" : ""} shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="rounded-2xl border border-line-strong bg-panel transition focus-within:border-ink/30 focus-within:ring-4 focus-within:ring-ink/30">
            {quote && <QuoteBar quote={quote} onCancel={() => setQuote(null)} />}
            <textarea
              ref={replyRef}
              value={reply}
              onChange={(event) => {
                setReply(event.target.value);
                if (refusal) setRefusal(null);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Escape" && quote) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuote(null);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  const touch = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
                  if (touch) return;
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              aria-label={placeholder}
              placeholder={placeholder}
              className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-base leading-6 text-ink outline-none placeholder:text-ink-3 sm:text-[15px]"
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach a text file"
                title="Attach a text file"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <Paperclip size={16} />
              </button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void attachFile(file);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setReply((r) => `${r}${r && !/\s$/.test(r) ? " " : ""}@`);
                  requestAnimationFrame(() => replyRef.current?.focus());
                }}
                aria-label="Mention a teammate"
                title="Mention"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <AtSign size={16} />
              </button>
              <label className="ml-1 flex cursor-pointer select-none items-center gap-2 text-[13.5px] text-ink-2">
                <input
                  type="checkbox"
                  checked={alsoSendToChat}
                  onChange={(event) => setAlsoSendToChat(event.target.checked)}
                  className="h-4 w-4 rounded border-line-strong accent-ink"
                />
                Also send to chat
              </label>
              <button
                type="submit"
                disabled={busy || !reply.trim()}
                aria-label={taskStatus === "waiting_input" ? "Send answer" : taskStatus === "running" ? "Steer task" : "Send reply"}
                className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-canvas shadow-sm outline-none transition hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <SendLoader size={15} className="animate-spin" /> : <SendHorizontal size={16} />}
              </button>
            </div>
          </div>
          {refusal && (
            <p role="status" className="px-2 pt-1.5 text-[12.5px] text-ink-3">
              {refusal}
            </p>
          )}
        </form>
      </motion.aside>
    </div>
  );
}
