"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import { AnimatedTooltip } from "@/components/ui/animated-tooltip";
import { avatartionFor, deserializeAvatartion } from "./ui/avatartion";
import Modal from "./Modal";
import TaskBoard from "./TaskBoard";

import { useToast } from "./Toasts";
import { Bell, Check, Copy, GitBranch, Menu, MoreHorizontal, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { roleLabel } from "@/lib/agentRoles";
import { dispatchChatTyping } from "@/lib/chatTyping";
import ChatComposer from "./chat/ChatComposer";
import MessageList from "./chat/MessageList";
import { useChatQueue } from "./chat/useChatQueue";
import { useDraftMentions } from "./chat/useDraftMentions";
import FilesView from "./chat/FilesView";
import { statusFromActive } from "./AgentDetailPanel";
import { useWorkspace } from "@/app/WorkspaceContext";

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

type Props = {
  projectId: string;
  tab: "chat" | "tasks" | "files";
  setTab: (t: "chat" | "tasks" | "files") => void;
  onSelectTask: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  selectedTaskId: string | null;
};

// ponytail: auto-mode intent classification can be added via LLM when explicit modes feel too rigid




export default function ChatPanel({ projectId, tab, setTab, onSelectTask, onOpenAgent, selectedTaskId }: Props) {
  const { openSidebar } = useWorkspace();
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
  const agents = useMemo(
    () =>
      (projectAgentIds
        ? (allAgents ?? []).filter((agent: any) => (projectAgentIds as readonly string[]).includes(agent._id))
        : (allAgents ?? [])) as any[],
    [allAgents, projectAgentIds],
  );
  const pendingForProject = (approvals ?? []).filter((a: any) => a.projectId === projectId).length;
  const pendingItems = (approvals ?? []).filter((a: any) => a.projectId === projectId);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAgentsOpen, setMoreAgentsOpen] = useState(false);
  const moreAgentsRef = useRef<HTMLDivElement>(null);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
  const scrollToMessageRef = useRef<((messageId: string) => boolean) | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const lastMessageRef = useRef<{ _id: string; _creationTime: number } | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const pinsRef = useRef<HTMLDivElement>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const pinnedMessages = useQuery(api.messages.listPinned, { projectId: projectId as any });
  const togglePin = useMutation(api.messages.togglePin);

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

  useEffect(() => {
    if (!moreAgentsOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (moreAgentsRef.current && !moreAgentsRef.current.contains(event.target as Node)) setMoreAgentsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreAgentsOpen]);

  useEffect(() => {
    if (!pinsOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (pinsRef.current && !pinsRef.current.contains(event.target as Node)) {
        setPinsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pinsOpen]);

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
      queue.clear();
      mentions.setMention(null);
      toast("success", "Chat cleared");
      setClearConfirm(null);
    } catch (err) {
      toast("error", "Failed to clear chat", err instanceof Error ? err.message : "Failed to clear chat");
    } finally {
      setClearPending(false);
    }
  };

  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId);
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const projectFiles = useQuery(api.fileChanges.listByProject, { projectId: projectId as any });
  const subtasksByTask = useQuery(api.workspace.listSubtasksByProject, { projectId: projectId as any });
  const subtasksOf = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const row of subtasksByTask ?? []) map.set(row.taskId, row.subtasks);
    return map;
  }, [subtasksByTask]);
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  // Chat timeline = conversation messages only. Task-linked messages
  // (taskId set) belong to the task thread and must not leak into the
  // chat as reports. Task user copies (same content as the conversation
  // message) are skipped to avoid duplicates.
  const timeline = useMemo(
    () =>
      (messages ?? [])
        .filter((message: any) => !message.taskId)
        .sort((a: any, b: any) => a._creationTime - b._creationTime),
    [messages],
  );
  const lastMessage = timeline[timeline.length - 1];

  // "• New" divider: marks the first message newer than the newest one
  // the user has seen (persisted per project). It used to be rendered
  // unconditionally at the top of the timeline, so an hour-old thread
  // still read "New" at the top. It now sits at the boundary between seen
  // and unseen messages and advances as the user reads to the bottom.
  const lastSeenKey = `moagent-chat-lastseen-${projectId}`;
  // null until read from storage: rendering with 0 put "• New" above the
  // oldest message for one frame on every mount.
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  // First run (no stored position): adopt the current newest message as
  // seen, so the divider only ever marks genuinely new arrivals —
  // otherwise the whole backlog reads as "new" and the divider sits at
  // the very top again.
  const [lastSeenIsFresh, setLastSeenIsFresh] = useState(false);
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(lastSeenKey));
      if (stored) setLastSeenAt(stored);
      else {
        setLastSeenAt(0);
        setLastSeenIsFresh(true);
      }
    } catch {
      setLastSeenAt(0);
      setLastSeenIsFresh(true);
    }
  }, [lastSeenKey]);
  const markSeen = () => {
    const seen = lastMessage?._creationTime ?? 0;
    if (!seen) return;
    setLastSeenAt((prevOrNull) => {
      const prev = prevOrNull ?? 0;
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
    if (timeline.length === 0 || lastSeenAt === null) return;
    if (lastSeenIsFresh) {
      markSeen();
      setLastSeenIsFresh(false);
      return;
    }
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight <= 120) {
      markSeen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, lastSeenKey, lastSeenIsFresh, lastSeenAt === null]);

  // Follow the newest message: reset on project switch, then scroll when
  // the last message changes while the user is already at the bottom.
  useEffect(() => {
    nearBottomRef.current = true;
  }, [projectId]);

  // Jump to the newest message. Repeated on the next frames because the
  // virtualized list renders with estimated row heights first.
  const scrollToBottom = () => {
    const apply = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  };

  // Coming back to Chat from Tasks/Files: the shared scroll container kept
  // the other tab's position, which landed on the oldest messages.
  useEffect(() => {
    setShowScrollDown(false);
    if (tab === "chat") {
      nearBottomRef.current = true;
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    const last = timeline[timeline.length - 1] as any;
    if (!last) {
      lastMessageRef.current = null;
      return;
    }
    const prev = lastMessageRef.current;
    if (prev && prev._id === last._id && prev._creationTime === last._creationTime) return;
    lastMessageRef.current = { _id: last._id, _creationTime: last._creationTime };
    if (nearBottomRef.current) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline]);
  const firstNewIndex = lastSeenAt === null ? -1 : timeline.findIndex(
    (m: any) => m._creationTime > lastSeenAt
  );
  const wasAgentTypingRef = useRef(false);

  // A chat reply is expected while the last message is the user's. But a
  // task-intent message is auto-dispatched and returns early without a chat
  // reply — the pill would then sit there forever next to the task card.
  // `tasks` is already in scope from the board query.
  //
  // The typing signal is ALSO time-bounded (300s, matching LLM_TIMEOUT_MS):
  // chat replies have no execution lease, so nothing else terminates the
  // pill. Without the bound, deleting the task that suppressed the pill via
  // the title check below would resurrect "X is drafting a reply" forever —
  // the conversation message survives (it has no taskId), but its task row
  // is gone. The clock ticks so the pill retires on its own when stale.
  const [typingNow, setTypingNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTypingNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const fresh = lastMessage ? typingNow - lastMessage._creationTime < 300_000 : false;
  const conversationTyping =
    lastMessage?.authorType === "user" &&
    fresh &&
    !(tasks ?? []).some((t: any) => t.title === lastMessage?.content);

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
  const blockKey = (m: any) => m.taskId ?? replyToTask.get(m._id) ?? taskFromPlan(m.content ?? "") ?? "conversation";

  const [manageName, setManageName] = useState("");
  const [managePath, setManagePath] = useState("");
  const [manageApprovalMode, setManageApprovalMode] = useState<"ask" | "auto">("ask");
  const [manageAgentIds, setManageAgentIds] = useState<string[]>([]);
  const [manageInstructions, setManageInstructions] = useState("");
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
    setManageInstructions((project as any).instructions ?? "");
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
        instructions: manageInstructions,
      });
    } catch (err) {
      setManageError(`Couldn't save project settings: ${errorText(err)}`);
      setSavingManage(false);
      return;
    }
    try {
      await updateTeam({ projectId: projectId as never, agentIds: manageAgentIds as never[] });
      setIsManageOpen(false);
      toast("success", "Project updated");
    } catch (err) {
      // Settings above already saved: say exactly which part failed.
      setManageError(`Project settings saved, but the team couldn't be updated: ${errorText(err)}`);
    } finally {
      setSavingManage(false);
    }
  }

  const toast = useToast();

  const sendMessage = useAction(api.messages.send);
  const [draft, setDraft] = useState("");
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
  // Who is drafting a chat reply (the "thinking" pill names them instead
  // of a generic label); mirrors the persisted chat selection.
  const replyingNames = chatAgentIds
    .map((id) => (agents as any)?.find((a: any) => a._id === id))
    .filter(Boolean)
    .slice(0, 3)
    .map((a: any) => roleLabel(a.role));
  const [chatError, setChatError] = useState("");
  const [chatSending, setChatSending] = useState(false);
  // Dismissed agent-error banners survive reloads within the tab session.
  const dismissedKey = `moagent-dismissed-errors-${projectId}`;
  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(sessionStorage.getItem(dismissedKey) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const dismissError = (errorId: string) =>
    setDismissedErrors((dismissed) => {
      const next = new Set(dismissed).add(errorId);
      try {
        sessionStorage.setItem(dismissedKey, JSON.stringify([...next]));
      } catch {
        /* storage denied — keep it in memory */
      }
      return next;
    });

  const mentions = useDraftMentions(draft, setDraft, project, projectFiles, agents as any[]);
  const queue = useChatQueue(
    async (content) => {
      const mentionedIds = mentions.mentionedAgentIds(content);
      await sendMessage({
        projectId: projectId as any,
        content,
        preferredAgentIds: mentionedIds.length
          ? (mentionedIds as any)
          : chatAgentIds.length
            ? (chatAgentIds as any)
            : undefined,
      });
    },
    (message) => setChatError(message),
  );

  const addToQueue = async () => {
    const text = draft.trim();
    if (!text) return;
    const content = await mentions.attachMentionedFiles(text);
    queue.add(content);
    setDraft("");
    mentions.setMention(null);
  };

  const handleChooseProposal = async (choice: string) => {
    setChatSending(true);
    try {
      const mentionedIds = mentions.mentionedAgentIds(choice);
      await sendMessage({
        projectId: projectId as any,
        content: choice,
        preferredAgentIds: mentionedIds.length
          ? (mentionedIds as any)
          : chatAgentIds.length
            ? (chatAgentIds as any)
            : undefined,
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
      const content = await mentions.attachMentionedFiles(text);
      const mentionedIds = mentions.mentionedAgentIds(content);
      await sendMessage({
        projectId: projectId as any,
        content,
        preferredAgentIds: mentionedIds.length
          ? (mentionedIds as any)
          : chatAgentIds.length
            ? (chatAgentIds as any)
            : undefined,
      });
      setDraft("");
      mentions.setMention(null);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setChatSending(false);
    }
  };

  const sendAllQueued = async () => {
    setChatError("");
    setChatSending(true);
    try {
      await queue.sendAll();
    } finally {
      setChatSending(false);
    }
  };

  // Signal the sidebar's team list that selected agents are drafting a
  // chat reply (backend execution leases do not cover chat replies).
  useEffect(() => {
    if (!conversationTyping) {
      dispatchChatTyping({ agentIds: [], active: false });
      return;
    }
    const ids = chatAgentIds.length
      ? chatAgentIds
      : agents.map((agent: any) => agent._id);
    dispatchChatTyping({ agentIds: ids as string[], active: true });
  }, [conversationTyping, chatAgentIds, agents]);

  // Auto-dispatch the queue when the agent finishes replying (chat replies
  // are the normal case — this used to require a selected task). The
  // previous typing state is always recorded so the edge is never missed.
  const queuedCount = queue.items.filter((m) => m.status === "queued").length;
  useEffect(() => {
    const wasTyping = wasAgentTypingRef.current;
    wasAgentTypingRef.current = conversationTyping;
    if (wasTyping && !conversationTyping && queuedCount > 0) {
      const timer = setTimeout(() => void sendAllQueued(), 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationTyping]);

  // Bell popover actions: disabled while running, errors surface as toasts,
  // reject asks for a second tap.
  const runApproval = async (approvalId: string, action: "approve" | "reject") => {
    setActingApprovalId(approvalId);
    setConfirmRejectId(null);
    try {
      if (action === "approve") await approve({ approvalId: approvalId as any });
      else await reject({ approvalId: approvalId as any });
    } catch (err) {
      toast("error", action === "approve" ? "Couldn't approve" : "Couldn't reject", errorText(err));
    } finally {
      setActingApprovalId(null);
    }
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
  // Scoped to this project: an active task in another project must not
  // put "X is thinking" into this project's chat.
  const workingAgents = (agents as any[]).filter((agent: any) => {
    const active = (activeByAgent as any)?.[agent._id as string];
    return active && active.projectId === projectId;
  });
  const taskErrors = (taskEvents ?? []).filter((event: any) => event.type === "task.error");
  // Header status from the execution lease (source of truth), like the
  // Sidebar — the persisted `agents.status` is stale.
  const leaseStatus = (agentId: string) => statusFromActive((activeByAgent as any)?.[agentId]);
  // Refresh relative timestamps ("just now" → "2m ago") once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const formatMessageTime = (createdAt: number) => {
    const elapsedMinutes = Math.max(0, Math.floor((now - createdAt) / 60000));
    if (elapsedMinutes < 1) return "just now";
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;
    return `${Math.floor(elapsedHours / 24)}d ago`;
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-transparent">
      <header className="shrink-0 border-b border-[#ebe9f0] bg-white/30 dark:border-gray-800 dark:bg-gray-950/20">
      <div className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 sm:px-5">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open projects and team"
          title="Projects and team"
          className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 min-[980px]:hidden dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <Menu size={18} />
        </button>
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
                    aria-label={`${roleLabel(a.role)} · ${leaseStatus(a._id).label}`}
                    onFocus={() => setActiveAgentId(a._id)}
                    onBlur={() => setActiveAgentId(null)}
                    className={`-ml-1.5 rounded-full p-0 outline-none first:ml-0 focus-visible:ring-2 focus-visible:ring-[#635bff]/50 ${
                      activeAgentId && activeAgentId !== a._id
                        ? "opacity-40"
                        : "opacity-100 transition hover:opacity-70"
                    }`}
                    onMouseEnter={() => setActiveAgentId(a._id)}
                  >
                    <AgentAvatar name={roleLabel(a.role)} size={20} status={leaseStatus(a._id).avatar} avatarParams={a.avatarParams} />
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
                            designation: leaseStatus(a._id).label,
                            avatar: (a.avatarParams ? deserializeAvatartion(a.avatarParams) : null) ?? avatartionFor(roleLabel(a.role)),
                            size: 20,
                          }]
                        : [];
                    })()}
                  />
                </span>
              )}
              {agents.length > headerAgents.length && (
                <div className="relative" ref={moreAgentsRef}>
                  <button
                    type="button"
                    onClick={() => setMoreAgentsOpen((open) => !open)}
                    title={`${agents.length - headerAgents.length} more agents`}
                    aria-label={`Show ${agents.length - headerAgents.length} more agents`}
                    aria-expanded={moreAgentsOpen}
                    className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600 outline-none ring-1 ring-white transition hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-[#635bff]/50 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-900 dark:hover:bg-gray-700"
                  >
                    +{agents.length - headerAgents.length}
                  </button>
                  {moreAgentsOpen && (
                    <div className="absolute left-0 top-full z-40 mt-2 w-52 overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                      {agents.slice(headerAgents.length).map((a: any) => (
                        <button
                          key={a._id}
                          type="button"
                          onClick={() => { setMoreAgentsOpen(false); onOpenAgent?.(a._id); }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                        >
                          <AgentAvatar name={roleLabel(a.role)} size={20} status={leaseStatus(a._id).avatar} avatarParams={a.avatarParams} />
                          <span className="min-w-0 flex-1 truncate">{roleLabel(a.role)}</span>
                          <span className="text-[11px] text-gray-500 dark:text-gray-400">{leaseStatus(a._id).label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <span className="text-xs text-gray-500">{agents.length} {agents.length === 1 ? "agent" : "agents"}</span>
          </div>
        </div>
      </div>
      {/* Tab bar row: workspace tabs (left) + version/pin/bell/more (right) */}
      <div className="flex items-center gap-2 border-t border-[#f0eef4] px-4 py-2 sm:gap-3 sm:px-5 dark:border-gray-800/60">
        <div className="flex shrink-0 items-center rounded-xl bg-gray-100 p-1 dark:bg-gray-800" role="tablist" aria-label="Workspace view">
          {(["chat", "tasks", "files"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-[13px] capitalize outline-none transition focus-visible:ring-2 focus-visible:ring-[#635bff]/40 ${tab === t ? "bg-white font-semibold text-[#24232d] shadow-sm dark:bg-gray-900 dark:text-white" : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"}`}
            >
              {t}{t === "tasks" && tasks?.length ? ` ${tasks.length}` : ""}
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {/* Branch + plan version describe the selected task only; falling
              back to an arbitrary tasks[0] showed the wrong task's data. */}
          {(selectedTask as any)?.branchName ? (
            <span
              title="Branch of the selected task"
              className="hidden max-w-[220px] items-center gap-1 rounded-lg border border-[#e5e3eb] px-2 py-1 font-mono text-[11px] font-semibold text-gray-500 sm:flex dark:border-gray-700 dark:text-gray-400"
            >
              <GitBranch size={12} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{(selectedTask as any).branchName}</span>
            </span>
          ) : null}
          {selectedTask && (selectedTask as any).planVersion ? (
            <span
              title="Plan version of the selected task"
              className="hidden items-center gap-1 rounded-lg border border-[#e5e3eb] px-2 py-1 font-mono text-[11px] font-semibold text-gray-500 sm:flex dark:border-gray-700 dark:text-gray-400"
            >
              v{(selectedTask as any).planVersion}
            </span>
          ) : null}
        <div className="flex items-center gap-1">
          <div className="relative" ref={pinsRef}>
            <button
              type="button"
              onClick={() => setPinsOpen((open) => !open)}
              title={`${(pinnedMessages ?? []).length} pinned message${(pinnedMessages ?? []).length === 1 ? "" : "s"}`}
              aria-label={`${(pinnedMessages ?? []).length} pinned messages`}
              aria-expanded={pinsOpen}
              className="flex items-center gap-1 rounded-lg p-1.5 text-gray-500 outline-none transition hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Pin size={13} />
              <span className="text-[11px] font-semibold tabular-nums">{(pinnedMessages ?? []).length > 9 ? "9+" : (pinnedMessages ?? []).length}</span>
            </button>
            {pinsOpen && (
              <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Pinned ({(pinnedMessages ?? []).length})
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {(pinnedMessages ?? []).length === 0 && (
                    <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">No pinned messages yet. Use the pin icon on a message to keep it here.</p>
                  )}
                  {(pinnedMessages ?? []).map((m: any) => (
                    <div key={m._id} className="flex items-start gap-2 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                      <button
                        type="button"
                        title="Open in chat"
                        aria-label="Open in chat"
                        onClick={() => {
                          setPinsOpen(false);
                          // Task-thread messages live in the thread, not the chat timeline.
                          if (m.taskId) {
                            onSelectTask(m.taskId);
                            return;
                          }
                          setTab("chat");
                          // Wait for the tab switch (and its scroll-to-bottom) to settle.
                          setTimeout(() => {
                            if (!scrollToMessageRef.current?.(m._id)) toast("info", "That message is no longer in the loaded chat history.");
                          }, 80);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="text-[11px] font-semibold text-gray-500">
                          {m.authorType === "agent"
                            ? roleLabel((agents as any)?.find((a: any) => a._id === m.agentId)?.role)
                            : "You"}
                          <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">{formatMessageTime(m._creationTime)}</span>
                        </p>
                        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[13px] text-gray-700 dark:text-gray-200">{m.content}</p>
                      </button>
                      <button
                        type="button"
                        title="Unpin message"
                        aria-label="Unpin message"
                        onClick={() => void togglePin({ messageId: m._id, pinned: false })}
                        className="shrink-0 rounded-md p-1.5 text-gray-500 outline-none transition hover:bg-gray-100 hover:text-[#635bff] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        <PinOff size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setNotifOpen((open) => !open)}
              title={`Notifications — ${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"}`}
              aria-label={`Notifications — ${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"}`}
              aria-expanded={notifOpen}
              className="relative rounded-lg p-1.5 text-gray-500 outline-none transition hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Bell size={15} />
              {pendingForProject > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                  {pendingForProject > 9 ? "9+" : pendingForProject}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 z-40 mt-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Notifications ({pendingForProject})
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {pendingItems.length === 0 && (
                    <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">Nothing is waiting for approval.</p>
                  )}
                  {pendingItems.map((a: any) => (
                    <div key={a._id} className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                      <p className="truncate text-sm font-medium">{a.summary}</p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{a.kind}</p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={actingApprovalId !== null}
                          onClick={() => void runApproval(a._id, "approve")}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white outline-none hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-400/60 disabled:opacity-50"
                        >
                          {actingApprovalId === a._id ? "Working…" : "Approve"}
                        </button>
                        {confirmRejectId === a._id ? (
                          <>
                            <button
                              type="button"
                              disabled={actingApprovalId !== null}
                              onClick={() => void runApproval(a._id, "reject")}
                              className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:opacity-50"
                            >
                              Confirm reject
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRejectId(null)}
                              className="rounded-lg px-2 py-1 text-xs font-semibold text-gray-500 outline-none hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:text-gray-200"
                            >
                              Keep
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={actingApprovalId !== null}
                            onClick={() => setConfirmRejectId(a._id)}
                            className="rounded-lg bg-gray-200 px-2.5 py-1 text-xs font-semibold outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 disabled:opacity-50 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600"
                          >
                            Reject
                          </button>
                        )}
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
              className="rounded-lg p-1.5 text-gray-500 outline-none transition hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
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
                      message: "Every chat message in this project will be deleted, except pinned messages. Tasks themselves are kept.",
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

      <div ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (!el) return; const dist = el.scrollHeight - el.scrollTop - el.clientHeight; nearBottomRef.current = dist <= 120; setShowScrollDown(tab === "chat" && dist > 120); if (dist <= 120) markSeen(); }} className="relative min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain bg-transparent px-4 py-5 sm:px-5 sm:py-6">
        {taskErrors.filter((event: any) => !dismissedErrors.has(String(event._id ?? event.payload?.message ?? "unknown"))).map((event: any) => {
          const errorId = String(event._id ?? event.payload?.message ?? "unknown");
          return (
          <div key={errorId} role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            <span className="min-w-0 flex-1 break-words"><span className="font-semibold">Agent error:</span> {event.payload?.message ?? "Task failed to process."}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => dismissError(errorId)} className="-m-0.5 shrink-0 rounded-md p-1 text-red-500 outline-none hover:bg-red-100 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-red-400/60 dark:text-red-400 dark:hover:bg-red-900/40 dark:hover:text-red-200">
              <X size={14} />
            </button>
          </div>
          );
        })}
        {tab === "chat" ? (
            <MessageList
              timeline={timeline}
              scrollRef={scrollRef}
              firstNewIndex={firstNewIndex}
              agents={agents}
              tasks={tasks}
              subtasksOf={subtasksOf}
              pendingItems={pendingItems}
              projectEvents={projectEvents}
              projectApprovalMode={(project as any)?.approvalMode ?? "ask"}
              loading={messages === undefined}
              scrollToMessageRef={scrollToMessageRef}
              chatSending={chatSending}
              conversationTyping={conversationTyping}
              replyingNames={replyingNames}
              activeForSelectedTask={activeForSelectedTask}
              workingAgents={workingAgents}
              onSelectTask={onSelectTask}
              approve={(approvalId) => approve({ approvalId: approvalId as any })}
              reject={(approvalId) => reject({ approvalId: approvalId as any })}
              hold={(approvalId) => hold({ approvalId: approvalId as any })}
              togglePin={(messageId, pinned) => void togglePin({ messageId: messageId as never, pinned })}
              onPickProposal={(choice) => void handleChooseProposal(choice)}
              formatTime={formatMessageTime}
              taskTitle={taskTitle}
              blockKey={blockKey}
            />
        ) : (
          <motion.div key={tab} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
            {tab === "files" ? (
              <FilesView project={project} />
            ) : (
              <TaskBoard projectId={projectId} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
            )}
          </motion.div>
        )}
      </div>

      {showScrollDown && tab === "chat" && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
          aria-label="Scroll to bottom"
          className="absolute bottom-32 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full bg-white text-gray-700 shadow-lg outline-none ring-1 ring-gray-200 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-[#635bff]/50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700"
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
                placeholder="/path/to/your/repo"
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
            <label className="grid gap-1 text-sm">
              Shared instructions
              <textarea
                value={manageInstructions}
                onChange={(event) => setManageInstructions(event.target.value)}
                rows={4}
                placeholder="Durable project instructions loaded into planning every run (e.g. architecture rules, conventions)."
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Team project</legend>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                {(allAgents ?? []).length === 0 && <p className="text-xs text-gray-400">No agents yet. Create one with + in the Team section of the sidebar.</p>}
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
        <ChatComposer
          draft={draft}
          onDraftChange={mentions.handleInput}
          onSend={() => void sendImmediately()}
          onQueue={() => void addToQueue()}
          sending={chatSending}
          error={chatError}
          mention={mentions.mention}
          mentionResults={mentions.results}
          agentResults={mentions.agentResults}
          onInsertMention={mentions.insert}
          onInsertAgent={mentions.insertAgent}
          onDismissMention={() => mentions.setMention(null)}
          queue={queue.items}
          editingId={editingId}
          onEdit={setEditingId}
          onEditContent={queue.update}
          onMove={queue.move}
          onRemove={queue.remove}
          onRetry={(id) => {
            setChatError("");
            void queue.retry(id);
          }}
          onSendAll={() => void sendAllQueued()}
          projectName={(project as any)?.name ?? "the team"}
        />
      )}

    </main>
  );
}
