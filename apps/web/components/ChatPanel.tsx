import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "@/lib/spaRouter";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { reconcileOptimistic } from "@/lib/optimisticChat";
import { X } from "lucide-react";
import { api } from "@fhara/runtime/api";
import TaskBoard from "./TaskBoard";
import { useToast } from "./Toasts";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import QueryBoundary from "./shell/QueryBoundary";
import { roleLabel } from "@/lib/agentRoles";
import { dispatchChatTyping } from "@/lib/chatTyping";
import { isClosedStatus } from "@/lib/taskStatus";
import { statusFromLeases, type LeaseEntry, type StatusMap } from "@/lib/teamStatus";
import ChatComposer from "./chat/ChatComposer";
import { useReplyStop } from "./chat/useReplyStop";
import { isReplySettled } from "@/lib/stopControl";
import { useProjectSlash } from "./chat/useProjectSlash";
import ChatHeader, { type ChatTab, type HeaderNotification } from "./chat/ChatHeader";
import ManageProjectModal from "./chat/ManageProjectModal";
import MessageList from "./chat/MessageList";
import { quoteOf, type ChatQuote } from "./chat/QuoteBlock";
import FilesView from "./chat/FilesView";
import { useChatQueue } from "./chat/useChatQueue";
import { useDraftMentions } from "./chat/useDraftMentions";
import { useWorkspace } from "@/app/WorkspaceContext";
import { clockTime, isSameDay, shortDate } from "@/lib/format";
import { projectMembers } from "@/lib/projectMembers";
import { projectDefaultPermissionMode, type PermissionMode } from "@/api/functions/lib/permissionModes";
import { composeOfferedTask } from "@/api/functions/lib/chat/intent";
import DecisionsTray, { trayPlaceholder } from "./chat/DecisionsTray";
import AutomationHoldLine from "./chat/AutomationHoldLine";
import TaskDock from "./chat/TaskDock";
import { dockTasks, taskRef } from "@/lib/taskDock";
import { useMessageHistory } from "@/lib/useMessageHistory";
import { useApprovalBinding } from "./chat/useApprovalBinding";
import { useProjectSend } from "./chat/useProjectSend";
import { useModelOptions } from "./chat/useModelOptions";
import { useUnreadDivider } from "./chat/useUnreadDivider";
import { failureKindLabel } from "@/lib/failureKind";
import { useDecisionTrayActions } from "./chat/useDecisionTrayActions";

