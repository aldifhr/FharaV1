"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useAction, useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import TaskBoard from "./TaskBoard";
import { useToast } from "./Toasts";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import QueryBoundary from "./shell/QueryBoundary";
import { roleLabel } from "@/lib/agentRoles";
import { dispatchChatTyping } from "@/lib/chatTyping";
import { isClosedStatus } from "@/lib/taskStatus";
import { readLastRead, writeLastRead } from "@/lib/lastRead";
import { statusFromLeases, type LeaseEntry, type StatusMap } from "@/lib/teamStatus";
import ChatComposer from "./chat/ChatComposer";
import ChatHeader, { type ChatTab, type HeaderNotification } from "./chat/ChatHeader";
import ManageProjectModal from "./chat/ManageProjectModal";
import MessageList from "./chat/MessageList";
import StatusLine from "./chat/StatusLine";
import FilesView from "./chat/FilesView";
import { useChatQueue } from "./chat/useChatQueue";
import { useDraftMentions } from "./chat/useDraftMentions";
import { useWorkspace } from "@/app/WorkspaceContext";
import { clockTime, isSameDay, shortDate } from "@/lib/format";
import { projectMembers } from "@/lib/projectMembers";

type Props = {
  projectId: string;
  tab: ChatTab;
  setTab: (t: ChatTab) => void;
  onSelectTask: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  selectedTaskId: string | null;
};

/** Lifts the live team status out of a boundary-protected query. */
function TeamStatusFeed({ projectId, onChange }: { projectId: string; onChange: (s: StatusMap | undefined) => void }) {
  const status = useQuery(api.shell.teamStatus, { projectId: projectId as never }) as StatusMap | undefined;
  useEffect(() => onChange(status), [status, onChange]);
  return null;
}

/** Same, for the indexed pin list (falls back to messages.listPinned). */
function PinsFeed({ projectId, onChange }: { projectId: string; onChange: (p: any[] | undefined) => void }) {
  const pins = useQuery(api.pins.listForProject, { projectId: projectId as never });
  useEffect(() => onChange(pins), [pins, onChange]);
  return null;
}
function LegacyPinsFeed({ projectId, onChange }: { projectId: string; onChange: (p: any[] | undefined) => void }) {
  const pins = useQuery(api.messages.listPinned, { projectId: projectId as never });
  useEffect(() => onChange(pins), [pins, onChange]);
  return null;
}

const TARGET_KEY = (projectId: string) => `moagent-chat-target-${projectId}`;

