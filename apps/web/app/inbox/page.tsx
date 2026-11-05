"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../../api/convex/_generated/api";
import Link from "next/link";
import IconRail from "../../components/IconRail";
import Sidebar from "../../components/Sidebar";
import AgentAvatar from "../../components/AgentAvatar";

const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
};

export default function InboxPage() {
  const inbox = useQuery(api.inbox.list, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);

  if (inbox === undefined) {
    return <div className="flex h-screen items-center justify-center">Loading…</div>;
  }

  const total = inbox.approvals.length + inbox.tasks.length + inbox.agents.length;

  return (
    <div className="flex h-screen overflow-hidden bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-gray-500">
            {total ? `${total} item perlu perhatian Anda lintas project.` : "Tidak ada yang menunggu Anda."}
          </p>

          {inbox.approvals.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Perlu approval ({inbox.approvals.length})
              </h2>
              <div className="mt-2 grid gap-2">
                {inbox.approvals.map((a) => (
                  <div key={a._id} className="rounded-xl border border-[#ebe9f0] bg-white p-4 shadow-[0_1px_2px_rgba(30,25,60,.03)] dark:border-gray-800 dark:bg-gray-900">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{a.summary}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {a.projectName}
                          {a.taskTitle ? ` · ${a.taskTitle}` : ""}
                          {a.requestedByAgentName ? ` · diminta ${a.requestedByAgentName}` : ""}
                        </p>
                        <span className="mt-2 inline-block rounded-full bg-[#eeecfb] px-2 py-0.5 text-[11px] font-semibold text-[#4c42a3] dark:bg-gray-800">
                          {KIND_LABEL[a.kind] ?? a.kind}
                        </span>
                      </div>
                      <Link
                        href={`/workspace/${a.projectId}`}
                        className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                      >
                        Buka project
                      </Link>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => approve({ approvalId: a._id })}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => reject({ approvalId: a._id })}
                        className="rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-semibold dark:bg-gray-800 dark:text-white"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {inbox.tasks.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Task perlu perhatian ({inbox.tasks.length})
              </h2>
              <div className="mt-2 grid gap-2">
                {inbox.tasks.map((t) => (
                  <Link
                    key={t._id}
                    href={`/workspace/${t.projectId}`}
                    className="rounded-xl border border-[#ebe9f0] bg-white p-4 hover:bg-[#fbfbfd] dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900"
                  >
                    <p className="font-medium">{t.title}</p>
                    <p className="mt-1 text-xs text-gray-500">{t.projectName}</p>
                    <span
                      className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        t.status === "failed" ? "bg-red-50 text-red-600 dark:bg-red-950" : "bg-amber-50 text-amber-600 dark:bg-amber-950"
                      }`}
                    >
                      {t.status === "failed" ? "Gagal" : "Menunggu approval"}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {inbox.agents.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Agent menunggu Anda ({inbox.agents.length})
              </h2>
              <div className="mt-2 grid gap-2">
                {inbox.agents.map((a) => (
                  <div key={a._id} className="flex items-center gap-3 rounded-xl border border-[#ebe9f0] bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                    <AgentAvatar name={a.name} size={32} status={a.status} avatarParams={a.avatarParams} />
                    <div className="min-w-0">
                      <p className="font-medium">{a.name}</p>
                      <p className="text-xs text-gray-500">{a.role} · needs_you</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {total === 0 && (
            <div className="mt-10 rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400 dark:border-gray-700">
              Inbox kosong. Semua approval sudah diproses.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
