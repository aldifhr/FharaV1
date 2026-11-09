"use client";

import { motion } from "framer-motion";
import { Pin } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import { parseOptions } from "@/lib/options";
import { roleLabel } from "@/lib/agentRoles";
import ApprovalCard from "../ApprovalCard";
import QaPanel from "../QaPanel";
import AgentAvatar from "../AgentAvatar";
import { ReasoningLine } from "../ui/trace";
import MessageText from "./MessageText";
import OptionCards from "./OptionCards";
import TaskCard from "./TaskCard";
import ChatCard from "./cards/ChatCard";
import { CardSurfaceProvider } from "./cards/CardContext";
import { qaStatusLine } from "./cards/QaCard";
import InitialAvatar from "../InitialAvatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { SectionLoading } from "@/app/WorkspaceContext";

export type MessageKind = "evaluation" | "planning" | "delegation" | "design" | null;

export function messageKindOf(content: string): MessageKind {
  return /^Task (completed|finished)/.test(content) ? "evaluation" :
    /^Plan dibuat/.test(content) ? "planning" :
    /^Delegation:/.test(content) ? "delegation" :
    /^Design proposal:/.test(content) ? "design" : null;
}

export function delegationParts(content: string) {
  const match = content.match(/^Delegation:\s*(.+?)\s*→\s*(.+?)\s*\((.+?)\)(?::\s*(.*))?$/s);
  return match ? { from: match[1], to: match[2], capability: match[3], reason: match[4] ?? "" } : null;
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
  replyingNames: string[];
  activeForSelectedTask: any[];
  workingAgents: any[];
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Filled with a function that scrolls a message into view (works for
   *  virtualized rows that are not in the DOM). Returns false if absent. */
  scrollToMessageRef?: MutableRefObject<((messageId: string) => boolean) | null>;
  onSelectTask: (taskId: string) => void;
  approve: (approvalId: string) => unknown;
  reject: (approvalId: string) => unknown;
  hold: (approvalId: string) => unknown;
  togglePin: (messageId: string, pinned: boolean) => void;
  onPickProposal: (choice: string) => void;
  formatTime: (createdAt: number) => string;
  taskTitle: (taskId: string) => string;
  blockKey: (m: any) => string;
};

