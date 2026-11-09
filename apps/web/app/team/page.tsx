"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { Bot, Cpu, Plus, Users } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import InitialAvatar from "@/components/InitialAvatar";
import AgentDetailPanel from "@/components/AgentDetailPanel";
import { CreateAgentModal, EditAgentModal } from "@/components/sidebar/AgentForms";
import { roleLabel } from "@/lib/agentRoles";
import { projectMembers } from "@/lib/projectMembers";
import {
  TEAM_STATUS_RANK,
  statusFromLeases,
  teamStatusLabel,
  teamStatusTone,
  type LeaseEntry,
  type TeamStatusWord,
} from "@/lib/teamStatus";

type Agent = {
  _id: string;
  name: string;
  role: string;
  isEnabled?: boolean;
  avatarParams?: unknown;
  llmModel?: string;
  opencodeModel?: string;
  executionRuntime?: string;
};

function runtimeLabel(a: Agent): string {
  return a.executionRuntime === "opencode" ? "OpenCode" : "Built-in";
}

function modelLabel(a: Agent): string {
  if (a.executionRuntime === "opencode" && a.opencodeModel) return a.opencodeModel;
  return a.llmModel || "Default model";
}

/**
 * Team page: every agent as a card with its live status (what task it is
 * on), model and runtime. A card opens the same detail panel as the
 * sidebar, which leads to Edit. `?project=<id>` limits it to that
 * project's members.
 */
function TeamPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const allAgents = useQuery(api.agents.list, {}) as Agent[] | undefined;
  const project = useQuery(api.projects.get, projectId ? { projectId: projectId as never } : "skip");
  const active = useQuery(api.executionView.activeByAgent, {}) as Record<string, LeaseEntry> | undefined;
  const [detail, setDetail] = useState<Agent | null>(null);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);

  const status = useMemo(
    () => statusFromLeases(active, { projectId, otherProjects: "elsewhere", checkFirst: "review" }),
    [active, projectId],
  );
  const memberIds = (project as { agentIds?: string[] } | null | undefined)?.agentIds;
  const agents = useMemo(() => {
    const list = projectId ? projectMembers(allAgents, memberIds) : allAgents ?? [];
    const word = (a: Agent): TeamStatusWord => status[a._id]?.status ?? "idle";
    return [...list].sort((a, b) => TEAM_STATUS_RANK[word(a)] - TEAM_STATUS_RANK[word(b)] || roleLabel(a.role).localeCompare(roleLabel(b.role)));
  }, [allAgents, memberIds, projectId, status]);
  const busy = agents.filter((a) => status[a._id] && a.isEnabled !== false).length;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-5xl">
          <motion.header
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-wrap items-start gap-3"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
              <Users size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold">Team</h1>
              <p className="mt-1 text-sm text-ink-3">
                {allAgents === undefined
                  ? "Loading agents…"
                  : `${agents.length} agent${agents.length === 1 ? "" : "s"}${(project as any)?.name ? ` in ${(project as any).name}` : ""} · ${busy} working now`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <Plus size={16} /> Create agent
            </button>
          </motion.header>

          {allAgents === undefined ? (
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-[132px] animate-pulse rounded-xl border border-line bg-panel" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <p className="mt-10 text-center text-sm text-ink-3">No agents yet. Create one to get started.</p>
          ) : (
            <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((a, i) => {
                const entry = status[a._id];
                const disabled = a.isEnabled === false;
                const word: TeamStatusWord = entry?.status ?? "idle";
                return (
                  <motion.li
                    key={a._id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(i, 8) * 0.03 }}
                  >
                    <button
                      type="button"
                      onClick={() => setDetail(a)}
                      className={`flex h-full w-full flex-col rounded-xl border border-line bg-panel p-4 text-left outline-none transition hover:border-brand/40 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-brand/40 ${disabled ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-center gap-3">
                        <InitialAvatar agent avatarParams={a.avatarParams} name={roleLabel(a.role)} size={40} status={disabled ? undefined : word} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{roleLabel(a.role)}</p>
                          <p className="truncate text-[13px] text-ink-3">@{a.name}</p>
                        </div>
                        <span className={`shrink-0 text-[12.5px] font-medium ${disabled ? "text-ink-3" : teamStatusTone(word)}`}>
                          {disabled ? "disabled" : teamStatusLabel(entry)}
                        </span>
                      </div>
                      <p className="mt-3 min-h-[20px] truncate text-[13px] text-ink-2">
                        {entry?.taskTitle ? entry.taskTitle : <span className="text-ink-3">No task right now</span>}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1.5 text-[11.5px] text-ink-3">
                        <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-hover px-1.5 py-0.5">
                          <Cpu size={12} className="shrink-0" />
                          <span className="truncate">{modelLabel(a)}</span>
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-md bg-hover px-1.5 py-0.5">
                          <Bot size={12} /> {runtimeLabel(a)}
                        </span>
                      </div>
                    </button>
                  </motion.li>
                );
              })}
            </ul>
          )}
        </div>
      </main>

      {detail && (
        <AgentDetailPanel
          agent={(allAgents ?? []).find((a) => a._id === detail._id) ?? detail}
          onClose={() => setDetail(null)}
          onEdit={(a: Agent) => {
            setDetail(null);
            setEditing(a);
          }}
        />
      )}
      {creating && <CreateAgentModal agents={(allAgents ?? []) as any} onClose={() => setCreating(false)} />}
      {editing && <EditAgentModal agent={editing as any} onClose={() => setEditing(null)} />}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TeamPage />
    </Suspense>
  );
}
