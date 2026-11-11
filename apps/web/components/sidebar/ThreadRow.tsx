"use client";

import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";
import { threadHref, type ThreadRowView } from "@/lib/threadTree";

/**
 * One thread in the sidebar Threads section. Needs-you is plain text and
 * unread is a dot drawn in ink; no tint, no pill.
 *
 * `titleSlot` replaces the title text when given: B3 puts its inline rename
 * input there. `onTitleDoubleClick` and `onRowKeyDown` let it start a rename
 * (double-click, F2) without this row knowing about renaming.
 */
export default function ThreadRow({
  row,
  current,
  showProject,
  onOpen,
  onRowKeyDown,
  titleSlot,
  onTitleDoubleClick,
}: {
  row: ThreadRowView;
  current: boolean;
  /** Name the project under the title (when rows are not grouped by project). */
  showProject: boolean;
  onOpen: (row: ThreadRowView) => void;
  onRowKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>, row: ThreadRowView) => void;
  titleSlot?: ReactNode;
  onTitleDoubleClick?: (row: ThreadRowView) => void;
}) {
  const meta = [showProject ? row.projectName : null, row.branchName].filter(Boolean).join(" · ");
  return (
    <li className={`group relative flex items-center rounded-lg transition ${current ? "bg-hover" : "hover:bg-hover"}`}>
      <Link
        href={threadHref(row)}
        data-thread-id={row.id}
        onClick={() => onOpen(row)}
        onKeyDown={(e) => onRowKeyDown?.(e, row)}
        aria-current={current ? "page" : undefined}
        title={row.title}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg py-[6px] pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${row.nested ? "pl-6" : "pl-2"}`}
      >
        <span className="min-w-0 flex-1">
          {titleSlot ?? (
            <span
              onDoubleClick={onTitleDoubleClick ? (e) => (e.preventDefault(), onTitleDoubleClick(row)) : undefined}
              className={`block truncate text-[14px] ${row.unread || current ? "font-medium text-ink" : "text-ink-2"}`}
            >
              {row.title}
            </span>
          )}
          {meta && <span className="block truncate text-[12px] text-ink-3">{meta}</span>}
        </span>
        {row.needsYou && <span className="shrink-0 text-[11.5px] text-ink">needs you</span>}
        {row.unread && (
          <span aria-label="Unread" title="Unread" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
        )}
      </Link>
    </li>
  );
}
