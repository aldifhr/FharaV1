"use client";

import { useLayoutEffect, useRef } from "react";
import { ChevronUp, ListTree, Loader2 } from "lucide-react";
import type { MessageHistory } from "@/lib/useMessageHistory";

/** The nearest scrolling ancestor, so a prepend keeps the reader's place. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/**
 * D12: "Load earlier" plus the turn outline, above a long thread's oldest
 * held message. Loading a page keeps the reader where they were; choosing a
 * turn loads its page and the list scrolls to it (`history.pendingJump`).
 */
export default function HistoryBar({ history }: { history: MessageHistory }) {
  const barRef = useRef<HTMLDivElement>(null);
  const fromBottom = useRef<{ el: HTMLElement; distance: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = fromBottom.current;
    if (!anchor) return;
    fromBottom.current = null;
    anchor.el.scrollTop = anchor.el.scrollHeight - anchor.distance;
  }, [history.earlierCount]);

  if (!history.canLoadEarlier && !history.earlierCount) return null;
  const loadEarlier = () => {
    const el = scrollParent(barRef.current);
    if (el) fromBottom.current = { el, distance: el.scrollHeight - el.scrollTop };
    history.loadEarlier();
  };
  return (
    <div ref={barRef} className="mb-4 flex flex-col gap-2 border-b border-line pb-3 text-[13px] text-ink-3">
      <div className="flex items-center gap-3">
        {history.canLoadEarlier ? (
          <button
            type="button"
            onClick={loadEarlier}
            disabled={history.loading}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-60"
          >
            {history.loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
            {history.loading ? "Loading earlier messages…" : "Load earlier"}
          </button>
        ) : (
          <span className="px-1.5 py-1">Start of the conversation</span>
        )}
        <button
          type="button"
          onClick={() => history.setOutlineOpen(!history.outlineOpen)}
          aria-expanded={history.outlineOpen}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <ListTree size={14} aria-hidden="true" />
          {history.outlineOpen ? "Hide turns" : "Jump to a turn"}
        </button>
      </div>
      {history.outlineOpen && (
        <nav aria-label="Conversation turns" className="max-h-56 overflow-y-auto rounded-lg border border-line bg-panel py-1">
          {history.turns === undefined ? (
            <p className="px-3 py-1.5">Loading turns…</p>
          ) : history.turns.length === 0 ? (
            <p className="px-3 py-1.5">No turns yet.</p>
          ) : (
            history.turns.map((turn) => (
              <button
                key={turn._id}
                type="button"
                onClick={() => history.jumpToTurn(turn)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left outline-none transition hover:bg-hover hover:text-ink focus-visible:bg-hover"
              >
                <span className="shrink-0 font-mono text-[12px] tabular-nums">{turn.turn}</span>
                <span className="min-w-0 truncate text-ink-2">{turn.preview || "(empty message)"}</span>
              </button>
            ))
          )}
          {history.outlineTruncated && <p className="px-3 py-1.5">Older turns are not listed.</p>}
        </nav>
      )}
    </div>
  );
}