export default function MessageList(props: Props) {
  const {
    timeline, firstNewIndex, agents, tasks = [], subtasksOf, pendingItems, projectEvents = [],
    projectApprovalMode, loading = false, chatSending,
    conversationTyping, replyingNames, activeForSelectedTask, workingAgents, scrollRef, scrollToMessageRef,
    onSelectTask, approve, reject, hold, togglePin, onPickProposal, formatTime, taskTitle, blockKey,
  } = props;

  const listRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!scrollToMessageRef) return;
    scrollToMessageRef.current = (messageId: string) => {
      const index = timeline.findIndex((m: any) => m._id === messageId);
      if (index < 0) return false;
      if (virtualized) {
        virtualizer.scrollToIndex(index, { align: "center" });
        // Re-run once rows are measured so the target lands centred.
        requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: "center" }));
        return true;
      }
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    };
    return () => {
      if (scrollToMessageRef) scrollToMessageRef.current = null;
    };
  }, [scrollToMessageRef, timeline, virtualized, virtualizer]);

  const renderItem = (m: any, index: number, animate: boolean) => {
    const previous = timeline[index - 1];
    const key = blockKey(m);
    const prevKey = previous ? blockKey(previous) : null;
    // Divider marks the start of a task block (at the user's message
    // that spawned it), not a transition back to plain conversation.
    const boundary = key !== prevKey && key !== "conversation";
    const showTaskCard = key !== "conversation" && m.authorType === "agent" && previous?.authorType === "user";
    const messageAgent = m.authorType === "agent"
      ? (agents as any)?.find((a: any) => a._id === m.agentId)
      : undefined;
    const inner = (
      <>
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
          const cardTask = (tasks ?? []).find((t: any) => t._id === key);
          if (!cardTask) return null;
          const pending = pendingItems.filter((a: any) => a.taskId === key && a.status === "pending");
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
                  onReview={onSelectTask}
                />
              ))}
              {qaEvents.length > 0 && !tasksWithQaCard.has(String(key)) && <QaPanel events={qaEvents} />}
            </div>
          );
        })()}
        {animate ? (
          <motion.div
            key={m._id}
            id={`message-${m._id}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.18) }}
            className="group mt-3 flex gap-3"
          >
            {renderMessageBody(m, index, messageAgent)}
          </motion.div>
        ) : (
          <div
            key={m._id}
            id={`message-${m._id}`}
            className="group mt-3 flex gap-3"
          >
            {renderMessageBody(m, index, messageAgent)}
          </div>
        )}
      </>
    );
    return <div key={m._id}>{inner}</div>;
  };

  const renderMessageBody = (m: any, index: number, messageAgent: any) => (
    <>
      {m.authorType === "agent" ? (
        <InitialAvatar name={roleLabel(messageAgent?.role)} size={32} />
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eceaf3] text-[11px] font-bold text-[#5147b4] dark:bg-white/15 dark:text-white">
          You
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-[#34323d] dark:text-gray-100">
            {m.authorType === "agent"
              ? roleLabel(messageAgent?.role)
              : "You"}
            {(() => {
              const kind = messageKindOf(m.content);
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
          <span className="text-[11px] text-gray-500 dark:text-gray-400">{formatTime(m._creationTime)}</span>
          <button
            type="button"
            title={m.pinned ? "Unpin message" : "Pin message"}
            aria-label={m.pinned ? "Unpin message" : "Pin message"}
            aria-pressed={Boolean(m.pinned)}
            onClick={() => togglePin(m._id, !m.pinned)}
            className={`-my-1 rounded-md p-1.5 outline-none transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 ${
              m.pinned
                ? "text-[#635bff]"
                : "text-gray-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-[#635bff] [@media(hover:none)]:opacity-60 dark:text-gray-500"
            }`}
          >
            <Pin size={12} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1.5">
          {m.authorType === "agent" && !m.card && (m.reasoning || !m.content?.trim()) && (
            <ReasoningLine
              text={m.reasoning}
              running={!m.content?.trim() && conversationTyping && index === timeline.length - 1}
              seconds={m.reasoningDurationMs}
            />
          )}
          {messageKindOf(m.content) === "delegation" || (m.card && !m.content?.trim()) ? null : (
            <Bubble variant={m.authorType === "user" ? "tinted" : "ghost"} align={m.authorType === "user" ? "end" : "start"} className="max-w-full">
              <BubbleContent>
                <MessageText
                  content={parseOptions(m.content).text}
                  isAnimating={conversationTyping && index === timeline.length - 1}
                />
              </BubbleContent>
            </Bubble>
          )}
        </div>
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
            <div className="mt-2 flex max-w-3xl flex-wrap items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs dark:border-indigo-950 dark:bg-indigo-950/20">
              <span className="font-semibold dark:text-white">{parts.from}</span>
              <span aria-hidden="true" className="text-indigo-400">→</span>
              <span className="font-semibold dark:text-white">{parts.to}</span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-100 dark:bg-gray-900 dark:text-indigo-300 dark:ring-gray-800">{parts.capability}</span>
              {parts.reason && <span className="w-full text-gray-500 dark:text-gray-400">{parts.reason}</span>}
            </div>
          );
        })()}
      </div>
    </>
  );

  return (
    <CardSurfaceProvider value={cardSurface}>
      {loading && <SectionLoading rows={2} />}
      {virtualized ? (
        <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const m = timeline[vi.index];
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                {renderItem(m, vi.index, false)}
              </div>
            );
          })}
        </div>
      ) : (
        <div ref={listRef}>{timeline.map((m: any, index: number) => renderItem(m, index, true))}</div>
      )}
      {liveQa && (
        <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-2 pl-1 text-[12px] text-[#8a8796] dark:text-neutral-400">
          <span className="flex shrink-0 gap-0.5" aria-hidden="true">
            <i className="h-1 w-1 animate-bounce rounded-full bg-current" />
            <i className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:120ms]" />
            <i className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:240ms]" />
          </span>
          <span className="min-w-0 truncate">
            QA is checking{" "}
            {liveQa.url ? (
              <code className="rounded bg-[#f3f2f7] px-1 py-px font-mono text-[11px] text-[#4c4a55] dark:bg-white/10 dark:text-neutral-200">
                {liveQa.url.replace(/^https?:\/\//, "")}
              </code>
            ) : (
              "the app"
            )}
            {liveQa.width ? ` at ${liveQa.width} px` : liveQa.label ? ` (${liveQa.label})` : ""}
          </span>
        </div>
      )}
      {/* Generic chat-reply indicator. Per-agent status (Working now
          / X is thinking) is more specific: when either is visible,
          this one hides so the same state is not announced twice. */}
      {conversationTyping && activeForSelectedTask.length === 0 && workingAgents.length === 0 && (
        <div role="status" aria-live="polite" className="flex w-fit items-center gap-2.5 rounded-full border border-[#ebe9f4] bg-white/80 px-3 py-1.5 text-xs font-medium text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-300">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#eeecfb] text-[10px] text-[#635bff] dark:bg-indigo-950 dark:text-indigo-300" aria-hidden="true">✦</span>
          <span>{replyLabel(replyingNames)}</span>
          <span className="flex gap-1" aria-hidden="true">
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8] [animation-delay:120ms]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8] [animation-delay:240ms]" />
          </span>
        </div>
      )}
      {!loading && !timeline.length && (
        <div className="py-10 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">No messages yet</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Describe what you want built. Type @ to address a teammate like @CTO or @QA.</p>
        </div>
      )}
      {activeForSelectedTask.length > 0 ? (
        <div role="status" aria-live="polite" className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
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
                <span className="text-gray-500 dark:text-gray-400">
                  {stage === "waiting_approval" ? "waiting approval" : stage === "queued" ? "queued" : "thinking"}
                  {subtaskKey ? ` · ${subtaskKey}` : ""}
                </span>
                <span className="flex gap-0.5" aria-hidden="true">
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
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
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
            <span>{workingAgents.map((agent: any) => roleLabel(agent.role)).join(", ")} {workingAgents.length === 1 ? "is" : "are"} thinking</span>
            <span className="flex gap-0.5" aria-hidden="true">
              <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
              <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
              <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
            </span>
          </div>
        )
      )}
    </CardSurfaceProvider>
  );
}

/** The pill names who is drafting a reply instead of the generic
 *  "Team is thinking" — falls back to "Team" when the selection is empty. */
function replyLabel(names: string[]): string {
  const [a, b, c] = names;
  if (!a) return "Team is thinking";
  if (!b) return `${a} is drafting a reply`;
  if (!c) return `${a} and ${b} are drafting replies`;
  return `${a}, ${b} and ${c} are drafting replies`;
}
