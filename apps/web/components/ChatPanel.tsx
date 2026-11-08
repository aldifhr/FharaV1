"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import InitialAvatar from "./InitialAvatar";
import ApprovalCard from "./ApprovalCard";
import QaPanel from "./QaPanel";
import { AnimatedTooltip } from "@/components/ui/animated-tooltip";
import { avatartionFor, deserializeAvatartion } from "./ui/avatartion";
import DiffCard from "./DiffCard";
import Modal from "./Modal";
import TaskBoard from "./TaskBoard";

import { useToast } from "./Toasts";
import { AtSign, Bell, Check, CheckCircle2, Clock, Copy, ExternalLink, FileText, GitBranch, Loader2, MoreHorizontal, Pencil, Pin, Send, ChevronUp, ChevronDown, Edit2, X, XCircle, Trash2, Paperclip, Mic, SquareTerminal, Type } from "lucide-react";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { roleLabel } from "@/lib/agentRoles";

type Props = {
  projectId: string;
  tab: "chat" | "tasks" | "files";
  setTab: (t: "chat" | "tasks" | "files") => void;
  onSelectTask: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  selectedTaskId: string | null;
};

// ponytail: auto-mode intent classification can be added via LLM when explicit modes feel too rigid

function MessageText({ content }: { content: string }) {
  // Make agent routing explicit in the transcript without changing the
  // persisted message text or mention semantics used by the worker.
  const highlighted = content.replace(/(^|\s)(@[A-Za-z][\w-]*)\b/g, "$1**$2**");
  return (
    <div className="mt-1 max-w-3xl space-y-2 text-[13px] leading-5 text-[#4c4a55] dark:text-gray-200">
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{highlighted}</ReactMarkdown>
      </div>
    </div>
  );
}

function ProposalCards({
  onSelectOption,
  disabled,
}: {
  onSelectOption: (option: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col justify-between rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-all hover:border-[#635bff] dark:border-gray-800 dark:bg-gray-900">
        <div>
          <div className="flex items-center justify-between">
            <span className="rounded-md bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700 dark:bg-purple-950 dark:text-purple-300">
              Option A
            </span>
            <span className="text-[11px] text-gray-400">Minimal Grid</span>
          </div>
          <h4 className="mt-2 text-sm font-semibold text-gray-900 dark:text-white">
            Clean 3-Column Grid
          </h4>
          <ul className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-300">
            <li className="flex items-start gap-1.5">
              <span className="font-bold text-emerald-500">✓</span>
              <span>3 equal columns, clean border</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="font-bold text-emerald-500">✓</span>
              <span>Annual toggle with 'Save 20%' badge</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="font-bold text-emerald-500">✓</span>
              <span>Clean typography, lowest risk</span>
            </li>
          </ul>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelectOption("Option A (Clean 3-Column Grid)")}
          className="mt-4 w-full rounded-lg bg-gray-100 py-2 text-xs font-semibold text-gray-800 transition-colors hover:bg-[#635bff] hover:text-white disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-[#635bff]"
        >
          Choose Option A
        </button>
      </div>

      <div className="flex flex-col justify-between rounded-xl border border-purple-200 bg-purple-50/20 p-4 shadow-sm transition-all hover:border-[#635bff] dark:border-purple-900/40 dark:bg-purple-950/10">
        <div>
          <div className="flex items-center justify-between">
            <span className="rounded-md bg-purple-600 px-2 py-0.5 text-xs font-semibold text-white">
              Option B
            </span>
            <span className="text-[11px] font-medium text-purple-600 dark:text-purple-400">Recommended</span>
          </div>
          <h4 className="mt-2 text-sm font-semibold text-gray-900 dark:text-white">
            Featured 'Pro' Tier
          </h4>
          <ul className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-300">
            <li className="flex items-start gap-1.5">
              <span className="font-bold text-purple-600">✓</span>
              <span>Elevated 'Pro' tier with subtle glow</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="font-bold text-purple-600">✓</span>
              <span>Accordion for feature matrix</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="font-bold text-purple-600">✓</span>
              <span>Higher conversion in past tests</span>
            </li>
          </ul>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelectOption("Option B (Featured 'Pro' Tier)")}
          className="mt-4 w-full rounded-lg bg-[#635bff] py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#5346d8] disabled:opacity-50"
        >
          Choose Option B
        </button>
      </div>
    </div>
  );
}

