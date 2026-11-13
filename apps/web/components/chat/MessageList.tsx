"use client";

import { motion } from "framer-motion";
import { Pin } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { parseOptions } from "@/lib/options";
import { roleLabel } from "@/lib/agentRoles";
import { isOfferUsed, offersCreateTask } from "@/lib/taskOffer";
import ApprovalCard from "../ApprovalCard";
import QaPanel from "../QaPanel";
import { ReasoningLine } from "../ui/trace";
import MessageText from "./MessageText";
import OptionCards from "./OptionCards";
import ActivityTimeline, { hasActivityTimeline } from "./ActivityTimeline";
import TaskCard from "./TaskCard";
import ChatCard from "./cards/ChatCard";
import { CardSurfaceProvider } from "./cards/CardContext";
import { qaStatusLine } from "./cards/QaCard";
import { SectionLoading } from "@/app/WorkspaceContext";
import { groupActivity, groupByIndex } from "@/lib/activityGroups";
import ActivityGroupRow from "./ActivityGroupRow";
import { useToast } from "../Toasts";
import { QuotedSnippet, quoteOf } from "./QuoteBlock";
import { ChatOpinionLine, useChatOpinions, useRequestMessageOpinion } from "../review/Reviewer";
import ContextDrawer from "../context/ContextDrawer";
import ReplyInterrupted, { ReplyCutOff, ReplyStopped } from "./ReplyInterrupted";
import { CheckedFilesLine, checkedFilesLabel, delegationParts, messageKindOf } from "./messageKinds";
import SystemLineRow from "./SystemLineRow";
import { systemLineText } from "@/lib/systemLine";
import HistoryBar from "./HistoryBar";
import { CreateTaskButton, MessageActions, TaskCreatedLink } from "./MessageActions";
import type { MessageHistory } from "@/lib/useMessageHistory";

/** References the reply cites that no repo check in it showed: one quiet line, never hidden. */
const UNVERIFIED_SHOWN = 6;
function unverifiedRefsLabel(refs: string[]): string {
  const shown = refs.slice(0, UNVERIFIED_SHOWN).join(", ");
  const more = refs.length - UNVERIFIED_SHOWN;
  return `Unverified: ${shown}${more > 0 ? ` +${more} more` : ""}`;
}

function UnverifiedRefsLine({ refs }: { refs: string[] }) {
  return (
    <p
      className="mt-0.5 max-w-3xl truncate pl-1 text-[12px] text-ink-3"
      title={`Not seen in any repo check for this reply:\n${refs.join("\n")}`}
    >
      {unverifiedRefsLabel(refs)}
    </p>
  );
}

/** Below this many timeline items the plain list is cheaper than the
 *  virtualizer bookkeeping; above it, only the visible window renders. */
const VIRTUALIZE_THRESHOLD = 40;

type Props = {
  timeline: any[];
  firstNewIndex: number;
  agents: any[];
  tasks?: any[];
  subtasksOf: Map<string, any[]>;
  pendingItems: any[];
  projectEvents?: any[];
  projectApprovalMode: "ask" | "auto";
  /** Messages query still loading: show a skeleton, not "No messages yet". */
  loading?: boolean;
  chatSending: boolean;
  conversationTyping: boolean;
  /** Agent expected to answer the pending user message (ghost bubble). */
  typingAgent?: any;
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Filled with a function that scrolls a message into view (works for
   *  virtualized rows that are not in the DOM). Returns false if absent. */
  scrollToMessageRef?: MutableRefObject<((messageId: string) => boolean) | null>;
  onSelectTask: (taskId: string) => void;
  approve: (approvalId: string) => unknown;
  reject: (approvalId: string) => unknown;
  hold: (approvalId: string) => unknown;
  /** Command approvals: Allow / Always allow / Deny (same rows as the composer tray). */
  respond?: (approvalId: string, decision: "allow" | "always" | "always_exact" | "deny") => unknown;
  togglePin: (messageId: string, pinned: boolean) => void;
  onPickProposal: (choice: string) => void;
  /** Turns an agent's recommendation into a task (button under it). */
  onCreateTaskFrom?: (messageId: string) => Promise<unknown>;
  /** "Reply": quote this message in the composer. */
  onReply?: (message: any) => void;
  formatTime: (createdAt: number) => string;
  taskTitle: (taskId: string) => string;
  blockKey: (m: any) => string;
  /** D12: "Load earlier" and the turn outline for a long thread. */
  history?: MessageHistory;
};

