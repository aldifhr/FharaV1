"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Menu, Trash2 } from "lucide-react";
import { iconButtonClass } from "../shell/usePopover";
import { api } from "@/api/convex/_generated/api";
import { composeOfferedTask } from "@/api/convex/lib/chat/intent";
import { newClientId, optimisticUserRow, reconcileOptimistic, withOptimisticRow } from "@/lib/optimisticChat";
import { agentRoleText, roleLabel } from "@/lib/agentRoles";
import { clockTime, isSameDay, shortDate } from "@/lib/format";
import { conversationKindLabel, personalDraftKey, personalEmptyText } from "@/lib/personalChat";
import { skillInvocation, skillsUsedBy, slashMenuEntries } from "@/lib/slashMenu";
import { usePersonalAttachEnabled } from "@/lib/personalAttachPref";
import { useToast } from "../Toasts";
import ConfirmDialog, { type ConfirmRequest } from "../ConfirmDialog";
import ChatComposer from "./ChatComposer";
import MessageList from "./MessageList";
import { quoteOf, type ChatQuote } from "./QuoteBlock";
import { useChatQueue } from "./useChatQueue";
import AttachProjectDialog from "./AttachProjectDialog";
import { useMessageHistory } from "@/lib/useMessageHistory";

const NO_SUBTASKS = new Map<string, any[]>();
const NONE: any[] = [];

/**
 * One-to-one chat with one agent (plan 039). A thin wrapper around the
 * project chat's MessageList and ChatComposer: one responder (the
 * conversation's agent), no target switcher, no @mentions, no decisions
 * tray. Messages carry no projectId; the scope comes from the conversation
 * row. Create task and /task appear only once a project is attached.
 */
