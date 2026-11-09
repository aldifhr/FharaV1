"use client";

import { ChevronRight } from "lucide-react";
import type { ActivityGroup } from "@/lib/activityGroups";

/**
 * One collapsed line for a run of activity cards (lib/activityGroups).
 * Neutral by design: no pill, no tinted surface. A failed group keeps a
 * small red dot. Expanding shows the original cards unchanged below it.
 */
export default function ActivityGroupRow({
  group,
  open,
  onToggle,
  className = "",
}: {
  group: ActivityGroup;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const count = group.messageIds.length;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${group.summary}${group.failed ? " (has failures)" : ""}. ${open ? "Collapse" : "Expand"} ${count} items`}
      className={`group/activity flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
    >
      <ChevronRight
        size={14}
        aria-hidden="true"
        className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}
      />
      {group.failed && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />}
      <span className="min-w-0 flex-1 truncate">{group.summary}</span>
      <span className="shrink-0 tabular-nums text-[12px] text-ink-3">{count}</span>
    </button>
  );
}