type Props = {
  projectId: string;
  tab: ChatTab;
  setTab: (t: ChatTab) => void;
  onSelectTask: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  selectedTaskId: string | null;
  /** A conversation deep link: the timeline shows this conversation only. */
  conversationId?: string | null;
  /** The linked conversation is closed: no composer. */
  conversationClosed?: boolean;
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

const TARGET_KEY = (projectId: string) => `fhara-chat-target-${projectId}`;

export default function ChatPanel({ projectId, tab, setTab, onSelectTask, onOpenAgent, selectedTaskId, conversationId = null, conversationClosed = false }: Props) {
  const { openSidebar } = useWorkspace();
  const toast = useToast();
  const project = useQuery(api.projects.get, { projectId: projectId as any });
  const { rows: messages, history } = useMessageHistory({ kind: "project", projectId }, useQuery(api.messages.listByProject, { projectId: projectId as any }));
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  // Project-scoped (index-backed); listPendingAll read every pending row.
  const approvals = useQuery(api.approvals.listPendingForProject, { projectId: projectId as any });
  const decisions = useQuery(api.shell.decisionsForProject, { projectId: projectId as any });
  const projectEvents = useQuery(api.taskEvents.listByProject, { projectId: projectId as any });
  const allAgents = useQuery(api.agents.list, {});
  const activeConversation = useQuery(api.conversations.getActive, { projectId: projectId as any });
  const projectFiles = useQuery(api.fileChanges.listByProject, { projectId: projectId as any });
  const subtasksByTask = useQuery(api.workspace.listSubtasksByProject, { projectId: projectId as any });
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const modelOptions = useModelOptions();
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const hold = useMutation(api.approvals.hold);
  const respondCommand = useMutation(api.commandApprovals.respond);
  const boundTo = useApprovalBinding(approvals as any[] | undefined);
  const answerQuestion = useMutation(api.tasks.answerQuestion);
  const togglePin = useMutation(api.messages.togglePin);
  const clearChat = useMutation(api.conversations.clearChat);
  const createTask = useMutation(api.tasks.createFromCommand);
  const sendMessage = useProjectSend();

  // Plan 020: permission mode for tasks dispatched from this composer.
  // Starts at the project's default; a pick holds until the project changes.
  const [permissionModeChoice, setPermissionModeChoice] = useState<PermissionMode | null>(null);
  // Plan 055: model pick per project chat; holds until the project changes.
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  useEffect(() => {
    setPermissionModeChoice(null);
    setModelChoice(null);
  }, [projectId]);
  const permissionMode: PermissionMode = permissionModeChoice ?? projectDefaultPermissionMode(project as any);
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
  const pendingItems = useMemo(() => (approvals ?? []) as any[], [approvals]);

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
      reconcileOptimistic((messages ?? []) as any[])
        // Plan 019: task cards posted into this chat (assignment, changes,
        // verification, QA, push) carry taskId AND conversationId — they
        // belong in the chat as well as in the task thread.
        .filter((message: any) => !message.taskId || (message.card && message.conversationId))
        // A conversation deep link shows that conversation alone.
        .filter((message: any) => !conversationId || message.conversationId === conversationId)
        .sort((a: any, b: any) => a._creationTime - b._creationTime),
    [messages, conversationId],
  );
  const lastMessage = timeline[timeline.length - 1];

  // ── "Decision needed" tray above the composer ─────────────────────
  const currentConversationId = ((activeConversation as any)?.conversation?._id as string | undefined) ?? null;

  // ── Unread "• New" divider (see useUnreadDivider). ──────
  const conversationKey = (activeConversation as any)?.conversation?._id ?? projectId;
  const { firstNewIndex, markSeen, clearDivider } = useUnreadDivider({ conversationKey, projectId, timeline, lastMessage, scrollRef });

  // ── Scrolling ───────────────────────────────────────────────────────────
  useEffect(() => void (nearBottomRef.current = true), [projectId]);
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
  // A settled reply (answered or failed: see chatReplies) is not typing.
  const replySettled = isReplySettled(lastMessage?.replyStatus);
  const replyStop = useReplyStop(timeline);
  const conversationTyping =
    lastMessage?.authorType === "user" && fresh && !replySettled && !(tasks ?? []).some((t: any) => t.title === lastMessage?.content);

  // A reply to a teammate's message (no @mention) is answered by that
  // teammate (chat.ts replyToChat); the ghost bubble shows who.
  const quotedResponder = (() => {
    if (!conversationTyping || !lastMessage?.quotedMessageId) return undefined;
    if (/(^|[^\w@])@\w/.test(lastMessage.content ?? "")) return undefined;
    const quoted = timeline.find((m: any) => m._id === lastMessage.quotedMessageId);
    const agent = quoted?.authorType === "agent" ? agents.find((a: any) => a._id === quoted.agentId) : undefined;
    return agent && !/^(cto|architect)$/i.test(agent.role ?? "") ? agent : undefined;
  })();

  const taskTitle = (taskId: string) =>
    (tasks ?? []).find((task) => task._id === taskId)?.title ?? "task";
  const taskFromPlan = (content: string) => content.match(/^Plan dibuat\. Task (\S+)/)?.[1];
  const replyToTask = new Map<string, string>();
  for (const m of messages ?? []) {
    const taskId = (m as any).taskId ?? taskFromPlan((m as any).content ?? "");
    if ((m as any).replyToMessageId && taskId) replyToTask.set((m as any).replyToMessageId, taskId);
  }
  // A task is created from the preceding user message, but the CTO's reply
  // often has neither taskId nor an assignment card. Link that whole reply
  // chain so the live task card renders directly under the CTO message.
  for (const task of tasks ?? []) {
    const command = String((task as any).command ?? (task as any).title ?? "").trim();
    const anchor = (messages ?? []).find(
      (m: any) =>
        m.authorType === "user" &&
        (String(m.content ?? "").trim() === command ||
          (command.length > 0 && command.startsWith(String(m.content ?? "").trim())))
    );
    if (!anchor) continue;
    replyToTask.set(anchor._id, task._id);
    // Every reply in that chain belongs to the same task block, including
    // the CTO message that has neither taskId nor assignment card.
    for (const m of messages ?? []) {
      if ((m as any).replyToMessageId === anchor._id) replyToTask.set(m._id, task._id);
    }
  }
  const blockKey = (m: any) => m.taskId ?? replyToTask.get(m._id) ?? taskFromPlan(m.content ?? "") ?? "conversation";

  // ── Composer: draft, mentions, queue, target ("To <Agent>") ────────────
  const [draft, setDraft] = useState("");
  // "Reply": the message the next send quotes (quote bar above the composer).
  const [quote, setQuote] = useState<ChatQuote | null>(null);
  useEffect(() => setQuote(null), [projectId]);
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
      // No default receiver (O4): un-mentioned messages go to the team and the server routes them.
      return stored && agents.some((a) => a._id === stored) ? stored : null;
    });
  }, [agents, projectId]);
  const setTargetId = (id: string | null) => {
    setTargetIdState(id);
    try {
      if (id) localStorage.setItem(TARGET_KEY(projectId), id);
      else localStorage.removeItem(TARGET_KEY(projectId));
    } catch {
      /* storage denied */
    }
  };
  const targetAgent = agents.find((a) => a._id === targetId);

  const mentions = useDraftMentions(draft, setDraft, project, projectFiles, agents);
  const recipientsFor = (_content?: string): string[] | undefined => {
    // Only ids picked from the mention list; never parsed out of the text.
    if (mentions.mentionedIds.length) return mentions.mentionedIds;
    return targetId ? [targetId] : undefined;
  };
  const queue = useChatQueue(
    async (content, queueId) => {
      // The queue row id doubles as the client id: a retried row never sends twice.
      await sendMessage({ projectId: projectId as any, content, preferredAgentIds: recipientsFor(content) as any, permissionMode, ...(modelChoice ? { preferredModelRowId: modelChoice as never } : {}), clientId: queueId });
    },
    (message) => setChatError(message),
  );

  const clearDraft = () => { setDraft(""); mentions.clearMentions(); return true; };
  const addToQueue = async (composed?: string) => {
    const text = (composed ?? draft).trim();
    if (!text) return false;
    queue.add(await mentions.attachMentionedFiles(text));
    return clearDraft();
  };

  const handleChooseProposal = async (choice: string) => {
    setChatSending(true);
    try {
      await sendMessage({ projectId: projectId as any, content: choice, preferredAgentIds: recipientsFor(choice) as any, permissionMode, ...(modelChoice ? { preferredModelRowId: modelChoice as never } : {}) });
    } catch (err) {
      toast("error", "Failed to select option", err instanceof Error ? err.message : "Error");
    } finally {
      setChatSending(false);
    }
  };

  // The tray's item list and action runner are scoped to this chat; the
  // composer uses sendToTray to answer/decline the active item with text.
  const {
    tray, trayBusy, trayConfirm, setTrayConfirm, runTrayAction, sendToTray,
  } = useDecisionTrayActions({
    decisions, agents, timeline, currentConversationId, boundTo, onSelectTask,
    chooseProposal: handleChooseProposal,
    approve, reject, respondCommand, answerQuestion,
  });

  /** "Create task" under a reply: the pick (if any) plus the reply become the task;
   *  its @Role mentions and the offer's assignee own it (pool resolved by the server). */
  const createTaskFromMessage = async (messageId: string) => {
    const list = timeline as any[];
    const at = list.findIndex((m) => String(m._id) === messageId);
    const reply = list[at];
    if (!reply) return;
    // Same composition as a "gas" reply: the request this reply answers
    // (never a meta follow-up like "kok bikin task?") plus the reply.
    const { command, title, pick } = composeOfferedTask(
      list.map((m) => ({
        authorType: String(m.authorType ?? ""),
        content: String(m.content ?? ""),
        ...(m.taskOffer ? { taskOffer: m.taskOffer } : {}),
      })),
      at,
    );
    // The server already resolved the offer's assignee; no text parsing.
    const assignees = reply.taskOffer?.assigneeAgentId ? [reply.taskOffer.assigneeAgentId] : [];
    try {
      const taskId = await createTask({
        projectId: projectId as never,
        permissionMode,
        command,
        title,
        conversationContext: false,
        // Marks the reply's offer used: the button becomes "Task created".
        offerMessageId: messageId as never,
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

  const { runSlash, skillFor, slashEntries } = useProjectSlash({
    projectId,
    agents,
    permissionMode,
    conversationId: (activeConversation as any)?.conversation?._id,
    pendingItems,
    mentions,
    createTask,
    sendMessage,
    setChatError,
    onSelectTask,
  });

  // `composed`: the whole message from the composer when it carries text attachments.
  const sendImmediately = async (composed?: string) => {
    const text = (composed ?? draft).trim();
    if (!text) return false;
    setChatError("");
    setChatSending(true);
    try {
      if (await sendToTray(text)) return clearDraft();
      if (!(await runSlash(text))) {
        const content = await mentions.attachMentionedFiles(text);
        await sendMessage({
          projectId: projectId as any,
          content,
          preferredAgentIds: recipientsFor(content) as any,
          permissionMode,
          ...(modelChoice ? { preferredModelRowId: modelChoice as never } : {}),
          ...(quote ? { quotedMessageId: quote.messageId as any } : {}), ...(skillFor(text) ?? {}),
        });
      }
      setQuote(null);
      clearDivider();
      return clearDraft();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Failed to send");
      return false;
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

  // Show a teammate as drafting only when the recipient is identifiable.
  // An unaddressed team message is routed by the backend, so don't mark every
  // agent as thinking while that route is still unknown to the client.
  const mentionedDraftIds = conversationTyping ? (lastMessage?.replyOptions?.preferredAgentIds ?? []) : [];
  const mentionedDraftAgent = mentionedDraftIds.length
    ? agents.find((agent: any) => agent._id === mentionedDraftIds[0])
    : undefined;
  const draftingAgent = quotedResponder ?? mentionedDraftAgent ?? targetAgent;
  const draftingIds = conversationTyping && draftingAgent ? [draftingAgent._id] : [];
  useEffect(() => {
    dispatchChatTyping({ agentIds: draftingIds as string[], active: draftingIds.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-announce only when typing, target or team change
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when the typing state flips
  }, [conversationTyping]);

  // ── Header data ────────────────────────────────────────────────────────
  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId) as any;
  // Branch pill: the selected task's branch, else the newest in-flight task's.
  const branchTask =
    (selectedTask?.branchName ? selectedTask : null) ??
    [...(tasks ?? [])]
      .filter((t: any) => t.branchName && !isClosedStatus(t.status))
      .sort((a: any, b: any) => (b.updatedAt ?? b._creationTime) - (a.updatedAt ?? a._creationTime))[0];
  const branch = branchTask ? { name: branchTask.branchName as string, taskId: branchTask._id as string } : null;
  const openTaskCount = (tasks ?? []).filter((t: any) => !isClosedStatus(t.status)).length;
  const docked = useMemo(() => dockTasks((tasks ?? []) as any[], currentConversationId), [tasks, currentConversationId]);

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

  // Bell = this project's slice of "Needs you" (one server definition,
  // shell.ts): pending approvals on open tasks, agent questions, pushes,
  // PR notifications. A decided approval leaves at once.
  const projectNeedsYou = useQuery(api.shell.needsYou, { projectId: projectId as any });
  const notifications: HeaderNotification[] = (projectNeedsYou?.items ?? []).map((item) => ({
    key: item.key,
    title: item.title,
    meta: `${item.agentRole ? roleLabel(item.agentRole) : item.projectName} · ${item.note ?? formatMessageTime(item.at)}`,
    ...(item.approvalId ? { approvalId: item.approvalId as string } : {}),
    ...(item.taskId ? { taskId: item.taskId as string } : {}),
  }));

  // Dismissible agent-error banners for the selected task.
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const dismissedKey = `fhara-dismissed-errors-${projectId}`;
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
      setQuote(null);
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
      if (action === "approve") await approve({ approvalId: approvalId as any, ...boundTo(approvalId) });
      else await reject({ approvalId: approvalId as any, ...boundTo(approvalId) });
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
        project={project as any} conversation={(activeConversation as any)?.conversation ?? null}
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
        onManage={() => project && setManageOpen(true)}
        onClearChat={() =>
          setClearConfirm({
            title: "Clear this chat?",
            message: "Every chat message in this project will be deleted, except pinned messages. Tasks themselves are kept.",
            confirmLabel: "Clear chat",
            onOk: () => void confirmClearChat(),
          })
        }
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
                <span className="font-semibold">{failureKindLabel(event.payload?.failureKind)}:</span> {event.payload?.message ?? "Task failed to process."}
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
            showActivityGroups={false}
            history={history}
            scrollToMessageRef={scrollToMessageRef}
            chatSending={chatSending}
            conversationTyping={conversationTyping}
            typingAgent={draftingAgent}
            onSelectTask={onSelectTask}
            approve={(approvalId) => approve({ approvalId: approvalId as any, ...boundTo(approvalId) })}
            reject={(approvalId) => reject({ approvalId: approvalId as any, ...boundTo(approvalId) })}
            hold={(approvalId) => hold({ approvalId: approvalId as any })}
            respond={(approvalId, decision) => respondCommand({ approvalId: approvalId as any, decision, ...boundTo(approvalId) })}
            togglePin={(messageId, pinned) => void togglePin({ messageId: messageId as never, pinned })}
            onPickProposal={(choice) => void handleChooseProposal(choice)}
            onCreateTaskFrom={createTaskFromMessage}
            onReply={(m) => setQuote(quoteOf(m, agents))}
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
          className="absolute bottom-36 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-panel text-ink-2 shadow-lg outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}

      <ConfirmDialog request={clearConfirm} pending={clearPending} onCancel={() => setClearConfirm(null)} onConfirm={() => clearConfirm?.onOk()} />
      <ConfirmDialog request={trayConfirm} pending={trayBusy !== null} onCancel={() => setTrayConfirm(null)} onConfirm={() => trayConfirm?.onOk()} />
      {manageOpen && project && (
        <ManageProjectModal projectId={projectId} project={project as any} allAgents={(allAgents ?? []) as any[]} onClose={() => setManageOpen(false)} />
      )}

      {tab === "chat" && (
        <>
          <AutomationHoldLine />
          <DecisionsTray tray={tray} busy={trayBusy} onAction={(item, action) => void runTrayAction(item, action)} />
          {conversationId && (conversationClosed || conversationId !== currentConversationId) ? (
            <p role="status" className="shrink-0 border-t border-line bg-panel px-4 py-3 text-[13px] text-ink-3 sm:px-9 lg:px-11">
              This conversation is no longer active.{" "}
              <Link href={`/project/${projectId}`} className="text-ink-2 hover:text-ink">Open the project chat</Link>
            </p>
          ) : <ChatComposer
            placeholder={tray.active ? trayPlaceholder(tray.current) : undefined}
            onKeyIntercept={(e) => {
              if (!tray.active || !tray.current) return false;
              if (e.key === "Escape") {
                e.preventDefault();
                tray.setCollapsed(true);
                return true;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.altKey && !draft.trim()) {
                const primary = tray.current.actions.find((a) => a.primary);
                if (!primary || trayBusy) return false;
                e.preventDefault();
                void runTrayAction(tray.current, primary);
                return true;
              }
              return false;
            }}
            draft={draft}
            onDraftChange={mentions.handleInput}
            onSend={sendImmediately}
            onQueue={addToQueue}
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
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionModeChoice}
            models={modelOptions}
            modelId={modelChoice}
            onModelChange={setModelChoice}
            quote={quote}
            onCancelQuote={() => setQuote(null)}
            slashCommands={slashEntries}
            stop={replyStop}
            dock={<TaskDock tasks={docked} agents={agents} onOpenTask={onSelectTask} projectId={projectId} />}
          />}
          {decisions?.pickup && !decisions.pickup.workerOnline && decisions.pickup.queuedTasks + decisions.pickup.pendingMessages > 0 && (
            <p role="status" className="-mt-2 shrink-0 bg-panel px-4 pb-2 text-[12.5px] text-ink-3 sm:px-9 lg:px-11">
              Waiting for a worker to pick this up… no worker is online yet.
            </p>
          )}
        </>
      )}
    </main>
  );
}