export default function PersonalChatPanel({
  conversationId,
  onNewChat,
  onOpenSidebar,
}: {
  conversationId: string;
  /** Called with the fresh conversation id after "New chat". */
  onNewChat: (conversationId: string) => void;
  /** Phone: open the sidebar drawer (projects, personal messages, team). */
  onOpenSidebar?: () => void;
  /** Desktop: the sidebar is hidden, so offer to bring it back. */
}) {
  const toast = useToast();
  const router = useRouter();
  const conversation = useQuery(api.conversations.get, { conversationId: conversationId as never });
  const live = useQuery(api.messages.listByConversation, { conversationId: conversationId as never });
  const { rows: messages, history } = useMessageHistory({ kind: "conversation", conversationId }, live);
  const project = conversation?.project ?? null;
  const tasks = useQuery(api.tasks.listByProject, project ? { projectId: project._id } : "skip");
  const togglePin = useMutation(api.messages.togglePin);
  const startNew = useMutation(api.conversations.startNewPersonal);
  const deleteChat = useMutation(api.conversations.removePersonal);
  const createTask = useMutation(api.tasks.createFromCommand);
  const allSkills = useQuery(api.skills.list, {});
  const sendMutation = useMutation(api.messages.sendInConversation).withOptimisticUpdate((store, args) => {
    if (!args.clientId) return;
    const listArgs = { conversationId: args.conversationId };
    const current = store.getQuery(api.messages.listByConversation, listArgs);
    if (current === undefined) return;
    const row = optimisticUserRow(
      {
        conversationId: args.conversationId as string,
        content: args.content,
        clientId: args.clientId,
        ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId as string } : {}),
      },
      Date.now(),
    );
    store.setQuery(api.messages.listByConversation, listArgs, withOptimisticRow(current as any[], row as any) as any);
  });
  const send = useCallback(
    (content: string, extra: { quotedMessageId?: string; clientId?: string; invokedSkills?: string[] } = {}) =>
      sendMutation({
        conversationId: conversationId as never,
        content,
        clientId: extra.clientId ?? newClientId(),
        ...(extra.quotedMessageId ? { quotedMessageId: extra.quotedMessageId as never } : {}),
        ...(extra.invokedSkills?.length ? { invokedSkills: extra.invokedSkills } : {}),
      }),
    [sendMutation, conversationId],
  );

  const agent = conversation?.agent ?? null;
  const agentRow = useMemo(
    () => (agent ? { _id: agent.agentId as string, name: agent.name, role: agent.role, status: agent.status, avatarParams: agent.avatarParams } : null),
    [agent],
  );
  const agents = useMemo(() => (agentRow ? [agentRow] : []), [agentRow]);
  const agentName = agent ? agent.name || roleLabel(agent.role) : "this agent";
  const attached = Boolean(project);
  const closed = conversation?.status !== undefined && conversation.status !== "active";

  const timeline = useMemo(
    () =>
      reconcileOptimistic((messages ?? []) as any[])
        .filter((m: any) => !m.taskId || m.card)
        .sort((a: any, b: any) => a._creationTime - b._creationTime),
    [messages],
  );
  const lastMessage = timeline[timeline.length - 1] as any;

  // ── Draft, kept per conversation ────────────────────────────────────────
  const [draft, setDraftState] = useState("");
  useEffect(() => {
    try {
      setDraftState(localStorage.getItem(personalDraftKey(conversationId)) ?? "");
    } catch {
      setDraftState("");
    }
  }, [conversationId]);
  const setDraft = (value: string) => {
    setDraftState(value);
    try {
      if (value) localStorage.setItem(personalDraftKey(conversationId), value);
      else localStorage.removeItem(personalDraftKey(conversationId));
    } catch {
      /* storage denied */
    }
  };
  const [quote, setQuote] = useState<ChatQuote | null>(null);
  useEffect(() => setQuote(null), [conversationId]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [chatError, setChatError] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachEnabled] = usePersonalAttachEnabled();
  const [newConfirm, setNewConfirm] = useState<ConfirmRequest | null>(null);
  const [newPending, setNewPending] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ConfirmRequest | null>(null);
  // Set while a deleted chat hands off to a fresh one, so the reactive
  // "conversation === null" read never shows the dead-end in between.
  const [leaving, setLeaving] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const queue = useChatQueue(
    async (content, queueId) => {
      await send(content, { clientId: queueId });
    },
    (message) => setChatError(message),
  );

  // ── Scrolling ───────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollToMessageRef = useRef<((messageId: string) => boolean) | null>(null);
  const nearBottomRef = useRef(true);
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
    nearBottomRef.current = true;
  }, [conversationId]);
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom();
  }, [timeline.length, lastMessage?._id]);

  // ── Typing (same time-bounded rule as the project chat) ─────────────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const fresh = lastMessage ? now - lastMessage._creationTime < 300_000 : false;
  const replySettled = lastMessage?.replyStatus === "answered" || lastMessage?.replyStatus === "failed";
  const conversationTyping = lastMessage?.authorType === "user" && fresh && !replySettled;

  const wasTypingRef = useRef(false);
  const queuedCount = queue.items.filter((m) => m.status === "queued").length;
  useEffect(() => {
    const wasTyping = wasTypingRef.current;
    wasTypingRef.current = conversationTyping;
    if (wasTyping && !conversationTyping && queuedCount > 0) {
      const timer = setTimeout(() => void sendAllQueued(), 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when the typing state flips
  }, [conversationTyping]);

  const formatTime = (createdAt: number) => {
    if (now - createdAt < 60_000) return "just now";
    const hm = clockTime(createdAt);
    return isSameDay(createdAt, now) ? hm : `${shortDate(createdAt)}, ${hm}`;
  };
  const taskTitle = (taskId: string) => (tasks ?? []).find((t: any) => t._id === taskId)?.title ?? "task";
  const openTask = (taskId: string) => {
    if (project) router.push(`/chats/${project._id}?task=${taskId}`);
  };

  // ── Tasks: only after attach (D5), always explicit ──────────────────────
  const createTaskFromMessage = async (messageId: string) => {
    if (!project) return;
    const list = timeline as any[];
    const at = list.findIndex((m) => String(m._id) === messageId);
    if (at < 0) return;
    const { command, title, pick } = composeOfferedTask(
      list.map((m) => ({
        authorType: String(m.authorType ?? ""),
        content: String(m.content ?? ""),
        ...(m.taskOffer ? { taskOffer: m.taskOffer } : {}),
      })),
      at,
    );
    try {
      const taskId = await createTask({
        projectId: project._id,
        command,
        title,
        conversationContext: false,
        conversationId: conversationId as never,
        // Marks the reply's offer used: the button becomes "Task created".
        offerMessageId: messageId as never,
        ...(list[at].taskOffer?.assigneeAgentId ? { assignedAgentIds: [list[at].taskOffer.assigneeAgentId] as never[] } : {}),
      });
      toast("success", "Task created", pick ?? undefined);
      openTask(taskId as string);
    } catch (err) {
      toast("error", "Couldn't create the task", err instanceof Error ? err.message : undefined);
      throw err;
    }
  };

  /** /task once a project is attached. Without one the text goes to the agent, which explains. */
  const runSlash = async (text: string): Promise<boolean> => {
    const match = text.match(/^\/task\b\s*([\s\S]*)$/i);
    if (!match || !project) return false;
    const rest = match[1].trim();
    if (!rest) {
      setChatError("Describe the task after /task.");
      return true;
    }
    const taskId = await createTask({ projectId: project._id, command: rest, conversationId: conversationId as never });
    toast("success", "Task created", rest.slice(0, 80));
    openTask(taskId as string);
    return true;
  };

  // `composed`: the whole message from the composer when it carries text attachments.
  const sendImmediately = async (composed?: string) => {
    const text = (composed ?? draft).trim();
    if (!text || closed) return false;
    setChatError("");
    setChatSending(true);
    try {
      if (!(await runSlash(text))) {
        nearBottomRef.current = true;
        // Paradev C3: "/<skill> [request]" invokes one of this agent's skills.
        await send(text, { ...(quote ? { quotedMessageId: quote.messageId } : {}), ...(skillInvocation(text, slashCommands) ?? {}) });
      }
      setQuote(null);
      setDraft("");
      return true;
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Failed to send");
      return false;
    } finally {
      setChatSending(false);
    }
  };
  const addToQueue = (composed?: string) => {
    const text = (composed ?? draft).trim();
    if (!text) return false;
    queue.add(text);
    setDraft("");
    return true;
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
  const handlePick = async (choice: string) => {
    setChatSending(true);
    try {
      await send(choice);
    } catch (err) {
      toast("error", "Failed to select option", err instanceof Error ? err.message : "Error");
    } finally {
      setChatSending(false);
    }
  };

  const confirmNewChat = async () => {
    if (!agent) return;
    setNewPending(true);
    try {
      const nextId = await startNew({ agentId: agent.agentId });
      queue.clear();
      setQuote(null);
      setNewConfirm(null);
      onNewChat(nextId as string);
    } catch (err) {
      toast("error", "Couldn't start a new chat", err instanceof Error ? err.message : undefined);
    } finally {
      setNewPending(false);
    }
  };

  const confirmDeleteChat = async () => {
    setDeletePending(true);
    // Captured first: the agent row comes from the conversation, which is
    // gone once the delete lands.
    const agentId = agent?.agentId;
    setLeaving(true);
    try {
      await deleteChat({ conversationId: conversationId as never });
      try {
        localStorage.removeItem(personalDraftKey(conversationId));
      } catch {
        /* storage denied */
      }
      queue.clear();
      setDeleteConfirm(null);
      setDeletePending(false);
      toast("success", "Chat deleted");
      // Land on a new chat with the same agent; if that can't start (agent
      // disabled), on the Personal messages list instead of a dead end.
      try {
        if (!agentId) throw new Error("no agent");
        const nextId = await startNew({ agentId: agentId as never });
        setQuote(null);
        onNewChat(nextId as string);
      } catch {
        router.replace("/messages");
      }
      setLeaving(false);
    } catch (err) {
      setLeaving(false);
      toast("error", "Couldn't delete the chat", err instanceof Error ? err.message : undefined);
      setDeletePending(false);
    }
  };

  // "/" menu: the registry's personal builtins (/task once a project is
  // attached), then this agent's skills (callable since Paradev C3).
  const personalAgentId = agent?.agentId;
  const slashCommands = useMemo(
    () => slashMenuEntries("personal", skillsUsedBy((allSkills ?? []) as any[], personalAgentId ? [personalAgentId] : []), { attached }),
    [allSkills, personalAgentId, attached],
  );

  if (leaving && (conversation === null || conversation === undefined)) {
    return (
      <p className="mx-auto w-full max-w-3xl px-6 py-10 text-[13px] text-ink-3" role="status">
        Opening a new chat…
      </p>
    );
  }

  if (conversation === null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <p className="text-[14px] text-ink-2">This chat no longer exists.</p>
        <Link href="/messages" className="mt-3 inline-block text-[13px] text-ink-3 hover:text-ink">
          Back to personal messages
        </Link>
      </div>
    );
  }

  return (
    <main className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <header className="shrink-0 border-b border-line px-4 pb-4 pt-6 sm:px-6">
        {onOpenSidebar && (
          <div className="-ml-1 -mt-2 mb-1 flex items-center gap-1 min-[980px]:hidden">
            <button type="button" onClick={onOpenSidebar} aria-label="Open sidebar" className={iconButtonClass}>
              <Menu size={18} />
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-[26px] font-semibold tracking-tight text-ink">{conversation ? agentName : "Loading…"}</h1>
            <p className="mt-1 text-[13px] text-ink-3">
              {conversation ? conversationKindLabel(conversation.kind as any, project?.name) : "\u00a0"}
              {agent && agentRoleText(agent) ? ` · ${agentRoleText(agent)}` : ""}
            </p>
          </div>
          {conversation && (
            <div className="flex items-center gap-2">
              {!attached && !closed && attachEnabled && (
                <button
                  type="button"
                  onClick={() => setAttachOpen(true)}
                  className="h-[30px] rounded-lg border border-line px-3 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                >
                  Attach project
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setDeleteConfirm({
                    title: "Delete this chat?",
                    message: `All messages in this chat with ${agentName} are deleted and cannot be recovered. Tasks created here stay on their project board.`,
                    confirmLabel: "Delete chat",
                    icon: "trash",
                    tone: "danger",
                  })
                }
                aria-label="Delete chat"
                title="Delete chat"
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-line text-ink-3 outline-none transition hover:border-red-300 hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-ink/30 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              >
                <Trash2 size={15} />
              </button>
              <button
                type="button"
                onClick={() =>
                  setNewConfirm({
                    title: "Start a new chat?",
                    message: `This chat with ${agentName} is closed and a fresh one opens. The old messages are kept but no longer shown here.`,
                    confirmLabel: "New chat",
                    icon: "restore",
                    tone: "neutral",
                  })
                }
                className="h-[30px] rounded-lg bg-ink px-3 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                New chat
              </button>
            </div>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
        }}
        className="shell-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2 sm:px-6"
      >
        {messages !== undefined && timeline.length === 0 && !conversationTyping ? (
          <p className="py-16 text-center text-[14px] text-ink-3">{personalEmptyText(agentName, project?.name)}</p>
        ) : (
          <MessageList
            timeline={timeline}
            scrollRef={scrollRef}
            firstNewIndex={-1}
            agents={agents}
            tasks={(tasks ?? NONE) as any[]}
            subtasksOf={NO_SUBTASKS}
            pendingItems={NONE}
            projectApprovalMode="ask"
            loading={messages === undefined}
            history={history}
            scrollToMessageRef={scrollToMessageRef}
            chatSending={chatSending}
            conversationTyping={conversationTyping}
            typingAgent={agentRow ?? undefined}
            onSelectTask={openTask}
            approve={() => undefined}
            reject={() => undefined}
            hold={() => undefined}
            togglePin={(messageId, pinned) => void togglePin({ messageId: messageId as never, pinned })}
            onPickProposal={(choice) => void handlePick(choice)}
            onCreateTaskFrom={attached ? createTaskFromMessage : undefined}
            onReply={(m) => setQuote(quoteOf(m, agents))}
            formatTime={formatTime}
            taskTitle={taskTitle}
            blockKey={() => "conversation"}
          />
        )}
      </div>

      {closed ? (
        <p className="shrink-0 border-t border-line px-6 py-4 text-[13px] text-ink-2">This chat is closed. Start a new chat to keep talking to {agentName}.</p>
      ) : (
        <ChatComposer
          placeholder={`Message ${agentName}`}
          draft={draft}
          onDraftChange={setDraft}
          onSend={sendImmediately}
          onQueue={addToQueue}
          sending={chatSending}
          error={chatError}
          mention={null}
          mentionResults={NONE}
          agentResults={NONE}
          onInsertMention={() => undefined}
          onInsertAgent={() => undefined}
          onDismissMention={() => undefined}
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
          projectName={agentName}
          targets={NONE}
          targetId={agentRow?._id ?? null}
          onTargetChange={() => undefined}
          quote={quote}
          onCancelQuote={() => setQuote(null)}
          slashCommands={slashCommands}
        />
      )}

      <ConfirmDialog request={newConfirm} pending={newPending} onCancel={() => setNewConfirm(null)} onConfirm={() => void confirmNewChat()} />
      <ConfirmDialog request={deleteConfirm} pending={deletePending} onCancel={() => setDeleteConfirm(null)} onConfirm={() => void confirmDeleteChat()} />
      {attachOpen && agentRow && (
        <AttachProjectDialog conversationId={conversationId} agent={agentRow} onClose={() => setAttachOpen(false)} />
      )}
    </main>
  );
}
