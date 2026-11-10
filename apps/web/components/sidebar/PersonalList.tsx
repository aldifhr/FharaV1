"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import InitialAvatar from "../InitialAvatar";
import { popoverClass, usePopover } from "../shell/usePopover";
import { roleLabel } from "@/lib/agentRoles";
import { personalAgentIdFromPath, sidebarPersonalRows } from "@/lib/personalChat";
import { relativeTime } from "@/lib/runFormat";
import { SectionToggle } from "./SectionToggle";

type Row = {
  agent: { _id: string; name: string; role: string; avatarParams?: unknown };
  conversationId: string | null;
  lastMessageAt: number | null;
  preview: string | null;
  projectName: string | null;
};

const SHOWN = 7;

/**
 * "Personal messages" (plan 039): one row per agent with a personal chat,
 * most recent first. A row opens `/chats/personal/<agentId>`; "+" picks any
 * enabled agent and opens (get-or-create) its chat.
 */
export default function PersonalList({
  filter,
  open,
  onToggle,
  onNavigate,
}: {
  filter: string;
  open: boolean;
  onToggle: () => void;
  /** Called after a row or picker entry is chosen (closes the mobile drawer). */
  onNavigate?: () => void;
}) {
  const rows = useQuery(api.conversations.listPersonal, {}) as Row[] | undefined;
  const pathname = usePathname();
  const router = useRouter();
  const picker = usePopover();
  const [showAll, setShowAll] = useState(false);
  const activeId = personalAgentIdFromPath(pathname);

  const all = sidebarPersonalRows(rows, "", roleLabel);
  const filtered = sidebarPersonalRows(rows, filter, roleLabel);
  const shown = showAll ? filtered : filtered.slice(0, SHOWN);
  const q = filter.trim();

  const openChat = (agentId: string) => {
    picker.setOpen(false);
    onNavigate?.();
    router.push(`/chats/personal/${agentId}`);
  };

  return (
    <section aria-label="Personal messages">
      <div className="relative" ref={picker.ref}>
        <SectionToggle
          title="Personal messages"
          count={rows ? all.length : undefined}
          open={open}
          onToggle={onToggle}
          onAdd={picker.toggle}
          addLabel="New message"
          chevron
        />
        {picker.open && (
          <div role="menu" aria-label="Message an agent" className={`${popoverClass} right-0 top-6 max-h-72 w-56 overflow-y-auto`}>
            {rows === undefined ? (
              <p className="px-3 py-2 text-[13px] text-ink-3">Loading agents…</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-ink-3">No enabled agents yet.</p>
            ) : (
              rows.map((row) => (
                <button
                  key={row.agent._id}
                  type="button"
                  role="menuitem"
                  onClick={() => openChat(row.agent._id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] hover:bg-hover"
                >
                  <InitialAvatar agent avatarParams={row.agent.avatarParams} name={roleLabel(row.agent.role)} size={20} />
                  <span className="min-w-0 flex-1 truncate text-ink">{row.agent.name}</span>
                  <span className="shrink-0 truncate text-[12.5px] text-ink-3">{roleLabel(row.agent.role)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {open && rows !== undefined && filtered.length === 0 && (
        <p className="px-2 pt-1.5 text-[13px] text-ink-3">{q ? "No messages match." : "No messages yet."}</p>
      )}
      {open && filtered.length > 0 && (
        <>
          <ul className="mt-1 space-y-px">
            {shown.map((row) => {
              const selected = activeId === row.agent._id;
              const role = roleLabel(row.agent.role);
              return (
                <li key={row.agent._id} className={`rounded-lg transition ${selected ? "bg-hover" : "hover:bg-hover"}`}>
                  <Link
                    href={`/chats/personal/${row.agent._id}`}
                    onClick={onNavigate}
                    aria-current={selected ? "page" : undefined}
                    title={row.preview ? `${row.agent.name} · ${role}: ${row.preview}` : `${row.agent.name} · ${role}`}
                    className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-[7px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    <InitialAvatar agent avatarParams={row.agent.avatarParams} name={role} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[15px] ${selected ? "font-medium text-ink" : "text-ink"}`}>{row.agent.name}</span>
                      <span className="block truncate text-[12.5px] text-ink-3">{row.preview ?? "No messages yet"}</span>
                    </span>
                    {row.lastMessageAt && (
                      <span className="shrink-0 self-start pt-0.5 text-[12px] tabular-nums text-ink-3">{relativeTime(row.lastMessageAt)}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          {filtered.length > SHOWN && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              <span aria-hidden="true" className={`inline-block text-ink-3 transition-transform ${showAll ? "rotate-90" : ""}`}>›</span>
              {showAll ? "Show less" : `${filtered.length - SHOWN} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