export default function ChatPanel({ projectId, tab, setTab, onSelectTask, onOpenAgent, selectedTaskId }: Props) {
  const { openSidebar, sidebarCollapsed, toggleSidebarCollapsed } = useWorkspace();
  const toast = useToast();
  const project = useQuery(api.projects.get, { projectId: projectId as any });
  const messages = useQuery(api.messages.listByProject, { projectId: projectId as any });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  const approvals = useQuery(api.approvals.listPendingAll, {});
  const projectEvents = useQuery(api.taskEvents.listByProject, { projectId: projectId as any });
  const allAgents = useQuery(api.agents.list, {});
  const activeConversation = useQuery(api.conversations.getActive, { projectId: projectId as any });
  const projectFiles = useQuery(api.fileChanges.listByProject, { projectId: projectId as any });
  const subtasksByTask = useQuery(api.workspace.listSubtasksByProject, { projectId: projectId as any });
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const hold = useMutation(api.approvals.hold);
  const togglePin = useMutation(api.messages.togglePin);
  const clearChat = useMutation(api.conversations.clearChat);
  const createTask = useMutation(api.tasks.createFromCommand);
  const sendMessage = useAction(api.messages.send);

  const [liveStatus, setLiveStatus] = useState<StatusMap | undefined>(undefined);
  const [pins, setPins] = useState<any[] | undefined>(undefined);
  const [manageOpen, setManageOpen] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [clearConfirm, setClearConfirm] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const scrollToMessageRef = useRef<((messageId: string) => boolean) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const lastMessageRef = useRef<{ _id: string; _creationTime: number } | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const projectAgentIds = (project as any)?.agentIds as string[] | undefined;
  const agents = useMemo(
    () => projectMembers((allAgents ?? []) as any[], projectAgentIds),
    [allAgents, projectAgentIds],
  );
  const pendingItems = useMemo(() => (approvals ?? []).filter((a: any) => a.projectId === projectId), [approvals, projectId]);

  // Team status: live read model, else derived from execution leases.
  const status: StatusMap | undefined = useMemo(() => {
    if (liveStatus) return liveStatus;
    if (!activeByAgent) return undefined;
    return statusFromLeases(activeByAgent as Record<string, LeaseEntry>, { projectId, otherProjects: "skip", checkFirst: "qa" });
  }, [liveStatus, activeByAgent, projectId]);

  const subtasksOf = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const row of subtasksByTask ?? []) map.set(row.taskId, row.subtasks);
    return map;
  }, [subtasksByTask]);

  // Chat timeline = conversation messages only; task-linked messages live in
  // the task thread.
  const timeline = useMemo(
    () =>
      (messages ?? [])
        // Plan 019: task cards posted into this chat (assignment, changes,
        // verification, QA, push) carry taskId AND conversationId — they
        // belong in the chat as well as in the task thread.
        .filter((message: any) => !message.taskId || (message.card && message.conversationId))
        .sort((a: any, b: any) => a._creationTime - b._creationTime),
    [messages],
  );
  const lastMessage = timeline[timeline.length - 1];

  // ── Unread "• New" divider: last-read timestamp per conversation. ──────
  // `lastReadAt` advances (and persists) as the user reads to the bottom;
  // the divider stays where it was when the conversation was opened, so it
  // does not vanish the moment the view auto-scrolls. Sending a message
  // means the user caught up: the divider goes away.
  const conversationKey = (activeConversation as any)?.conversation?._id ?? projectId;
  const lastReadRef = useRef<number>(0);
  const [dividerAt, setDividerAt] = useState<number | null>(null);
  useEffect(() => {
    // The pre-conversation per-project key stays readable after the switch.
    const stored = readLastRead(conversationKey) ?? readLastRead(projectId);
    lastReadRef.current = stored ?? 0;
    // First visit (nothing stored): the backlog is not "new".
    setDividerAt(stored ?? Number.POSITIVE_INFINITY);
  }, [conversationKey, projectId]);
  const markSeen = () => {
    const seen = lastMessage?._creationTime ?? 0;
    if (!seen || seen <= lastReadRef.current) return;
    lastReadRef.current = seen;
    writeLastRead(conversationKey, seen);
  };
  useEffect(() => {
    if (timeline.length === 0 || dividerAt === null) return;
    const el = scrollRef.current;
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
    if ((atBottom && document.visibilityState === "visible") || dividerAt === Number.POSITIVE_INFINITY) markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, conversationKey, dividerAt]);
  const firstNewIndex =
    dividerAt === null ? -1 : timeline.findIndex((m: any) => m._creationTime > dividerAt && m.authorType !== "user");

  // ── Scrolling ───────────────────────────────────────────────────────────
  useEffect(() => {
    nearBottomRef.current = true;
  }, [projectId]);
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
  useEffect(() => {
    setShowScrollDown(false);
    if (tab === "chat") {
      nearBottomRef.current = true;
      scrollToBottom();
    }
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
  }, [timeline]);

  // ── Chat typing (no execution lease for chat replies; time-bounded) ─────
  const [typingNow, setTypingNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTypingNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const fresh = lastMessage ? typingNow - lastMessage._creationTime < 300_000 : false;
  const conversationTyping =
    lastMessage?.authorType === "user" && fresh && !(tasks ?? []).some((t: any) => t.title === lastMessage?.content);

  const taskTitle = (taskId: string) => (tasks ?? []).find((task) => task._id === taskId)?.title ?? "task";
  const taskFromPlan = (content: string) => content.match(/^Plan dibuat\. Task (\S+)/)?.[1];
  const replyToTask = new Map<string, string>();
  for (const m of messages ?? []) {
    const taskId = m.taskId ?? taskFromPlan(m.content ?? "");
    if (m.replyToMessageId && taskId) replyToTask.set(m.replyToMessageId, taskId);
  }
  const blockKey = (m: any) => m.taskId ?? replyToTask.get(m._id) ?? taskFromPlan(m.content ?? "") ?? "conversation";

  // ── Composer: draft, mentions, queue, target ("To <Agent>") ────────────
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [chatError, setChatError] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [targetId, setTargetIdState] = useState<string | null>(null);
  useEffect(() => {
    if (!agents.length) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(TARGET_KEY(projectId));
    } catch {
      /* storage denied */
    }
    setTargetIdState((current) => {
      if (current && agents.some((a) => a._id === current)) return current;
      if (stored && agents.some((a) => a._id === stored)) return stored;
      // Default receiver: the CTO, else the first teammate.
      return (agents.find((a) => a.role === "cto") ?? agents[0])._id;
    });
  }, [agents, projectId]);
  const setTargetId = (id: string) => {
    setTargetIdState(id);
    try {
      localStorage.setItem(TARGET_KEY(projectId), id);
    } catch {
      /* storage denied */
    }
  };
  const targetAgent = agents.find((a) => a._id === targetId);

  const mentions = useDraftMentions(draft, setDraft, project, projectFiles, agents);
  const recipientsFor = (content: string): string[] | undefined => {
    const mentioned = mentions.mentionedAgentIds(content);
    if (mentioned.length) return mentioned;
    return targetId ? [targetId] : undefined;
  };
  const queue = useChatQueue(
    async (content) => {
      await sendMessage({ projectId: projectId as any, content, preferredAgentIds: recipientsFor(content) as any });
    },
    (message) => setChatError(message),
  );

  const addToQueue = async () => {
    const text = draft.trim();
    if (!text) return;
    queue.add(await mentions.attachMentionedFiles(text));
    setDraft("");
    mentions.setMention(null);
  };

  const handleChooseProposal = async (choice: string) => {
    setChatSending(true);
    try {
      await sendMessage({ projectId: projectId as any, content: choice, preferredAgentIds: recipientsFor(choice) as any });
    } catch (err) {
      toast("error", "Failed to select option", err instanceof Error ? err.message : "Error");
    } finally {
      setChatSending(false);
    }
  };

  /** "Create task" under an agent's recommendation: the user's pick (if
   *  any) plus the recommendation become the task; @Role mentions in the
   *  recommendation become its assignees. */
  const createTaskFromMessage = async (messageId: string) => {
    const list = timeline as any[];
    const at = list.findIndex((m) => String(m._id) === messageId);
    const reply = list[at];
    if (!reply) return;
    let prevUser: any = null;
    for (let j = at - 1; j >= 0; j--) if (list[j].authorType === "user") { prevUser = list[j]; break; }
    const pick = prevUser?.content?.trim().match(/^i choose\s+[a-z0-9]+\s*:\s*(.+)$/i)?.[1];
    const ask = prevUser && !pick ? prevUser.content.trim() : "";
    const command = [pick ? `Chosen option: ${pick}` : ask, reply.content.trim()].filter(Boolean).join("\n\n");
    const assignees = mentions.mentionedAgentIds(reply.content);
    try {
      const taskId = await createTask({
        projectId: projectId as never,
        command,
        title: pick ? `Implement ${pick}` : undefined,
        ...(assignees.length ? { assignedAgentIds: assignees as never[] } : {}),
        ...((activeConversation as any)?.conversation?._id ? { conversationId: (activeConversation as any).conversation._id } : {}),
      });
      toast("success", "Task created", pick ?? undefined);
      onSelectTask(taskId as string);
    } catch (err) {
      toast("error", "Couldn't create the task", err instanceof Error ? err.message : undefined);
      throw err;
    }
  };

  const agentByRole = (...roles: string[]) => roles.map((r) => agents.find((a) => a.role === r)).find(Boolean);

  /** Slash commands. Returns true when the draft was handled. */
  const runSlash = async (text: string): Promise<boolean> => {
    const match = text.match(/^\/(task|qa|review|push)\b\s*([\s\S]*)$/i);
    if (!match) return false;
    const command = match[1].toLowerCase();
    const rest = match[2].trim();
    if (command === "task") {
      if (!rest) {
        setChatError("Describe the task after /task.");
        return true;
      }
      const content = await mentions.attachMentionedFiles(rest);
      const assignees = mentions.mentionedAgentIds(content);
      const taskId = await createTask({
        projectId: projectId as never,
        command: content,
        ...(assignees.length ? { assignedAgentIds: assignees as never[] } : {}),
        ...((activeConversation as any)?.conversation?._id ? { conversationId: (activeConversation as any).conversation._id } : {}),
      });
      toast("success", "Task created", rest.slice(0, 80));
      onSelectTask(taskId as string);
      return true;
    }
    if (command === "push") {
      const push = pendingItems.find((a: any) => a.kind === "git_push");
      if (push) onSelectTask(push.taskId);
      else toast("info", "No push is waiting", "A push shows up here once a task branch is ready.");
      return true;
    }
    const agent = command === "qa" ? agentByRole("qa") : agentByRole("reviewer", "cto");
    if (!agent) {
      setChatError(`No ${command === "qa" ? "QA" : "reviewer"} on this project's team.`);
      return true;
    }
    const content =
      rest || (command === "qa" ? "Please QA the latest change and report what you checked." : "Please review the latest change and call out any risks.");
    await sendMessage({ projectId: projectId as any, content: `@${roleLabel(agent.role)} ${content}`, preferredAgentIds: [agent._id] as any });
    return true;
  };

  const sendImmediately = async () => {
    const text = draft.trim();
    if (!text) return;
    setChatError("");
    setChatSending(true);
    try {
      if (!(await runSlash(text))) {
        const content = await mentions.attachMentionedFiles(text);
        await sendMessage({ projectId: projectId as any, content, preferredAgentIds: recipientsFor(content) as any });
      }
      setDraft("");
      mentions.setMention(null);
      setDividerAt(Number.POSITIVE_INFINITY);
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

  // Who is drafting a chat reply: the target (or mentioned) agent.
  const draftingIds = conversationTyping ? (targetId ? [targetId] : agents.map((a) => a._id)) : [];
  useEffect(() => {
    dispatchChatTyping({ agentIds: draftingIds as string[], active: draftingIds.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationTyping, targetId, agents]);

  // Auto-dispatch the queue when the agent finishes replying.
  const wasAgentTypingRef = useRef(false);
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

  // ── Header data ────────────────────────────────────────────────────────
  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId) as any;
  // Branch pill: the selected task's branch, else the newest in-flight task's.
  const branchTask =
    (selectedTask?.branchName ? selectedTask : null) ??
    [...(tasks ?? [])]
      .filter((t: any) => t.branchName && !isClosedStatus(t.status))
      .sort((a: any, b: any) => (b.updatedAt ?? b._creationTime) - (a.updatedAt ?? a._creationTime))[0];
  const branch = branchTask ? { name: branchTask.branchName as string, taskId: branchTask._id as string, taskTitle: branchTask.title as string } : null;
  const openTaskCount = (tasks ?? []).filter((t: any) => !isClosedStatus(t.status)).length;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const formatMessageTime = (createdAt: number) => {
    const hm = clockTime(createdAt);
    if (now - createdAt < 60_000) return "just now";
    if (isSameDay(createdAt, now)) return hm;
    return `${shortDate(createdAt)}, ${hm}`;
  };

  const notifications: HeaderNotification[] = [
    ...pendingItems.map((a: any) => ({
      key: `a:${a._id}`,
      title: a.summary,
      meta: `${roleLabel(agents.find((x) => x._id === a.requestedByAgentId)?.role) } · ${formatMessageTime(a._creationTime)}`,
      approvalId: a._id,
      taskId: a.taskId,
    })),
    ...(tasks ?? [])
      .filter((t: any) => t.status === "waiting_input")
      .map((t: any) => ({ key: `q:${t._id}`, title: t.pendingQuestion || t.title, meta: `Question · ${t.title}`, taskId: t._id })),
  ];

  // Dismissible agent-error banners for the selected task.
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
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
        /* storage denied */
      }
      return next;
    });
  const taskErrors = (taskEvents ?? []).filter((event: any) => event.type === "task.error");

  const confirmClearChat = async () => {
    setClearPending(true);
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

  const runApproval = async (approvalId: string, action: "approve" | "reject") => {
    try {
      if (action === "approve") await approve({ approvalId: approvalId as any });
      else await reject({ approvalId: approvalId as any });
    } catch (err) {
      toast("error", action === "approve" ? "Couldn't approve" : "Couldn't reject", err instanceof Error ? err.message : "Please try again.");
    }
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
      <QueryBoundary>
        <TeamStatusFeed projectId={projectId} onChange={setLiveStatus} />
      </QueryBoundary>
      <QueryBoundary fallback={<LegacyPinsFeed projectId={projectId} onChange={setPins} />}>
        <PinsFeed projectId={projectId} onChange={setPins} />
      </QueryBoundary>

      <ChatHeader
        project={project as any}
        agents={agents}
        status={status}
        tab={tab}
        onTab={setTab}
        openTaskCount={openTaskCount}
        branch={branch}
        onOpenTask={onSelectTask}
        pins={pins}
        onJumpToPin={(m) => {
          if (m.taskId) {
            onSelectTask(m.taskId);
            return;
          }
          setTab("chat");
          setTimeout(() => {
            if (!scrollToMessageRef.current?.(m._id)) toast("info", "That message is no longer in the loaded chat history.");
          }, 80);
        }}
        onUnpin={(id) => void togglePin({ messageId: id as never, pinned: false })}
        notifications={notifications}
        onApprove={(id) => runApproval(id, "approve")}
        onReject={(id) => runApproval(id, "reject")}
        onOpenAgent={onOpenAgent}
        onCopyLink={async () => {
          try {
            await navigator.clipboard.writeText(`${window.location.origin}/chats/${projectId}`);
            return true;
          } catch {
            return false;
          }
        }}
        onManage={() => project && setManageOpen(true)}
        onClearChat={() =>
          setClearConfirm({
            title: "Clear this chat?",
            message: "Every chat message in this project will be deleted, except pinned messages. Tasks themselves are kept.",
            confirmLabel: "Clear chat",
            onOk: () => void confirmClearChat(),
          })
        }
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={toggleSidebarCollapsed}
        onOpenDrawer={openSidebar}
        formatTime={formatMessageTime}
      />

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
          nearBottomRef.current = dist <= 120;
          setShowScrollDown(tab === "chat" && dist > 120);
          if (dist <= 120) markSeen();
        }}
        className="shell-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2 sm:px-8 lg:px-10"
      >
        {taskErrors
          .filter((event: any) => !dismissedErrors.has(String(event._id)))
          .map((event: any) => (
            <div key={event._id} role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[14px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
              <span className="min-w-0 flex-1 break-words">
                <span className="font-semibold">Agent error:</span> {event.payload?.message ?? "Task failed to process."}
              </span>
              <button type="button" aria-label="Dismiss error" onClick={() => dismissError(String(event._id))} className="shrink-0 rounded-md p-1 hover:bg-red-100 dark:hover:bg-red-900/40">
                <X size={14} />
              </button>
            </div>
          ))}
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
            typingAgent={targetAgent ?? agents.find((a: any) => a.role === "cto")}
            onSelectTask={onSelectTask}
            approve={(approvalId) => approve({ approvalId: approvalId as any })}
            reject={(approvalId) => reject({ approvalId: approvalId as any })}
            hold={(approvalId) => hold({ approvalId: approvalId as any })}
            togglePin={(messageId, pinned) => void togglePin({ messageId: messageId as never, pinned })}
            onPickProposal={(choice) => void handleChooseProposal(choice)}
            onCreateTaskFrom={createTaskFromMessage}
            formatTime={formatMessageTime}
            taskTitle={taskTitle}
            blockKey={blockKey}
          />
        ) : (
          <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="pt-4">
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
          aria-label="Scroll to newest"
          className="absolute bottom-36 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-panel text-ink-2 shadow-lg outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}

      <ConfirmDialog request={clearConfirm} pending={clearPending} onCancel={() => setClearConfirm(null)} onConfirm={() => clearConfirm?.onOk()} />
      {manageOpen && project && (
        <ManageProjectModal projectId={projectId} project={project as any} allAgents={(allAgents ?? []) as any[]} onClose={() => setManageOpen(false)} />
      )}

      {tab === "chat" && (
        <>
          <StatusLine
            agents={agents}
            status={status}
            drafting={conversationTyping ? [roleLabel(targetAgent?.role ?? "cto")] : []}
            events={projectEvents as any}
            qaUrl={(project as any)?.qaUrl ?? (project as any)?.devUrl}
          />
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
            targets={agents}
            targetId={targetId}
            onTargetChange={setTargetId}
          />
        </>
      )}
    </main>
  );
}
