"use client";

import { motion } from "framer-motion";
import { Copy, MoreHorizontal, PanelRightOpen, Pin, PinOff } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { parseOptions } from "@/lib/options";
import { roleLabel } from "@/lib/agentRoles";
import ApprovalCard from "../ApprovalCard";
import QaPanel from "../QaPanel";
import InitialAvatar from "../InitialAvatar";
import { ReasoningLine } from "../ui/trace";
import MessageText from "./MessageText";
import OptionCards from "./OptionCards";
import TaskCard from "./TaskCard";
import ChatCard from "./cards/ChatCard";
import { CardSurfaceProvider } from "./cards/CardContext";
import { qaStatusLine } from "./cards/QaCard";
import { SectionLoading } from "@/app/WorkspaceContext";
import { useToast } from "../Toasts";

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
    conversationTyping, scrollRef, scrollToMessageRef,
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
          <div role="separator" aria-label="New messages" className="mb-2 mt-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-brand-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
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
            className="group relative mt-5 flex gap-3.5"
          >
            {renderMessageBody(m, index, messageAgent)}
          </motion.div>
        ) : (
          <div
            key={m._id}
            id={`message-${m._id}`}
            className="group relative mt-5 flex gap-3.5"
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
      <InitialAvatar name={m.authorType === "agent" ? roleLabel(messageAgent?.role) : "You"} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 pr-9">
          <p className="flex flex-wrap items-center gap-1.5 text-[15px] font-semibold text-ink">
            {m.authorType === "agent" ? roleLabel(messageAgent?.role) : "You"}
            {(() => {
              const kind = messageKindOf(m.content);
              const tag = kind === "evaluation" ? "evaluated" : kind === "planning" ? "plan" : kind === "delegation" ? "handoff" : kind === "design" ? "design" : null;
              return tag ? <span className="rounded-md border border-line px-1.5 py-px text-[11px] font-normal text-ink-2">{tag}</span> : null;
            })()}
          </p>
          <span className="text-[13px] text-ink-3">{formatTime(m._creationTime)}</span>
          {m.pinned && <Pin size={12} className="self-center text-brand-ink" aria-label="Pinned" />}
        </div>
        <MessageActions
          pinned={Boolean(m.pinned)}
          content={m.content}
          taskId={blockKey(m) !== "conversation" ? blockKey(m) : undefined}
          onTogglePin={() => togglePin(m._id, !m.pinned)}
          onOpenTask={onSelectTask}
        />
        <div className="mt-0.5">
          {m.authorType === "agent" && !m.card && (m.reasoning || !m.content?.trim()) && (
            <ReasoningLine
              text={m.reasoning}
              running={!m.content?.trim() && conversationTyping && index === timeline.length - 1}
              seconds={m.reasoningDurationMs}
            />
          )}
          {messageKindOf(m.content) === "delegation" || (m.card && !m.content?.trim()) ? null : (
            <MessageText
              content={parseOptions(m.content).text}
              isAnimating={conversationTyping && index === timeline.length - 1}
            />
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
            <div className="mt-1 flex max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink">
              <span className="font-medium">{parts.from}</span>
              <span aria-hidden="true" className="text-ink-3">→</span>
              <span className="font-medium text-brand-ink">@{parts.to}</span>
              <span className="rounded-md border border-line px-1.5 py-px text-[12px] text-ink-2">{parts.capability}</span>
              {parts.reason && <span className="w-full text-ink-2">{parts.reason}</span>}
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
        <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-2 pl-1 text-[13px] text-ink-3">
          <span className="flex shrink-0 gap-0.5" aria-hidden="true">
            <i className="h-1 w-1 animate-bounce rounded-full bg-current" />
            <i className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:120ms]" />
            <i className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:240ms]" />
          </span>
          <span className="min-w-0 truncate">
            QA is checking{" "}
            {liveQa.url ? (
              <code className="rounded bg-hover px-1 py-px font-mono text-[12px] text-ink-2">
                {liveQa.url.replace(/^https?:\/\//, "")}
              </code>
            ) : (
              "the app"
            )}
            {liveQa.width ? ` at ${liveQa.width} px` : liveQa.label ? ` (${liveQa.label})` : ""}
          </span>
        </div>
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

/** Hover ⋯ (or long-press on touch) menu for one message: pin, copy, open thread. */
function MessageActions({
  pinned,
  content,
  taskId,
  onTogglePin,
  onOpenTask,
}: {
  pinned: boolean;
  content: string;
  taskId?: string;
  onTogglePin: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Long-press anywhere on the row opens the menu on touch screens.
  useEffect(() => {
    const row = ref.current?.closest<HTMLElement>(".group");
    if (!row) return;
    const cancel = () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
      pressTimer.current = null;
    };
    const start = (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
      cancel();
      pressTimer.current = setTimeout(() => setOpen(true), 480);
    };
    row.addEventListener("touchstart", start, { passive: true });
    row.addEventListener("touchmove", cancel, { passive: true });
    row.addEventListener("touchend", cancel);
    return () => {
      cancel();
      row.removeEventListener("touchstart", start);
      row.removeEventListener("touchmove", cancel);
      row.removeEventListener("touchend", cancel);
    };
  }, []);

  const item = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-ink hover:bg-hover";
  return (
    <div ref={ref} className="absolute right-0 top-0">
      <button
        type="button"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-ink-3 outline-none transition hover:border-line hover:bg-panel hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand/40 ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100"} [@media(hover:none)]:hidden`}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onTogglePin(); }}>
            {pinned ? <PinOff size={15} className="text-ink-3" /> : <Pin size={15} className="text-ink-3" />}
            {pinned ? "Unpin message" : "Pin message"}
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              void navigator.clipboard?.writeText(content).then(
                () => toast("success", "Copied to clipboard"),
                () => toast("error", "Copy failed"),
              );
            }}
          >
            <Copy size={15} className="text-ink-3" /> Copy text
          </button>
          {taskId && (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onOpenTask(taskId); }}>
              <PanelRightOpen size={15} className="text-ink-3" /> Open task thread
            </button>
          )}
        </div>
      )}
    </div>
  );
}