function TaskCard({
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
  const doneSubs = subtasks.filter((s) => s.status === "completed").length;
  const needsYou = task.status === "needs_approval" || pending.length > 0;
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

function FilesView({ project }: { project: any }) {
  const workspacePath = (project as any)?.workspacePath as string | undefined;
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    setFiles(null);
    setError("");
    setSelected(null);
    setContent(null);
    fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then((res) => res.json())
      .then((data) => {
        if ((data as any)?.error) setError((data as any).error);
        else setFiles((data as any)?.files ?? []);
      })
      .catch(() => setError("Failed to load workspace files"));
  }, [workspacePath]);

  const openFile = (filePath: string) => {
    if (!workspacePath) return;
    setSelected(filePath);
    setContent(null);
    fetch(
      `/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}&filePath=${encodeURIComponent(filePath)}`
    )
      .then((res) => res.json())
      .then((data) => setContent((data as any)?.content ?? ""))
      .catch(() => setContent("Failed to load file"));
  };

  const visible = (files ?? []).filter(
    (file) => !query || file.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="flex min-h-0 flex-1 gap-4 p-5">
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          className="rounded-xl border border-[#e5e3eb] bg-white px-3 py-2 text-sm outline-none focus:border-[#a29ae8] dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[#e5e3eb] bg-white p-1 dark:border-gray-800 dark:bg-gray-900">
          {error && <p className="px-2 py-2 text-xs text-rose-600">{error}</p>}
          {!error && !files && <p className="px-2 py-2 text-xs text-gray-400">Loading files…</p>}
          {files && visible.length === 0 && (
            <p className="px-2 py-2 text-xs text-gray-400">No files found.</p>
          )}
          {visible.map((file) => (
            <button
              key={file}
              type="button"
              onClick={() => openFile(file)}
              className={`flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-gray-100 dark:hover:bg-gray-800 ${
                selected === file ? "bg-gray-100 font-semibold dark:bg-gray-800" : ""
              }`}
            >
              <FileText size={13} className="shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1 truncate">{file}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-[#e5e3eb] bg-white dark:border-gray-800 dark:bg-gray-900">
        {selected ? (
          <>
            <p className="border-b border-[#e5e3eb] px-4 py-2.5 font-mono text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              {selected}
            </p>
            <pre className="h-[calc(100%-37px)] overflow-auto p-4 font-mono text-xs leading-5 dark:text-gray-200">
              {content ?? "Loading…"}
            </pre>
          </>
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-gray-400">
            Select a file to preview it.
          </p>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({ projectId, tab, setTab, onSelectTask, onOpenAgent, selectedTaskId }: Props) {
  const project = useQuery(api.projects.get, { projectId: projectId as any });
  const messages = useQuery(api.messages.listByProject, { projectId: projectId as any });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  const approvals = useQuery(api.approvals.listPendingAll, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const hold = useMutation(api.approvals.hold);
  const projectEvents = useQuery(api.taskEvents.listByProject, { projectId: projectId as any });
  const allAgents = useQuery(api.agents.list, {});
  const activeConversation = useQuery(api.conversations.getActive, {
    projectId: projectId as any,
  });
  const updateProject = useMutation(api.projects.update);
  const updateTeam = useMutation(api.projects.updateTeam);
  const updateApprovalMode = useMutation(api.projects.updateApprovalMode);
  const clearChat = useMutation(api.conversations.clearChat);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [clearConfirm, setClearConfirm] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const projectAgentIds = project?.agentIds;
  const agents = (projectAgentIds
    ? (allAgents ?? []).filter((agent: any) => (projectAgentIds as readonly string[]).includes(agent._id))
    : (allAgents ?? [])) as any[];
  const pendingForProject = (approvals ?? []).filter((a: any) => a.projectId === projectId).length;
  const pendingItems = (approvals ?? []).filter((a: any) => a.projectId === projectId);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [notifOpen]);

  const copyProjectLink = async () => {
    const url = `${window.location.origin}/chats/${projectId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
    setMoreOpen(false);
  };

  const confirmClearChat = async () => {
    setClearPending(true);
    setMoreOpen(false);
    try {
      await clearChat({ projectId: projectId as never });
      setDraft("");
      setMessageQueue([]);
      setMention(null);
      toast("success", "Chat cleared");
      setClearConfirm(null);
    } catch (err) {
      toast("error", "Failed to clear chat", err instanceof Error ? err.message : "Failed to clear chat");
    } finally {
      setClearPending(false);
    }
  };

  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId);
  const fileChangesByTask = useQuery(api.fileChanges.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const projectFiles = useQuery(api.fileChanges.listByProject, { projectId: projectId as any });
  const subtasksByTask = useQuery(api.workspace.listSubtasksByProject, { projectId: projectId as any });
  const subtasksOf = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const row of subtasksByTask ?? []) map.set(row.taskId, row.subtasks);
    return map;
  }, [subtasksByTask]);
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const selectedTaskMessages = selectedTask
    ? (messages ?? []).filter((message: any) => message.taskId === selectedTask._id)
    : [];
  // One chronological timeline: every project message, with task agent
  // reports inline. Task user copies (same content as the conversation
  // message) are skipped to avoid duplicates.
  const timeline = (messages ?? [])
    .filter((message: any) => !message.taskId || message.authorType === "agent")
    .sort((a: any, b: any) => a._creationTime - b._creationTime);
  const lastMessage = timeline[timeline.length - 1];

  // "• New" divider: marks the first message newer than the newest one
  // the user has seen (persisted per project). It used to be rendered
  // unconditionally at the top of the timeline, so an hour-old thread
  // still read "New" at the top. It now sits at the boundary between seen
  // and unseen messages and advances as the user reads to the bottom.
  const lastSeenKey = `moagent-chat-lastseen-${projectId}`;
  const [lastSeenAt, setLastSeenAt] = useState(0);
  useEffect(() => {
    try {
      setLastSeenAt(Number(localStorage.getItem(lastSeenKey)) || 0);
    } catch {
      setLastSeenAt(0);
    }
  }, [lastSeenKey]);
  const markSeen = () => {
    const seen = lastMessage?._creationTime ?? 0;
    if (!seen) return;
    setLastSeenAt((prev) => {
      const next = Math.max(prev, seen);
      if (next !== prev) {
        try {
          localStorage.setItem(lastSeenKey, String(next));
        } catch {
          /* private-window storage denied — keep it in memory */
        }
      }
      return next;
    });
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight <= 120) {
      markSeen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, lastSeenKey]);
  const firstNewIndex = timeline.findIndex(
    (m: any) => m._creationTime > lastSeenAt
  );
  const wasAgentTypingRef = useRef(false);

  const conversationTyping = lastMessage?.authorType === "user";

  // Auto-dispatch queue after agent finishes responding
  useEffect(() => {
    if (wasAgentTypingRef.current && !conversationTyping) {
      // Agent just finished responding — dispatch queued messages after a short delay
      const queued = messageQueue.some((m) => m.status === "queued");
      if (queued && selectedTaskId) {
        const timer = setTimeout(() => void sendAllQueued(), 300);
        return () => clearTimeout(timer);
      }
    }
    wasAgentTypingRef.current = conversationTyping;
  }, [conversationTyping]);
  const latestAgentMessage = [...selectedTaskMessages].reverse().find((message: any) => message.authorType === "agent");
  const taskTitle = (taskId: string) => (tasks ?? []).find((task) => task._id === taskId)?.title ?? "task";
  // A task block starts at the user message that spawned it. The plan message
  // replies to that user message, so the link is recoverable from
  // replyToMessageId. Older plan messages predate taskId tagging, so the task
  // id is parsed from their content as a fallback.
  const taskFromPlan = (content: string) => content.match(/^Plan dibuat\. Task (\S+)/)?.[1];
  const replyToTask = new Map<string, string>();
  for (const m of messages ?? []) {
    const taskId = m.taskId ?? taskFromPlan(m.content ?? "");
    if (m.replyToMessageId && taskId) replyToTask.set(m.replyToMessageId, taskId);
  }
  // ponytail: evaluation and planning messages are summaries, not execution
  // output. Detect by content prefix so the UI can show a badge.
  // Delegation messages are written by the worker as
  // "Delegation: From → To (capability): reason" (taskRunner.ts).
  const messageKind = (content: string): "evaluation" | "planning" | "delegation" | "design" | null =>
    /^Task (completed|finished)/.test(content) ? "evaluation" :
    /^Plan dibuat/.test(content) ? "planning" :
    /^Delegation:/.test(content) ? "delegation" :
    /^Design proposal:/.test(content) ? "design" : null;
  const delegationParts = (content: string) => {
    const match = content.match(/^Delegation:\s*(.+?)\s*→\s*(.+?)\s*\((.+?)\)(?::\s*(.*))?$/s);
    return match ? { from: match[1], to: match[2], capability: match[3], reason: match[4] ?? "" } : null;
  };
  const blockKey = (m: any) => m.taskId ?? replyToTask.get(m._id) ?? taskFromPlan(m.content ?? "") ?? "conversation";

  const [manageName, setManageName] = useState("");
  const [managePath, setManagePath] = useState("");
  const [manageApprovalMode, setManageApprovalMode] = useState<"ask" | "auto">("ask");
  const [manageAgentIds, setManageAgentIds] = useState<string[]>([]);
  const [manageError, setManageError] = useState("");
  const [savingManage, setSavingManage] = useState(false);

  function openManageProject() {
    if (!project) return;
    setMoreOpen(false);
    setManageError("");
    setManageName((project as any).name ?? "");
    setManagePath((project as any).workspacePath ?? "");
    setManageApprovalMode((project as any).approvalMode ?? "ask");
    setManageAgentIds(((project as any).agentIds ?? []) as string[]);
    setIsManageOpen(true);
  }

  async function handleSaveProject(event: React.FormEvent) {
    event.preventDefault();
    if (!project) return;
    if (!manageName.trim()) {
      setManageError("Name is required");
      return;
    }
    setManageError("");
    setSavingManage(true);
    try {
      await updateProject({
        projectId: projectId as never,
        name: manageName,
        workspacePath: managePath,
        approvalMode: manageApprovalMode,
      });
      await updateTeam({ projectId: projectId as never, agentIds: manageAgentIds as never[] });
      setIsManageOpen(false);
      toast("success", "Project updated");
    } catch (err) {
      setManageError(err instanceof Error ? err.message : "Failed to update project");
    } finally {
      setSavingManage(false);
    }
  }

  const toast = useToast();

  const sendMessage = useAction(api.messages.send);
  const [draft, setDraft] = useState("");
  const [messageQueue, setMessageQueue] = useState<
    Array<{ id: string; content: string; status: "queued" | "sending" | "sent" | "failed" }>
  >([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [chatAgentIds, setChatAgentIds] = useState<string[]>([]);

  // Plan 007: participation is persisted server-side; mirror it into the chip
  // selection so it survives reload. Re-runs only when the server state
  // changes (e.g. after a send syncs the selection), so local toggles between
  // sends are not fought.
  useEffect(() => {
    if (!activeConversation) return;
    setChatAgentIds(activeConversation.participants.map((p: any) => p.agentId));
  }, [activeConversation]);
  const [chatError, setChatError] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [mention, setMention] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);

  useEffect(() => {
    const workspacePath = (project as any)?.workspacePath;
    if (!workspacePath) {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to list project files");
        return (await response.json()) as { files?: string[] };
      })
      .then((data) => {
        if (!cancelled) setWorkspaceFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [(project as any)?.workspacePath]);

  const mentionResults = useMemo(() => {
    if (mention === null) return [];
    const q = mention.toLowerCase();
    const changedFiles = (projectFiles ?? []).map((f: any) => f.filePath as string);
    return [...new Set([...workspaceFiles, ...changedFiles])]
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 30);
  }, [mention, projectFiles, workspaceFiles]);

  const attachMentionedFiles = async (text: string) => {
    const paths = [...new Set(
      [...text.matchAll(/@([\w./-]+\.[\w]{1,12})/g)].map((match) => match[1]),
    )];
    if (paths.length === 0 || !(project as any)?.workspacePath) return text;
    const contents = await Promise.all(paths.map(async (filePath) => {
      const params = new URLSearchParams({
        workspacePath: (project as any).workspacePath,
        filePath,
      });
      const response = await fetch(`/api/project-files?${params}`);
      if (!response.ok) return "";
      const data = (await response.json()) as { content?: string };
      return data.content ? `\n\n--- File: ${filePath} ---\n${data.content}` : "";
    }));
    return `${text}${contents.join("")}`.slice(0, 8000);
  };

  const insertMention = (path: string) => {
    const at = draft.lastIndexOf("@");
    const before = draft.slice(0, at);
    setDraft(`${before}@${path} `);
    setMention(null);
  };

  // Message queue helpers
  const addToQueue = async () => {
    const text = draft.trim();
    if (!text) return;
    const content = await attachMentionedFiles(text);
    setMessageQueue((q) => [...q, { id: crypto.randomUUID(), content, status: "queued" }]);
    setDraft("");
    setMention(null);
  };

  const handleChooseProposal = async (choice: string) => {
    setChatSending(true);
    try {
      await sendMessage({
        projectId: projectId as any,
        content: `I approve ${choice}. Please proceed with the technical breakdown and implementation.`,
        preferredAgentIds: chatAgentIds.length ? (chatAgentIds as any) : undefined,
      });
    } catch (err) {
      toast("error", "Failed to select option", err instanceof Error ? err.message : "Error");
    } finally {
      setChatSending(false);
    }
  };

  // Send immediately — clears draft and sends right away, bypassing the queue
  const sendImmediately = async () => {
    const text = draft.trim();
    if (!text) return;
    setChatError("");
    setChatSending(true);
    try {
      const content = await attachMentionedFiles(text);
      await sendMessage({
        projectId: projectId as any,
        content,
        preferredAgentIds: chatAgentIds.length ? (chatAgentIds as any) : undefined,
      });
      setDraft("");
      setMention(null);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setChatSending(false);
    }
  };

  const removeFromQueue = (id: string) => {
    setMessageQueue((q) => q.filter((m) => m.id !== id));
  };

  const moveInQueue = (id: string, direction: -1 | 1) => {
    setMessageQueue((q) => {
      const idx = q.findIndex((m) => m.id === id);
      if (idx < 0) return q;
      const next = idx + direction;
      if (next < 0 || next >= q.length) return q;
      const nextq = [...q];
      [nextq[idx], nextq[next]] = [nextq[next], nextq[idx]];
      return nextq;
    });
  };

  const updateQueueItem = (id: string, content: string) => {
    setMessageQueue((q) => q.map((m) => (m.id === id ? { ...m, content } : m)));
  };

  const sendAllQueued = async () => {
    const items = messageQueue.filter((m) => m.status === "queued");
    if (items.length === 0) return;
    setChatError("");
    setChatSending(true);
    for (const item of items) {
      setMessageQueue((q) => q.map((m) => (m.id === item.id ? { ...m, status: "sending" } : m)));
      try {
        await sendMessage({
          projectId: projectId as any,
          content: item.content,
          preferredAgentIds: chatAgentIds.length ? (chatAgentIds as any) : undefined,
        });
        setMessageQueue((q) => q.map((m) => (m.id === item.id ? { ...m, status: "sent" } : m)));
      } catch (err) {
        setMessageQueue((q) => q.map((m) => (m.id === item.id ? { ...m, status: "failed" } : m)));
        setChatError(err instanceof Error ? err.message : "Failed to send");
        break;
      }
    }
    setChatSending(false);
    // Clear sent items after a short delay so the user sees the success state
    setTimeout(() => {
      setMessageQueue((q) => q.filter((m) => m.status !== "sent"));
    }, 2000);
  };

  const handleDraftInput = (value: string) => {
    setDraft(value);
    const at = value.lastIndexOf("@");
    const afterSpace = at >= 0 && (at === 0 || /\s/.test(value[at - 1]));
    const token = afterSpace ? value.slice(at + 1) : null;
    setMention(token !== null && !/\s/.test(token) ? token : null);
  };

  const headerAgents = agents.slice(0, 6);
  const activeForSelectedTask = useMemo(() => {
    if (!selectedTask) return [];
    return (agents as any[]).filter((a: any) => {
      const active = (activeByAgent as any)?.[a._id];
      return active && active.taskId === selectedTask._id;
    }).map((a: any) => ({
      agent: a,
      stage: (activeByAgent as any)[a._id]?.status ?? "running",
      subtaskKey: (activeByAgent as any)[a._id]?.subtaskKey,
    }));
  }, [agents, activeByAgent, selectedTask]);
  // Status comes from the backend execution lease, not the persisted
  // `agents.status` (which keeps idle agents flagged as "working").
  const workingAgents = (agents as any[]).filter((agent: any) => (activeByAgent as any)?.[agent._id as string] !== undefined);
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
    <main className="relative flex min-w-0 flex-1 flex-col bg-transparent">
      <header className="border-b border-[#ebe9f0] bg-white/30 dark:border-gray-800 dark:bg-gray-950/20">
      <div className="flex min-h-[56px] items-center gap-3 px-5 py-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-emerald-200 text-sm font-bold text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100">
          {(project as any)?.name?.slice(0, 1).toUpperCase() ?? "A"}
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
                    aria-label={roleLabel(a.role)}
                    className={`-ml-1.5 rounded-full p-0 first:ml-0 ${
                      activeAgentId && activeAgentId !== a._id
                        ? "opacity-40"
                        : "opacity-100 transition hover:opacity-70"
                    }`}
                    onMouseEnter={() => setActiveAgentId(a._id)}
                  >
                    <AgentAvatar name={roleLabel(a.role)} size={20} status={a.status === "working" ? "working" : a.status === "queued" ? "queued" : a.status === "needs_you" ? "needs_you" : "idle"} avatarParams={a.avatarParams} />
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
                            name: roleLabel(a.role),
                            designation: `${roleLabel(a.role)} · ${a.status}`,
                            avatar: (a.avatarParams ? deserializeAvatartion(a.avatarParams) : null) ?? avatartionFor(roleLabel(a.role)),
                            size: 20,
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
      </div>
      {/* Tab bar row: workspace tabs (left) + version/pin/bell/more (right) */}
      <div className="flex items-center gap-3 border-t border-[#f0eef4] px-5 py-2 dark:border-gray-800/60">
        <div className="flex shrink-0 items-center rounded-xl bg-gray-100 p-1 dark:bg-gray-800" role="tablist" aria-label="Workspace view">
          {(["chat", "tasks", "files"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-[13px] capitalize transition ${tab === t ? "bg-white font-semibold text-[#24232d] shadow-sm dark:bg-gray-900 dark:text-white" : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"}`}
            >
              {t}{t === "tasks" && tasks?.length ? ` ${tasks.length}` : ""}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            title="Plan version of the selected task"
            className="flex items-center gap-1 rounded-lg border border-[#e5e3eb] px-2 py-1 font-mono text-[11px] font-semibold text-gray-500 dark:border-gray-700 dark:text-gray-400"
          >
            <GitBranch size={12} />
            v{((selectedTask as any)?.planVersion ?? (tasks ?? [])[0]?.planVersion ?? 1)}
          </span>
          <button
            type="button"
            onClick={() => setNotifOpen((open) => !open)}
            title={`${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"} — open notifications`}
            aria-label={`${pendingForProject} pending approvals`}
            className="flex items-center gap-1 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Pin size={13} />
            <span className="text-[11px] font-semibold tabular-nums">{pendingForProject > 9 ? "9+" : pendingForProject}</span>
          </button>
        <div className="flex items-center gap-1">
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setNotifOpen((open) => !open)}
              title={`Notifications — ${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"}`}
              aria-label={`Notifications — ${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"}`}
              aria-expanded={notifOpen}
              className="relative rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Bell size={15} />
              {pendingForProject > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                  {pendingForProject > 9 ? "9+" : pendingForProject}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Notifications ({pendingForProject})
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {pendingItems.length === 0 && (
                    <p className="px-3 py-3 text-sm text-gray-400">Nothing is waiting for approval.</p>
                  )}
                  {pendingItems.map((a: any) => (
                    <div key={a._id} className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                      <p className="truncate text-sm font-medium">{a.summary}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{a.kind}</p>
                      <div className="mt-1.5 flex gap-2">
                        <button
                          type="button"
                          onClick={() => approve({ approvalId: a._id })}
                          className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => reject({ approvalId: a._id })}
                          className="rounded-lg bg-gray-200 px-2 py-1 text-xs font-semibold dark:bg-gray-700 dark:text-white"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              title="More actions"
              aria-label="More actions"
              aria-expanded={moreOpen}
              className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <MoreHorizontal size={17} />
            </button>
            {moreOpen && (
              <div className="absolute right-0 z-40 mt-2 w-48 overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                <button
                  type="button"
                  onClick={copyProjectLink}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
                  {copied ? "Link copied" : "Copy project link"}
                </button>
                <button
                  type="button"
                  onClick={openManageProject}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <Pencil size={15} />
                  Manage project
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setClearConfirm({
                      title: "Clear this chat?",
                      message: "Every chat message in this project will be deleted, including task reports. Tasks themselves are kept.",
                      confirmLabel: "Clear chat",
                      onOk: () => { void confirmClearChat(); },
                    })
                  }
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
                >
                  <Trash2 size={15} />
                  Clear chat
                </button>
              </div>
            )}
          </div>
        </div>
        </div>
        </div>
      </header>

      <div ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (!el) return; const dist = el.scrollHeight - el.scrollTop - el.clientHeight; setShowScrollDown(dist > 120); if (dist <= 120) markSeen(); }} className="flex-1 space-y-5 overflow-y-auto bg-transparent px-5 py-6">
        {taskErrors.map((event: any, index: number) => (
          <div key={`task-error-${index}`} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="font-semibold">Agent error:</span> {event.payload?.message ?? "Task failed to process."}
          </div>
        ))}
        {tab === "chat" ? (
          <>
            {timeline.map((m: any, index: number) => {
              const previous = timeline[index - 1];
              const key = blockKey(m);
              const prevKey = previous ? blockKey(previous) : null;
              // Divider marks the start of a task block (at the user's message
              // that spawned it), not a transition back to plain conversation.
              const boundary = key !== prevKey && key !== "conversation";
               const showTaskCard = key !== "conversation" && m.authorType === "agent" && previous?.authorType === "user";
              return (
                <div key={m._id}>
                  {index === firstNewIndex && (
                    <div className="flex items-center gap-3 text-[11px] font-medium text-[#635bff]">
                      <span className="h-px flex-1 bg-[#e5e3eb] dark:bg-gray-700" />
                      <span className="h-1.5 w-1.5 rounded-full bg-[#635bff]" />
                      New
                    </div>
                  )}
                  {boundary && (
                    <p className="my-5 text-center text-[11px] text-gray-400">
                      — {taskTitle(key)} —
                    </p>
                  )}
                  {showTaskCard && (() => {
                    const cardTask = (tasks ?? []).find((t) => t._id === key);
                    if (!cardTask) return null;
                    const pending = pendingItems.filter((a: any) => a.taskId === key && a.status === "pending");
                    const qaEvents = (projectEvents ?? []).filter((e: any) => e.taskId === key && e.type === "task.check");
                    return (
                      <div className="space-y-2">
                        <TaskCard
                          task={cardTask}
                          subtasks={subtasksOf.get(key) ?? []}
                          pending={pending}
                          onApprove={(approvalId) => approve({ approvalId: approvalId as any })}
                          onOpen={onSelectTask}
                          agents={agents}
                          approvalMode={(project as any)?.approvalMode ?? "ask"}
                        />
                        {pending.map((a: any) => (
                          <ApprovalCard
                            key={a._id}
                            approval={a}
                            taskTitle={cardTask.title}
                            onApprove={(approvalId) => approve({ approvalId: approvalId as any })}
                            onReject={(approvalId) => reject({ approvalId: approvalId as any })}
                            onHold={(approvalId) => hold({ approvalId: approvalId as any })}
                            onReview={(taskId) => onSelectTask(taskId)}
                          />
                        ))}
                        {qaEvents.length > 0 && <QaPanel events={qaEvents} compact />}
                      </div>
                    );
                  })()}
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.18) }}
                    className="mt-3 flex gap-3"
                  >
                    {m.authorType === "agent" ? (
                      <InitialAvatar
                        name={roleLabel((agents as any)?.find((a: any) => a._id === m.agentId)?.role)}
                        size={32}
                      />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eceaf3] text-[11px] font-bold text-[#5147b4] dark:bg-white/15 dark:text-white">
                        You
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-[#34323d] dark:text-gray-100">
                          {m.authorType === "agent"
                            ? roleLabel((agents as any)?.find((a: any) => a._id === m.agentId)?.role)
                            : "You"}
                          {(() => {
                            const kind = messageKind(m.content);
                            if (kind === "evaluation") return (
                              <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                                <svg className="animate-[spin_2.5s_linear_infinite]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="10" />
                                  <path d="m16 9-5.5 5.5L8 12" />
                                </svg>
                                evaluated
                              </span>
                            );
                            if (kind === "planning") return <span className=" rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 dark:bg-purple-900 dark:text-purple-300">planned</span>;
                            if (kind === "delegation") return <span className=" rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">delegated</span>;
                            if (kind === "design") return <span className=" rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-semibold text-pink-700 dark:bg-pink-950 dark:text-pink-300">design proposal</span>;
                            return null;
                          })()}
                        </p>
                        <span className="text-[11px] text-gray-400">{formatMessageTime(m._creationTime)}</span>
                      </div>
                      {messageKind(m.content) === "delegation" ? null : <MessageText content={m.content} />}
                      {(() => {
                        const hasProposal =
                          m.authorType === "agent" &&
                          /Option A/i.test(m.content) &&
                          /Option B/i.test(m.content);
                        if (!hasProposal) return null;
                        return (
                          <ProposalCards
                            disabled={chatSending}
                            onSelectOption={(choice) => void handleChooseProposal(choice)}
                          />
                        );
                      })()}
                      {(() => {
                        const kind = messageKind(m.content);
                        if (kind !== "delegation") return null;
                        const parts = delegationParts(m.content);
                        if (!parts) return null;
                        return (
                          <div className="mt-2 flex max-w-3xl flex-wrap items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs dark:border-indigo-950 dark:bg-indigo-950/20">
                            <span className="font-semibold dark:text-white">{parts.from}</span>
                            <span aria-hidden="true" className="text-indigo-400">→</span>
                            <span className="font-semibold dark:text-white">{parts.to}</span>
                            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-100 dark:bg-gray-900 dark:text-indigo-300 dark:ring-gray-800">{parts.capability}</span>
                            {parts.reason && <span className="w-full text-gray-500 dark:text-gray-400">{parts.reason}</span>}
                          </div>
                        );
                      })()}
                      {m.taskId && fileChangesByTask?.length && m._id === latestAgentMessage?._id ? (
                        <div className="mt-2">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600">
                            Changed {(fileChangesByTask as any).length} files
                            <span className="text-emerald-600">+{diffStats.added}</span>
                            <span className="text-rose-500">−{diffStats.removed}</span>
                          </p>
                          {(fileChangesByTask as any).map((fc: any) => {
                            const pendingApproval = pendingItems.find(
                              (a: any) => a.taskId === m.taskId && a.status === "pending" && (a.payload?.filePaths ?? []).includes(fc.filePath),
                            );
                            return (
                              <DiffCard
                                key={fc._id}
                                filePath={fc.filePath}
                                diff={fc.diff}
                                changeType={fc.changeType}
                                oldContent={fc.oldContent}
                                newContent={fc.newContent}
                                applied={Boolean(fc.appliedAt)}
                                approvalId={pendingApproval?._id as string}
                                busy={false}
                                onApprove={(id) => approve({ approvalId: id as any })}
                                onReject={(id) => reject({ approvalId: id as any })}
                              />
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </motion.div>
                </div>
              );
            })}
            {conversationTyping && (
              <div className="flex items-center gap-2.5 rounded-full border border-[#ebe9f4] bg-white/80 px-3 py-1.5 text-xs font-medium text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-300">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#eeecfb] text-[10px] text-[#635bff] dark:bg-indigo-950 dark:text-indigo-300" aria-hidden="true">✦</span>
                <span>Team is thinking</span>
                <span className="flex gap-1" aria-label="Agent is typing">
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8] [animation-delay:120ms]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8] [animation-delay:240ms]" />
                </span>
              </div>
            )}
            {!timeline.length && <p className="text-sm text-gray-400">No messages yet.</p>}
            {activeForSelectedTask.length > 0 ? (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Working now
                </div>
                <div className="mt-1.5 space-y-1">
                  {activeForSelectedTask.map(({ agent, stage, subtaskKey }: any) => (
                    <div key={agent._id} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <AgentAvatar name={roleLabel(agent.role)} size={18} status="working" avatarParams={agent.avatarParams} />
                      <span className="font-medium">{roleLabel(agent.role)}</span>
                      <span className="text-gray-400">
                        {stage === "waiting_approval" ? "waiting approval" : stage === "queued" ? "queued" : "thinking"}
                        {subtaskKey ? ` · ${subtaskKey}` : ""}
                      </span>
                      <span className="flex gap-0.5" aria-label="Agent is typing">
                        <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                        <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                        <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              workingAgents.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <div className="flex space-x-1">
                    {workingAgents.slice(0, 3).map((agent: any) => (
                      <AgentAvatar
                        key={agent._id}
                        name={roleLabel(agent.role)}
                        size={20}
                        avatarParams={agent.avatarParams}
                      />
                    ))}
                  </div>
                  <span>{workingAgents.map((agent: any) => roleLabel(agent.role)).join(", ")} is thinking</span>
                  <span className="flex gap-0.5" aria-label="Agent is thinking">
                    <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                    <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                    <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
                  </span>
                </div>
              )
            )}
          </>
        ) : (
          <motion.div key="tasks" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
            {tab === "files" ? (
              <FilesView project={project} />
            ) : (
              <TaskBoard projectId={projectId} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
            )}
          </motion.div>
        )}
      </div>

      {showScrollDown && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
          aria-label="Scroll to bottom"
          className="absolute bottom-24 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full bg-white shadow-lg ring-1 ring-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:ring-gray-700"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      )}


      <ConfirmDialog request={clearConfirm} pending={clearPending} onCancel={() => setClearConfirm(null)} onConfirm={() => clearConfirm?.onOk()} />

      {isManageOpen && (
        <Modal title={`Manage project · ${manageName}`} onClose={() => setIsManageOpen(false)} maxWidth="max-w-lg">
          <form onSubmit={handleSaveProject} className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm">
              Project name
              <input
                value={manageName}
                onChange={(event) => setManageName(event.target.value)}
                required
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Folder path
              <input
                value={managePath}
                onChange={(event) => setManagePath(event.target.value)}
                required
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Approval mode
              <select
                value={manageApprovalMode}
                onChange={(event) => setManageApprovalMode(event.target.value as "ask" | "auto")}
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              >
                <option value="ask">Ask before changes</option>
                <option value="auto">Auto-approve</option>
              </select>
            </label>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Team project</legend>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                {(allAgents ?? []).length === 0 && <p className="text-xs text-gray-400">Belum ada agent. Buat agent dulu dari halaman Teams.</p>}
                {(allAgents ?? []).map((agent: any) => (
                  <label key={agent._id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={manageAgentIds.includes(agent._id)}
                      onChange={(event) =>
                        setManageAgentIds((current) =>
                          event.target.checked
                            ? [...current, agent._id]
                            : current.filter((id) => id !== agent._id)
                        )
                      }
                    />
                    <span>{roleLabel(agent.role)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {manageError && <p className="text-sm text-red-600">{manageError}</p>}
            <button
              type="submit"
              disabled={savingManage}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
            >
              {savingManage ? "Saving…" : "Save project"}
            </button>
          </form>
        </Modal>
      )}
      {tab === "chat" && (
        <div className="border-t border-[#ebe9f0] bg-white/80 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/80">
          <div className="relative flex flex-col gap-2">
            {mention !== null && mentionResults.length > 0 && (
              <ul className="absolute bottom-full left-0 z-30 mb-2 max-h-52 w-full overflow-y-auto rounded-xl border border-[#e5e3eb] bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-900">
                {mentionResults.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      onClick={() => insertMention(path)}
                      className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      @{path}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {messageQueue.length > 0 && (
              <div className="space-y-1.5">
                {messageQueue.map((item, idx) => (
                  <div
                    key={item.id}
                    className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                      item.status === "sending"
                        ? "border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/50"
                        : item.status === "sent"
                        ? "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/50"
                        : item.status === "failed"
                        ? "border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/50"
                        : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                    }`}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-gray-400">{idx + 1}.</span>
                    {editingId === item.id ? (
                      <input
                        autoFocus
                        value={item.content}
                        onChange={(e) => updateQueueItem(item.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); setEditingId(null); }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-xs dark:border-indigo-700 dark:bg-gray-800"
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                        {item.content}
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
                        item.status === "queued"
                          ? "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                          : item.status === "sending"
                          ? "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300"
                          : item.status === "sent"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                          : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                      }`}
                    >
                      {item.status}
                    </span>
                    {item.status === "queued" && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => moveInQueue(item.id, -1)}
                          disabled={idx === 0}
                          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-20 dark:hover:bg-gray-800"
                        >
                          <ChevronUp size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveInQueue(item.id, 1)}
                          disabled={idx === messageQueue.length - 1}
                          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-20 dark:hover:bg-gray-800"
                        >
                          <ChevronDown size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(item.id)}
                          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromQueue(item.id)}
                          className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-2xl border border-[#e5e3eb] bg-white px-4 pb-3 pt-3.5 shadow-sm transition focus-within:border-[#a29ae8] focus-within:ring-2 focus-within:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-800 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-900">
              <textarea
                value={draft}
                onChange={(e) => handleDraftInput(e.target.value)}
                onKeyDown={(e) => {
                  if (mention !== null && mentionResults.length > 0 && e.key === "Enter") {
                    e.preventDefault();
                    insertMention(mentionResults[0]);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendImmediately();
                  }
                  if (e.key === "Enter" && e.shiftKey) {
                    e.preventDefault();
                    void addToQueue();
                  }
                }}
                rows={1}
                placeholder={`Message ${((project as any)?.name ?? "the team")}, or type / for a command`}
                className="w-full resize-none bg-transparent px-0.5 text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400 dark:text-white dark:placeholder:text-gray-400"
                style={{ minHeight: "24px", maxHeight: "120px" }}
              />
              <div className="mt-2 flex items-center gap-1.5">
                 <button type="button" title="Formatting" aria-label="Formatting" className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"><Type size={16} /></button>
                 <button type="button" title="Attach a file" aria-label="Attach a file" className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"><Paperclip size={16} /></button>
                <button
                  type="button"
                  onClick={() => handleDraftInput(`${draft}@`)}
                  title="Reference a file"
                  aria-label="Reference a file"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                >
                  <AtSign size={15} />
                </button>
                <button type="button" title="Voice input" aria-label="Voice input" className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"><Mic size={16} /></button>
                <select value="" onChange={(event) => { if (event.target.value) setChatAgentIds((ids) => ids.includes(event.target.value) ? ids : [...ids, event.target.value]); }} aria-label="Select agents to route to" className="h-7 max-w-28 rounded-full border border-[#e5e3eb] bg-white px-2 text-xs text-gray-500 outline-none focus:border-[#a29ae8] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"><option value="">Route to…</option>{agents.filter((a: any) => !chatAgentIds.includes(a._id)).map((a: any) => <option key={a._id} value={a._id}>{roleLabel(a.role)}</option>)}</select>
                 {(() => { const cto = agents.find((a: any) => /^(cto|orchestrator|planner|architect)$/i.test(a.role ?? "")); return cto && !chatAgentIds.includes(cto._id) ? <button type="button" onClick={() => setChatAgentIds((ids) => ids.includes(cto._id) ? ids : [...ids, cto._id])} className="h-7 rounded-full border border-[#e5e3eb] px-2.5 text-xs font-semibold text-gray-600 hover:border-[#a29ae8] hover:text-[#5147b4] dark:border-gray-700 dark:text-gray-300" aria-label="Delegate to CTO">Delegate to CTO</button> : null; })()}
                 {agents
                  .filter((a: any) => chatAgentIds.includes(a._id))
                  .map((a: any) => (
                    <button
                      key={a._id}
                      type="button"
                      onClick={() => setChatAgentIds((ids) => ids.filter((id) => id !== a._id))}
                      title={`Stop routing to ${roleLabel(a.role)}`}
                      className="flex h-7 items-center gap-1.5 rounded-full bg-[#eeecfb] px-2.5 py-1 text-xs font-semibold text-[#5147b4] transition hover:bg-[#e2defa] dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
                    >
                      <InitialAvatar name={roleLabel(a.role)} size={16} /> To {roleLabel(a.role)} <X size={11} />
                    </button>
                  ))}
                <span className="ml-auto hidden text-[11px] text-gray-400 sm:block">Enter to send</span>
                {messageQueue.length > 0 ? (
                  <button
                    onClick={() => void sendAllQueued()}
                    disabled={chatSending || !messageQueue.some((m) => m.status === "queued")}
                    className="flex items-center gap-1 rounded-xl bg-[#635bff] px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#5346d8] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Send size={14} /> Send all
                  </button>
                ) : (
                  <button
                    onClick={() => void sendImmediately()}
                    disabled={chatSending || !draft.trim()}
                    aria-label="Send message"
                    className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#635bff] text-white shadow-sm transition hover:bg-[#5346d8] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
          {chatError && <p className="mt-2 text-xs text-red-600">{chatError}</p>}
        </div>
      )}

    </main>
  );
}
