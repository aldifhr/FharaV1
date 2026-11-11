"use client";

import { ChevronRight, Plus } from "lucide-react";

/** Collapsible sidebar section header: "▸ Projects 5  +". */
export function SectionToggle({
  title,
  count,
  open,
  onToggle,
  onAdd,
  addLabel,
  chevron = false,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addLabel?: string;
  chevron?: boolean;
}) {
  return (
    <div className="group/section flex h-7 items-center justify-between px-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md px-1 text-[13px] text-ink-2 outline-none transition hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        {chevron && <ChevronRight size={13} className={`text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />}
        <span>{title}</span>
        {count !== undefined && <span className="tabular-nums text-ink-3">{count}</span>}
      </button>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={addLabel ?? `Add to ${title}`}
          title={addLabel ?? `Add to ${title}`}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 opacity-0 outline-none transition hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 group-hover/section:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}
