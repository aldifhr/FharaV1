"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { MessageCircle, Trash2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Sidebar from "@/components/Sidebar";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import InitialAvatar from "@/components/InitialAvatar";
import { useToast } from "@/components/Toasts";
import { roleLabel } from "@/lib/agentRoles";
import { plainTextPreview, sidebarPersonalRows } from "@/lib/personalChat";
import { relativeTime } from "@/lib/runFormat";

type Row = {
  agent: { _id: string; name: string; role: string; avatarParams?: unknown };
  conversationId: string | null;
  lastMessageAt: number | null;
  preview: string | null;
  projectName: string | null;
};

/**
 * Personal messages (plan 039): the dedicated left-nav page that replaced the
 * sidebar section. One row per agent with a personal chat, a picker that
 * opens (get-or-create) a chat with any enabled agent, and a delete control
 * per row (`conversations.removePersonal`).
 */
export default function PersonalMessagesPage() {
  const router = useRouter();
  const toast = useToast();
  const rows = useQuery(api.conversations.listPersonal, {}) as Row[] | undefined;
  const chats = sidebarPersonalRows(rows, "", roleLabel);
  const removePersonal = useMutation(api.conversations.removePersonal);
  const [confirm, setConfirm] = useState<{ request: ConfirmRequest; conversationId: string } | null>(null);
  const [pending, setPending] = useState(false);

  const confirmDelete = async () => {
    if (!confirm) return;
    setPending(true);
    try {
      await removePersonal({ conversationId: confirm.conversationId as never });
      toast("success", "Chat deleted");
      setConfirm(null);
    } catch (err) {
      toast("error", "Couldn't delete the chat", err instanceof Error ? err.message : undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[26px] font-semibold tracking-tight">Personal messages</h1>
              <p className="mt-1 text-[15px] text-ink-2">One-to-one chats with the agents on your team.</p>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className="shrink-0">New message</span>
              <select
                aria-label="Message an agent"
                value=""
                onChange={(e) => e.target.value && router.push(`/message/${e.target.value}`)}
                disabled={rows === undefined || rows.length === 0}
                className="max-w-52 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-ink outline-none focus:border-line-strong disabled:opacity-50"
              >
                <option value="">Choose an agent…</option>
                {(rows ?? []).map((row) => (
                  <option key={row.agent._id} value={row.agent._id}>
                    {row.agent.name} · {roleLabel(row.agent.role)}
                  </option>
                ))}
              </select>
            </label>
          </header>

          <section className="mt-6">
            {rows === undefined ? (
              <p className="text-[13px] text-ink-3" role="status">Loading messages…</p>
            ) : chats.length === 0 ? (
              <div className="rounded-xl border border-line bg-panel px-4 py-10 text-center">
                <MessageCircle size={20} className="mx-auto text-ink-3" aria-hidden="true" />
                <p className="mt-3 text-[14px] text-ink">No personal messages yet.</p>
                <p className="mt-1 text-[13px] text-ink-3">Pick an agent above to start a conversation.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                {chats.map((row) => {
                  const preview = row.preview ? plainTextPreview(row.preview) : "";
                  const conversationId = row.conversationId;
                  return (
                    <li key={row.agent._id} className="group flex items-center gap-1 pr-2 transition hover:bg-hover">
                      <Link
                        href={`/message/${row.agent._id}`}
                        title={preview || row.agent.name}
                        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 outline-none focus-visible:bg-hover"
                      >
                        <InitialAvatar agent avatarParams={row.agent.avatarParams} name={row.agent.name} size={32} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] text-ink">{row.agent.name}</p>
                          <p className="truncate text-[12.5px] text-ink-3">{preview || "No messages yet"}</p>
                        </div>
                        <span className="shrink-0 truncate text-[12.5px] text-ink-3">{roleLabel(row.agent.role)}</span>
                        {row.lastMessageAt && (
                          <span className="shrink-0 self-start pt-0.5 text-[12px] tabular-nums text-ink-3">
                            {relativeTime(row.lastMessageAt)}
                          </span>
                        )}
                      </Link>
                      {conversationId && (
                        <button
                          type="button"
                          onClick={() =>
                            setConfirm({
                              conversationId,
                              request: {
                                title: "Delete this chat?",
                                message: `All messages in this chat with ${row.agent.name} are deleted and cannot be recovered.`,
                                confirmLabel: "Delete chat",
                                icon: "trash",
                              },
                            })
                          }
                          aria-label={`Delete chat with ${row.agent.name}`}
                          title="Delete chat"
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 outline-none transition hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 group-hover:opacity-100 max-sm:opacity-100"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>
      <ConfirmDialog
        request={confirm?.request ?? null}
        pending={pending}
        onCancel={() => (pending ? undefined : setConfirm(null))}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
