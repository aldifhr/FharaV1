"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import InitialAvatar from "@/components/InitialAvatar";
import AgentDetailPanel from "@/components/AgentDetailPanel";
import WorkloadSection from "@/components/WorkloadSection";
import CollaborationSection from "@/components/team/CollaborationSection";
import { CreateAgentModal } from "@/components/sidebar/AgentForms";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { agentName, agentRoleText, fixedAgentIds } from "@/lib/agentRoles";
import { projectMembers } from "@/lib/projectMembers";
import { teamHeadline, teamLoaded } from "@/lib/teamHeadline";
import { useHydrated } from "@/lib/useHydrated";
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

function runtimeLabel(opencode: { runtime?: string; viaModelList?: boolean } | undefined): string {
  // Plan 035: the runtime is app-wide (Settings → LLM & Models). Plan 038:
  // with the OpenCode provider, the model list picks it per subtask.
  if (opencode?.viaModelList) return "Model list";
  return opencode?.runtime === "opencode" ? "OpenCode" : "Built-in";
}

function modelLabel(a: Agent): string {
  // The agent's own Fhara model; the OpenCode model is app-wide.
  return a.llmModel || "Default model";
}

/**
 * Team page: every agent as a card with its live status (what task it is
 * on), model and runtime. A card opens the same detail panel as the
 * sidebar, which leads to Edit. `?project=<id>` limits it to that
 * project's members. Below the roster: the org chart, live capacity (and
 * the load-aware routing setting), Workload (how work is spread across
 * roles, workload.byRole) and the collaboration graph (orgIntel.ts).
 */
function TeamPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const allAgents = useQuery(api.agents.list, {}) as Agent[] | undefined;
  const project = useQuery(api.projects.get, projectId ? { projectId: projectId as never } : "skip");
  const active = useQuery(api.executionView.activeByAgent, {}) as Record<string, LeaseEntry> | undefined;
  // Plan 035: the OpenCode runtime is app-wide (Settings → LLM & Models).
  const opencode = useQuery(api.opencodeSettings.get, {});
  const [detail, setDetail] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);
  const removeAgent = useMutation(api.agents.remove);
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  // Fixed-team roles can't be removed; extra and custom agents can.
  const fixedIds = useMemo(() => fixedAgentIds(allAgents), [allAgents]);
  const askRemove = (agent: Agent) => {
    const name = agentName(agent);
    setDetail(null);
    setConfirmReq({
      title: `Remove agent "${name}"?`,
      message: "This agent will also be removed from projects that use it.",
      confirmLabel: "Remove agent",
      onOk: async () => {
        setConfirmPending(true);
        try {
          await removeAgent({ agentId: agent._id as never });
          toast("success", "Agent removed", name);
          setConfirmReq(null);
        } catch (err) {
          toast("error", "Failed to remove agent", err instanceof Error ? err.message : "Please try again.");
        } finally {
          setConfirmPending(false);
        }
      },
    });
  };
  // The server always renders the loading state; the client's first render
  // must match it even when the query already has data (hydration).
  const hydrated = useHydrated();
  const loaded = teamLoaded(hydrated, allAgents);

  const status = useMemo(
    () => statusFromLeases(active, { projectId, otherProjects: "elsewhere", checkFirst: "review" }),
    [active, projectId],
  );
  const memberIds = (project as { agentIds?: string[] } | null | undefined)?.agentIds;
  const agents = useMemo(() => {
    const list = projectId ? projectMembers(allAgents, memberIds) : allAgents ?? [];
    const word = (a: Agent): TeamStatusWord => status[a._id]?.status ?? "idle";
    return [...list].sort((a, b) => TEAM_STATUS_RANK[word(a)] - TEAM_STATUS_RANK[word(b)] || agentName(a).localeCompare(agentName(b)));
  }, [allAgents, memberIds, projectId, status]);
  const busy = agents.filter((a) => status[a._id] && a.isEnabled !== false).length;

  const projectName = (project as { name?: string } | null | undefined)?.name;
  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              {hydrated && projectName && <p className="truncate text-[13px] text-ink-3">{projectName}</p>}
              <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Team</h1>
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <Plus size={14} /> Agent
            </button>
          </header>
          <p className="mt-6 text-[15px] text-ink-2">
            {teamHeadline(loaded, agents.length, busy)}
          </p>

          {!loaded ? (
            <div className="mt-10 space-y-3" aria-label="Loading team">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-14 rounded-xl bg-hover" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <p className="mt-10 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">No agents yet. Add one to get started.</p>
          ) : (
            <ul className="mt-10 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {agents.map((a) => {
                const entry = status[a._id];
                const disabled = a.isEnabled === false;
                const word: TeamStatusWord = entry?.status ?? "idle";
                const active = !disabled && word !== "idle";
                const roleText = agentRoleText(a);
                return (
                  <li key={a._id}>
                    <button
                      type="button"
                      onClick={() => setDetail(a)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition hover:bg-hover focus-visible:bg-hover ${disabled ? "opacity-50" : ""}`}
                    >
                      <InitialAvatar agent avatarParams={a.avatarParams} name={agentName(a)} size={32} status={active ? word : undefined} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px]">
                          <span className="font-medium">{agentName(a)}</span>
                          {roleText && <span className="text-ink-3">{` · ${roleText}`}</span>}
                          <span className={active ? ` ${teamStatusTone(word)}` : " text-ink-3"}>
                            {" · "}
                            {disabled ? "disabled" : teamStatusLabel(entry)}
                          </span>
                        </p>
                        <p className="truncate text-[12.5px] text-ink-3">
                          {entry?.taskTitle ?? `${modelLabel(a)} · ${runtimeLabel(opencode)}`}
                        </p>
                      </div>
                      {active && <span className="shell-dots flex shrink-0 items-center gap-[3px] text-ink-3" aria-hidden="true"><i /><i /><i /></span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <WorkloadSection />
          <CollaborationSection />
        </div>
      </main>

      {detail && (
        <AgentDetailPanel
          agent={(allAgents ?? []).find((a) => a._id === detail._id) ?? detail}
          onClose={() => setDetail(null)}
          onRemove={fixedIds.has(detail._id) ? undefined : askRemove}
        />
      )}
      <ConfirmDialog request={confirmReq} pending={confirmPending} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      {creating && <CreateAgentModal agents={(allAgents ?? []) as any} onClose={() => setCreating(false)} />}
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
