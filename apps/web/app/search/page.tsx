"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import IconRail from "@/components/IconRail";
import AgentAvatar from "@/components/AgentAvatar";
import { agentName, agentRoleText } from "@/lib/agentRoles";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const results = useQuery(api.search.global, { q });

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-xl font-semibold">Search</h1>
          <p className="mt-1 text-sm text-gray-500">Search projects, tasks, and agents across projects.</p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search for a project, task, or agent…"
            className="mt-4 w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-[#6252d8] focus:ring-2 focus:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-900"
          />

          {!q.trim() && <p className="mt-8 text-sm text-gray-400">Start typing to search.</p>}

          {q.trim() && results === undefined && <p className="mt-8 text-sm text-gray-400">Searching…</p>}

          {q.trim() && results && results.projects.length + results.tasks.length + results.agents.length === 0 && (
            <p className="mt-8 text-sm text-gray-400">No results for “{q}”.</p>
          )}

          {results && results.projects.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Project</h2>
              <div className="mt-2 grid gap-2">
                {results.projects.map((p) => (
                  <Link key={p._id} href={`/chats/${p._id}`} className="rounded-xl border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-gray-500">{p.workspacePath}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results && results.tasks.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Task</h2>
              <div className="mt-2 grid gap-2">
                {results.tasks.map((t) => (
                  <Link key={t._id} href={`/chats/${t.projectId}`} className="rounded-xl border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
                    <p className="font-medium">{t.title}</p>
                    <p className="text-xs text-gray-500">{t.projectName} · {t.status}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results && results.agents.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Agent</h2>
              <div className="mt-2 grid gap-2">
                {results.agents.map((a) => (
                  <div key={a._id} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                    <AgentAvatar name={agentName(a)} size={32} status={a.status} avatarParams={a.avatarParams} />
                    <div className="min-w-0">
                      <p className="font-medium">{agentName(a)}</p>
                      <p className="text-xs text-gray-500">{agentRoleText(a) ? `${agentRoleText(a)} · ${a.status}` : a.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
