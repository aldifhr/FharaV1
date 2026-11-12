"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Brain, Check, Copy, MoreHorizontal, PanelRightOpen, Pin, PinOff, Plus, Reply, ShieldCheck } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";

/** Per-message controls of the chat timeline (split out of MessageList.tsx). */

/** A Create task offer that already became a task: a link to it, never a second button. */
export function TaskCreatedLink({ taskId, title, onOpen }: { taskId: string; title?: string; onOpen: (taskId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(taskId)}
      title={title ? `Open “${title}”` : "Open the task"}
      className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-[13px] text-ink-3 transition hover:text-ink"
    >
      <Check size={13} aria-hidden="true" />
      <span>Task created</span>
      <span aria-hidden="true">·</span>
      <span className="truncate text-ink underline-offset-2 hover:underline">{title && title !== "task" ? title : "Open task"}</span>
    </button>
  );
}

export function CreateTaskButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1 text-[13px] font-medium text-ink transition hover:bg-hover disabled:opacity-50"
    >
      <Plus size={13} /> {busy ? "Creating…" : "Create task"}
    </button>
  );
}

/** Hover ⋯ (or long-press on touch) menu for one message: pin, copy, remember, open thread. */
export function MessageActions({
  pinned,
  messageId,
  content,
  taskId,
  onTogglePin,
  onOpenTask,
  onReply,
  onSecondOpinion,
  personal = false,
  inline = false,
}: {
  inline?: boolean;
  /** Personal chat message: Remember saves to the agent's memory (plan 039 D7). */
  personal?: boolean;
  onReply?: () => void;
  /** Agent replies only: ask the Reviewer for a second opinion. */
  onSecondOpinion?: () => void;
  pinned: boolean;
  messageId?: string;
  content: string;
  taskId?: string;
  onTogglePin: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const toast = useToast();
  const rememberMessage = useMutation(api.memories.rememberMessage);
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
  const hoverBtn = `flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-ink-3 outline-none transition hover:border-line hover:bg-panel hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100"} [@media(hover:none)]:hidden`;
  return (
    <div ref={ref} className={`flex items-center gap-0.5 ${inline ? "relative shrink-0 self-center" : "absolute right-0 top-0"}`}>
      {onReply && (
        <button type="button" aria-label="Reply" title="Reply" onClick={onReply} className={hoverBtn}>
          <Reply size={15} />
        </button>
      )}
      <button
        type="button"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={hoverBtn}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
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
          {onReply && (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onReply(); }}>
              <Reply size={15} className="text-ink-3" /> Reply
            </button>
          )}
          {messageId && content?.trim() && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                // Saved as a pinned project memory: the project's agents get it
                // in their next prompt. Editable on /memory.
                rememberMessage({ messageId: messageId as never }).then(
                  (r) => toast("success", r.created ? "Remembered" : "Already remembered", personal ? "Pinned to this agent's memory" : "Pinned to this project's memory"),
                  (err) => toast("error", "Couldn't remember", err instanceof Error ? err.message : undefined),
                );
              }}
            >
              <Brain size={15} className="text-ink-3" /> Remember
            </button>
          )}
          {onSecondOpinion && (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onSecondOpinion(); }}>
              <ShieldCheck size={15} className="text-ink-3" /> Second opinion
            </button>
          )}
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
