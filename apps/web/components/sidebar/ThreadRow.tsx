"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { threadHref, type ThreadRowView } from "@/lib/threadTree";

/**
 * One thread in the sidebar Threads section. Needs-you is plain text and
 * unread is a dot drawn in ink; no tint, no pill.
 *
 * `titleSlot` replaces the title text when given: B3 puts its inline rename
 * input there. `onTitleDoubleClick` and `onRowKeyDown` let it start a rename
 * (double-click, F2) without this row knowing about renaming. `onDelete`
 * adds the hover trash control; the section owns the confirm dialog.
 */
export default function ThreadRow({
  row,
  current,
  branch,
  labelPrefix,
  onOpen,
  onDelete,
  onRowKeyDown,
  titleSlot,
  onTitleDoubleClick,
}: {
  row: ThreadRowView;
  current: boolean;
  /** Tree connector drawn before the row when threads are grouped by project. */
  branch?: "├" | "└";
  /** Text shown before the title ("Thread: " in the project tree). */
  labelPrefix?: string;
  /** True when the click was handled here: the row's link is then not followed. */
  onOpen: (row: ThreadRowView) => boolean | void;
  onDelete?: (row: ThreadRowView) => void;
  onRowKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>, row: ThreadRowView) => void;
  titleSlot?: ReactNode;
  onTitleDoubleClick?: (row: ThreadRowView) => void;
}) {
  const meta = [row.kind === "direct" ? "Direct" : null, row.branchName].filter(Boolean).join(" · ");
  return (
    <li className={`group relative flex items-center rounded-lg transition ${current ? "bg-hover" : "hover:bg-hover"}`}>
      <Link
        href={threadHref(row)}
        data-thread-id={row.id}
        onClick={(e) => {
          if (onOpen(row) === false) e.preventDefault();
        }}
        onKeyDown={(e) => onRowKeyDown?.(e, row)}
        aria-current={current ? "page" : undefined}
        title={row.title}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg py-[6px] pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${row.nested ? "pl-6" : "pl-2"}`}
      >
        {branch && (
          <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-ink-3">
            {branch}─
          </span>
        )}
        <span className="min-w-0 flex-1">
          {titleSlot ?? (
            <span
              onDoubleClick={onTitleDoubleClick ? (e) => (e.preventDefault(), onTitleDoubleClick(row)) : undefined}
              className={`block truncate text-[14px] ${row.unread || current ? "font-medium text-ink" : "text-ink-2"}`}
            >
              {labelPrefix && <span className="text-ink-3">{labelPrefix}</span>}
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
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(row)}
          aria-label={`Delete ${row.title}`}
          title="Delete thread"
          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 outline-none transition hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 group-hover:opacity-100 max-sm:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      )}
    </li>
  );
}
