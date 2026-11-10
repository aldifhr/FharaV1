"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import AgentAvatar from "@/components/AgentAvatar";
import { roleLabel } from "@/lib/agentRoles";
import { relativeTime } from "@/lib/runFormat";

/** Personal chat (plan 039): one row per enabled agent, recent chats first. */
export default function PersonalChatsPage() {
  const rows = useQuery(api.conversations.listPersonal, {});

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink max-[979px]:h-auto max-[979px]:min-h-dvh max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[26px] font-semibold tracking-tight">Personal chat</h1>
          <p className="mt-1 text-[13px] text-ink-3">Talk to one agent outside a project. Attach a project later if the chat needs its files.</p>

          {rows === undefined ? (
            <p className="mt-8 text-[13px] text-ink-3" role="status">Loading agents…</p>
          ) : rows.length === 0 ? (
            <p className="mt-8 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">No enabled agents yet. Add one on the Team page.</p>
          ) : (
            <ul className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {rows.map((row) => (
                <li key={row.agent._id}>
                  <Link
                    href={`/chats/personal/${row.agent._id}`}
                    className="flex items-center gap-3 px-4 py-3 outline-none transition hover:bg-hover focus-visible:bg-hover"
                  >
                    <AgentAvatar name={row.agent.name} size={32} avatarParams={row.agent.avatarParams as never} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink">
                        {row.agent.name}
                        <span className="text-ink-3"> · {roleLabel(row.agent.role)}</span>
                      </span>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {row.preview ?? (row.conversationId ? "No messages yet" : "Start a chat")}
                        {row.projectName ? ` · Project: ${row.projectName}` : ""}
                      </span>
                    </span>
                    {row.lastMessageAt && <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{relativeTime(row.lastMessageAt)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