export default function MessageList(props: Props) {
  const {
    timeline, firstNewIndex, agents, tasks = [], subtasksOf, pendingItems, projectEvents = [],
    projectApprovalMode, loading = false, chatSending,
    conversationTyping, typingAgent, scrollRef, scrollToMessageRef,
    onSelectTask, approve, reject, hold, respond, togglePin, onPickProposal, onCreateTaskFrom, onReply, formatTime, taskTitle, blockKey, history,
  } = props;

  const listRef = useRef<HTMLDivElement>(null);
  // Reviewer second opinions on chat replies (one subscription per chat).
  const chatProjectId = (timeline.find((m: any) => m.projectId) as any)?.projectId as string | undefined;
  const opinions = useChatOpinions(chatProjectId);
  const requestOpinion = useRequestMessageOpinion();
  // Context Inspector drawer for one agent reply (its LLM calls).
  const [inspectId, setInspectId] = useState<string | null>(null);
  // A reply is live while the action streams it. The age cap keeps a row
  // from an action that died mid-stream from animating forever.
  const isLive = (m: any) =>
    m.authorType === "agent" && m.streaming === true && !m.interrupted && Date.now() - m._creationTime < 180_000;
  // Durable replies: user messages whose dead reply already shows its own
  // "Reply interrupted" line on the agent bubble (so it is not shown twice).
  const interruptedFor = useMemo(() => {
    const ids = new Set<string>();
    for (const m of timeline) if (m.authorType === "agent" && m.interrupted && m.replyToMessageId) ids.add(String(m.replyToMessageId));
    return ids;
  }, [timeline]);
  // Stop: user messages whose stopped reply shows "Stopped" on its own bubble.
  const stoppedFor = useMemo(
    () => new Set(timeline.filter((m: any) => m.authorType === "agent" && m.stopped && m.replyToMessageId).map((m: any) => String(m.replyToMessageId))),
    [timeline],
  );

  // The newest teammate reply offers "Create task" when it answers an option
  // pick or carries a server-stored offer.
  const [taskState, setTaskState] = useState<Record<string, "busy" | "done">>({});
  const suggestTaskId = (() => {
    if (!onCreateTaskFrom) return null;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const m = timeline[i];
      if (m.authorType === "user") return null;
      if (m.authorType !== "agent" || m.card || !m.content?.trim() || m.taskId || systemLineText(m)) continue;
      if (isLive(m)) return null;
      let prevUser: any = null;
      for (let j = i - 1; j >= 0; j--) if (timeline[j].authorType === "user") { prevUser = timeline[j]; break; }
      const afterPick = /^i choose\b/i.test(prevUser?.content?.trim() ?? "");
      // The server-stored offer (the addressed or routed owner) shows the button; the reply's
      // wording alone only counts on pre-O3 CTO rows, never on a teammate merely saying "create task".
      const role = String((agents as any[])?.find((a: any) => a._id === m.agentId)?.role ?? "").toLowerCase();
      if (role !== "cto" && !m.taskOffer) continue;
      if (isOfferUsed(m.taskOffer)) return null;
      return afterPick || offersCreateTask(m) ? String(m._id) : null;
    }
    return null;
  })();
  // Plan 019: what the cards need from this surface.
  const cardSurface = useMemo(
    () => ({
      agents,
      tasks,
      subtasksOf,
      pendingApprovals: pendingItems,
      approvalMode: projectApprovalMode,
      onOpenTask: onSelectTask,
    }),
    [agents, tasks, subtasksOf, pendingItems, projectApprovalMode, onSelectTask]
  );
  // Tasks whose QA reports as a card: the older event-derived QA panel
  // would show the same checks twice.
  const tasksWithQaCard = useMemo(
    () => new Set(timeline.filter((m: any) => m.card?.kind === "qa" && m.taskId).map((m: any) => String(m.taskId))),
    [timeline]
  );
  // "QA is checking <url> at 375 px": the newest QA card still running.
  const liveQa = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const m = timeline[i];
      if (m?.card?.kind === "qa") return qaStatusLine(m.card.data);
    }
    return null;
  }, [timeline]);
  // Compact activity log: consecutive activity cards from one agent in the
  // same block collapse into one summary row (lib/activityGroups).
  const activityGroups = useMemo(
    () =>
      groupByIndex(
        groupActivity(timeline, {
          sameBlock: (a, b) => blockKey(a) === blockKey(b),
          agentLabel: (agentId) => {
            const agent = (agents as any[])?.find((a: any) => a._id === agentId);
            return agent ? roleLabel(agent.role) : undefined;
          },
        })
      ),
    [timeline, agents, blockKey]
  );
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const virtualized = timeline.length >= VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualized ? timeline.length : 0,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => 140,
    overscan: 8,
    // The list sits below error banners and padding inside the scroll
    // container; without the margin the visible range is off by that much.
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index) => blockKey(timeline[index]) + String(index),
  });

  const toast = useToast();
  // The message a jump landed on gets a brief highlight.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);
  const scrollToMessage = (messageId: string) => {
    const index = timeline.findIndex((m: any) => m._id === messageId);
    if (index < 0) return false;
    if (virtualized) {
      virtualizer.scrollToIndex(index, { align: "center" });
      // Re-run once rows are measured so the target lands centred.
      requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: "center" }));
    } else {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setFlashId(messageId);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1600);
    return true;
  };
  const scrollToMessageLatest = useRef(scrollToMessage);
  scrollToMessageLatest.current = scrollToMessage;
  const jumpToQuoted = (messageId: string) => {
    if (!scrollToMessageLatest.current(messageId)) toast("info", "That message is no longer in the loaded chat history.");
  };

  useEffect(() => {
    if (!scrollToMessageRef) return;
    scrollToMessageRef.current = (messageId: string) => scrollToMessageLatest.current(messageId);
    return () => {
      if (scrollToMessageRef) scrollToMessageRef.current = null;
    };
  }, [scrollToMessageRef]);
  // An outline jump lands once its page is in the timeline.
  useEffect(() => {
    if (history?.pendingJump && scrollToMessageLatest.current(history.pendingJump)) history.clearJump();
  }, [history, timeline]);

  // One voice: the speaker label shows only when the speaker changes.
  const speakerOf = (m: any) => (m?.authorType === "agent" && systemLineText(m) === null ? `agent:${m.agentId ?? ""}` : m ? `${m.authorType}` : "");
  const renderItem = (m: any, index: number, animate: boolean) => {
    const previous = timeline[index - 1];
    const key = blockKey(m);
    const prevKey = previous ? blockKey(previous) : null;
    // Divider marks the start of a task block (at the user's message
    // that spawned it), not a transition back to plain conversation.
    const boundary = key !== prevKey && key !== "conversation";
    const systemText = systemLineText(m);
    const showTaskCard = key !== "conversation" && m.authorType === "agent" && previous?.authorType === "user" && systemText === null;
    const messageAgent = m.authorType === "agent"
      ? (agents as any)?.find((a: any) => a._id === m.agentId)
      : undefined;
    const group = activityGroups.get(index);
    const open = group ? (groupOpen[group.id] ?? group.expandedByDefault) : true;
    const showSpeaker = boundary || speakerOf(previous) !== speakerOf(m) || Boolean(group && index === group.start);
    const rowClass = `group relative ${showSpeaker ? "mt-6" : "mt-3"} flex rounded-xl transition-colors duration-700 ${flashId === String(m._id) ? "bg-hover" : ""}`;
    const inner = (
      <>
        {index === firstNewIndex && (
          <div role="separator" aria-label="New messages" className="mb-2 mt-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-ink" />
              New
            </span>
          </div>
        )}
        {boundary && (
          <div className="mb-1 mt-7 flex items-center gap-3 text-[12px] text-ink-3">
            <span className="h-px flex-1 bg-line" />
            <span className="max-w-[60%] truncate">{taskTitle(key)}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {showTaskCard && (() => {
          const cardTask = (tasks ?? []).find((t: any) => t._id === key);
          if (!cardTask) return null;
          // Plan reviews render as their own Plan card message, not here.
          const pending = pendingItems.filter((a: any) => a.taskId === key && a.status === "pending" && a.kind !== "plan");
          const qaEvents = (projectEvents ?? []).filter((e: any) => e.taskId === key && e.type === "task.check");
          return (
            <div className="space-y-2">
              {/* An assignment card IS the task card; do not draw it twice. */}
              {m.card?.kind !== "assignment" && (
                <TaskCard
                  task={cardTask}
                  subtasks={subtasksOf.get(key) ?? []}
                  pending={pending}
                  onOpen={onSelectTask}
                  agents={agents}
                  approvalMode={projectApprovalMode}
                />
              )}
              {pending.map((a: any) => (
                <ApprovalCard
                  key={a._id}
                  approval={a}
                  agent={(agents as any)?.find((agent: any) => agent._id === a.requestedByAgentId) ?? null}
                  taskTitle={cardTask.title}
                  onApprove={approve}
                  onReject={reject}
                  onHold={hold}
                  onRespond={respond}
                  onReview={onSelectTask}
                />
              ))}
              {qaEvents.length > 0 && !tasksWithQaCard.has(String(key)) && <QaPanel events={qaEvents} />}
            </div>
          );
        })()}
        {group && index === group.start && (
          <div className="mt-4">
            <ActivityGroupRow
              group={group}
              open={open}
              onToggle={() => setGroupOpen((prev) => ({ ...prev, [group.id]: !open }))}
            />
          </div>
        )}
        {!open ? null : systemText !== null ? (
          <SystemLineRow id={`message-${m._id}`} text={systemText} time={formatTime(m._creationTime)} className="my-5" />
        ) : animate ? (
          <motion.div
            key={m._id}
            id={`message-${m._id}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.18) }}
            className={rowClass}
          >
            {renderMessageBody(m, index, messageAgent, showSpeaker)}
          </motion.div>
        ) : (
          <div
            key={m._id}
            id={`message-${m._id}`}
            className={rowClass}
          >
            {renderMessageBody(m, index, messageAgent, showSpeaker)}
          </div>
        )}
      </>
    );
    return <div key={m._id}>{inner}</div>;
  };

  const renderUserBody = (m: any) => (
    <div className="ml-auto flex min-w-0 max-w-[min(85%,42rem)] flex-col items-end">
      <div className="mb-1 flex items-center gap-1.5 pr-1 text-[12px] text-ink-3">
        {m.pinned && <Pin size={11} className="text-ink" aria-label="Pinned" />}
        <span>{formatTime(m._creationTime)}</span>
      </div>
      <div className="flex min-w-0 max-w-full items-center gap-1.5">
        {/* Optimistic bubble (not saved yet): no actions on a placeholder id. */}
        {!m.optimistic && <MessageActions
          inline
          pinned={Boolean(m.pinned)}
          messageId={m._id}
          content={m.content}
          taskId={blockKey(m) !== "conversation" ? blockKey(m) : undefined}
          onTogglePin={() => togglePin(m._id, !m.pinned)}
          onOpenTask={onSelectTask}
          onReply={onReply && m.content?.trim() ? () => onReply(m) : undefined}
          personal={!m.projectId}
        />}
        <div className="min-w-0 rounded-2xl rounded-tr-md bg-bubble px-4 py-2.5 text-ink [&_p]:my-0">
          {m.quotedMessageId && (() => {
            const quoted = timeline.find((q: any) => q._id === m.quotedMessageId);
            return <QuotedSnippet quote={quoted ? quoteOf(quoted, agents) : null} onJump={jumpToQuoted} />;
          })()}
          <MessageText content={m.content ?? ""} maskSecrets />
        </div>
      </div>
      {m.replyStatus === "failed" && !interruptedFor.has(String(m._id)) && (
        <ReplyInterrupted userMessageId={String(m._id)} reason={m.error} align="end" />
      )}
      {m.replyStatus === "stopped" && !stoppedFor.has(String(m._id)) && <ReplyStopped align="end" />}
    </div>
  );

  const renderMessageBody = (m: any, index: number, messageAgent: any, showSpeaker = true) => m.authorType !== "agent" ? renderUserBody(m) : (
    <>
      <div className="min-w-0 flex-1">
        {showSpeaker ? (
          <div className={`flex items-baseline gap-2 text-[12.5px] ${onReply ? "pr-16" : "pr-9"}`}>
            <p className="font-medium text-ink-2">{roleLabel(messageAgent?.role)}</p>
            <span className="text-ink-3">
              {formatTime(m._creationTime)}
              {(() => {
                const kind = messageKindOf(m.content);
                const tag = kind === "evaluation" ? "evaluated" : kind === "planning" ? "plan" : kind === "delegation" ? "handoff" : kind === "design" ? "design" : null;
                return tag ? ` · ${tag}` : null;
              })()}
            </span>
            {m.pinned && <Pin size={12} className="self-center text-ink" aria-label="Pinned" />}
          </div>
        ) : m.pinned ? (
          <Pin size={12} className="text-ink" aria-label="Pinned" />
        ) : null}
        <MessageActions
          pinned={Boolean(m.pinned)}
          messageId={m._id}
          content={m.content}
          taskId={blockKey(m) !== "conversation" ? blockKey(m) : undefined}
          onTogglePin={() => togglePin(m._id, !m.pinned)}
          onOpenTask={onSelectTask}
          onReply={onReply && m.content?.trim() && !isLive(m) ? () => onReply(m) : undefined}
          // Personal chat replies carry no project: no second opinion (plan 039 D8).
          onSecondOpinion={m.projectId && m.content?.trim() && !isLive(m) ? () => void requestOpinion(String(m._id)) : undefined}
          personal={!m.projectId}
        />
        {hasActivityTimeline(m) && (() => {
          // Activity timeline replaces the Thought line and the separate
          // Checked / Unverified lines for replies that carry it.
          const hasText = Boolean(m.content?.trim());
          const live = isLive(m);
          return (
            <>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <ActivityTimeline
                    message={m}
                    live={live}
                    checkedLabel={Array.isArray(m.checkedFiles) && m.checkedFiles.length > 0 ? checkedFilesLabel(m.checkedFiles) : null}
                    unverifiedLabel={Array.isArray(m.unverifiedRefs) && m.unverifiedRefs.length > 0 ? unverifiedRefsLabel(m.unverifiedRefs) : null}
                  />
                </div>
                {!live && hasText && (
                  <button
                    type="button"
                    onClick={() => setInspectId(String(m._id))}
                    className="mt-[3px] shrink-0 text-[12px] text-ink-3 hover:text-ink"
                  >
                    Inspect context
                  </button>
                )}
              </div>
              {hasText && (
                <div className="mt-1 min-w-0 max-w-3xl text-ink">
                  <MessageText content={parseOptions(m.content).text} isAnimating={live || (conversationTyping && index === timeline.length - 1)} />
                </div>
              )}
              {hasText && !live && opinions.get(String(m._id)) && <ChatOpinionLine opinion={opinions.get(String(m._id))!} />}
              {hasText && isOfferUsed(m.taskOffer) && (
                <TaskCreatedLink taskId={String(m.taskOffer.usedTaskId)} title={taskTitle(String(m.taskOffer.usedTaskId))} onOpen={onSelectTask} />
              )}
              {hasText && String(m._id) === suggestTaskId && taskState[String(m._id)] !== "done" && (
                <CreateTaskButton
                  busy={taskState[String(m._id)] === "busy"}
                  onClick={async () => {
                    const id = String(m._id);
                    setTaskState((st) => ({ ...st, [id]: "busy" }));
                    try {
                      await onCreateTaskFrom?.(id);
                      setTaskState((st) => ({ ...st, [id]: "done" }));
                    } catch {
                      setTaskState((st) => { const { [id]: _drop, ...rest } = st; return rest; });
                    }
                  }}
                />
              )}
            </>
          );
        })()}
        {!hasActivityTimeline(m) && (() => {
          const showReasoning = !m.card && (m.reasoning || !m.content?.trim());
          const showText = !(messageKindOf(m.content) === "delegation" || (m.card && !m.content?.trim()));
          if (!showReasoning && !showText) return null;
          const hasText = showText && Boolean(m.content?.trim());
          return (
            <>
              {/* Reasoning is meta, so it sits above the bubble; while the
                  reply has no text yet the bubble itself shows Thinking. */}
              {showReasoning && hasText && (
                <div className="mt-1 flex items-start gap-3">
                  <div className="min-w-0">
                    <ReasoningLine text={m.reasoning} running={false} seconds={m.reasoningDurationMs} />
                  </div>
                  {m.authorType === "agent" && !isLive(m) && (
                    <button
                      type="button"
                      onClick={() => setInspectId(String(m._id))}
                      className="mt-[3px] shrink-0 text-[12px] text-ink-3 hover:text-ink"
                    >
                      Inspect context
                    </button>
                  )}
                </div>
              )}
              {!showReasoning && hasText && m.authorType === "agent" && !isLive(m) && !m.card && !m.taskId && (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => setInspectId(String(m._id))}
                    className="text-[12px] text-ink-3 hover:text-ink"
                  >
                    Inspect context
                  </button>
                </div>
              )}
              <div className="mt-1 min-w-0 max-w-3xl text-ink">
                {hasText ? (
                  <MessageText
                    content={parseOptions(m.content).text}
                    isAnimating={isLive(m) || (conversationTyping && index === timeline.length - 1)}
                  />
                ) : (
                  <ReasoningLine text={m.reasoning} running={isLive(m)} seconds={m.reasoningDurationMs} />
                )}
              </div>
              {hasText && !isLive(m) && Array.isArray(m.checkedFiles) && m.checkedFiles.length > 0 && (
                <CheckedFilesLine files={m.checkedFiles} />
              )}
              {hasText && !isLive(m) && Array.isArray(m.unverifiedRefs) && m.unverifiedRefs.length > 0 && (
                <UnverifiedRefsLine refs={m.unverifiedRefs} />
              )}
              {hasText && !isLive(m) && opinions.get(String(m._id)) && <ChatOpinionLine opinion={opinions.get(String(m._id))!} />}
              {hasText && isOfferUsed(m.taskOffer) && (
                <TaskCreatedLink taskId={String(m.taskOffer.usedTaskId)} title={taskTitle(String(m.taskOffer.usedTaskId))} onOpen={onSelectTask} />
              )}
              {hasText && String(m._id) === suggestTaskId && taskState[String(m._id)] !== "done" && (
                <CreateTaskButton
                  busy={taskState[String(m._id)] === "busy"}
                  onClick={async () => {
                    const id = String(m._id);
                    setTaskState((st) => ({ ...st, [id]: "busy" }));
                    try {
                      await onCreateTaskFrom?.(id);
                      setTaskState((st) => ({ ...st, [id]: "done" }));
                    } catch {
                      setTaskState((st) => { const { [id]: _drop, ...rest } = st; return rest; });
                    }
                  }}
                />
              )}
            </>
          );
        })()}
        {m.interrupted && m.replyToMessageId && <ReplyInterrupted userMessageId={String(m.replyToMessageId)} />}
        {m.stopped && <ReplyStopped />}
        {m.cutOff && !m.streaming && <ReplyCutOff messageId={String(m._id)} reason={m.cutOff.reason} />}
        {m.card && (
          <div className="mt-2 max-w-3xl">
            <ChatCard card={m.card} />
          </div>
        )}
        {(() => {
          if (m.authorType !== "agent") return null;
          const { options } = parseOptions(m.content);
          if (options.length === 0) return null;
          const next = timeline[index + 1];
          const pickedMsg = next?.authorType === "user" ? (next.content ?? "") : "";
          // Only the explicit "I choose <id>" form counts: a title substring
          // match picked the wrong option ("Dark" in "Dark & Light").
          const pickedId = options.find((o) => new RegExp(`^I choose ${o.id}\\b`, "i").test(pickedMsg))?.id;
          // The mockup's second chip: does the CTO endorse the
          // pick in its next reply?
          let ctoAgrees = false;
          if (pickedId) {
            for (let i = index + 2; i < timeline.length && i < index + 6; i += 1) {
              const candidate = timeline[i];
              if (!candidate || candidate.authorType !== "agent") continue;
              const role = (agents as any)?.find((a: any) => a._id === candidate.agentId)?.role;
              if (!/^(cto|architect|orchestrator|planner)$/i.test(role ?? "")) continue;
              ctoAgrees = /^\s*i agree\b/i.test(candidate.content ?? "");
              break;
            }
          }
          // The pick auto-creates a task ("Task created from
          // your pick"); bind the card to that task's live
          // status so the card evolves with execution.
          let linkedTaskId: string | undefined;
          let linkedTaskStatus: string | undefined;
          if (pickedId) {
            for (let i = index + 2; i < timeline.length; i += 1) {
              const candidate = timeline[i];
              if (
                candidate?.taskId &&
                typeof candidate.content === "string" &&
                candidate.content.startsWith("Task created from your pick")
              ) {
                linkedTaskId = candidate.taskId;
                linkedTaskStatus = (tasks ?? []).find((t: any) => t._id === candidate.taskId)?.status;
                break;
              }
            }
          }
          return (
            <OptionCards
              options={options}
              pickedId={pickedId}
              ctoAgrees={ctoAgrees}
              taskId={linkedTaskId}
              taskStatus={linkedTaskStatus}
              disabled={chatSending}
              onPick={(option) => onPickProposal(`I choose ${option.id}: ${option.title}`)}
              onOpenTask={onSelectTask}
            />
          );
        })()}
        {(() => {
          const kind = messageKindOf(m.content);
          if (kind !== "delegation") return null;
          const parts = delegationParts(m.content);
          if (!parts) return null;
          return (
            <div className="mt-1 flex max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink">
              <span className="font-medium">{parts.from}</span>
              <span aria-hidden="true" className="text-ink-3">→</span>
              <span className="font-medium text-ink">{parts.to}</span>
              <span className="text-[13px] text-ink-3">({parts.capability})</span>
              {parts.reason && <span className="w-full text-ink-2">{parts.reason}</span>}
            </div>
          );
        })()}
      </div>
    </>
  );

  return (
    <CardSurfaceProvider value={cardSurface}>
      {inspectId && <ContextDrawer messageId={inspectId} onClose={() => setInspectId(null)} />}
      {loading && <SectionLoading rows={2} />}
      {history && !loading && <HistoryBar history={history} />}
      {virtualized ? (
        <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const m = timeline[vi.index];
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)` }}
              >
                {renderItem(m, vi.index, false)}
              </div>
            );
          })}
        </div>
      ) : (
        <div ref={listRef}>{timeline.map((m: any, index: number) => renderItem(m, index, true))}</div>
      )}
      {conversationTyping && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="mt-6" aria-live="polite">
          <p className="text-[12.5px] font-medium text-ink-2">{typingAgent ? roleLabel(typingAgent.role) : "Team"}</p>
          <div className="mt-1">
            <ReasoningLine running />
          </div>
        </motion.div>
      )}
      {liveQa && (
        <p role="status" aria-live="polite" className="my-5 truncate px-4 text-center text-[13px] text-ink-3">
          QA is checking{" "}
          {liveQa.url ? <span className="font-mono text-[12.5px] text-ink-2">{liveQa.url.replace(/^https?:\/\//, "")}</span> : "the app"}
          {liveQa.width ? ` at ${liveQa.width} px` : liveQa.label ? ` (${liveQa.label})` : ""}
        </p>
      )}
      {!loading && !timeline.length && (
        <div className="py-16 text-center">
          <p className="text-[15px] font-medium text-ink">No messages yet</p>
          <p className="mt-1 text-[14px] text-ink-3">Describe what you want built. Type @ to address a teammate, or / for a command.</p>
        </div>
      )}
    </CardSurfaceProvider>
  );
}
