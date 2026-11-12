"use client";

import { forwardRef, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import InitialAvatar from "../InitialAvatar";
import QueryBoundary from "../shell/QueryBoundary";
import { agentName, agentRoleText, roleLabel } from "@/lib/agentRoles";
import { useToast } from "../Toasts";
import { Trash2 } from "lucide-react";
import ConfirmDialog, { type ConfirmRequest } from "../ConfirmDialog";
import { subscribeChatTyping } from "@/lib/chatTyping";
import {
  TEAM_STATUS_RANK,
  teamStatusLabel,
  teamStatusTone,
  statusFromLeases,
  type LeaseEntry,
  type StatusMap,
  type TeamStatusWord,
} from "@/lib/teamStatus";
import { SectionToggle } from "./SectionToggle";

export type TeamAgent = { _id: string; name: string; role: string; isEnabled?: boolean; avatarParams?: unknown };

const SHOWN = 7;

function TeamRows({
  agents,
  status,
  drafting,
  onOpenAgent,
  onDeleteAgent,
}: {
  agents: TeamAgent[];
  status?: StatusMap;
  drafting: string[];
  onOpenAgent: (agent: TeamAgent) => void;
  onDeleteAgent: (agent: TeamAgent) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => {
    const word = (a: TeamAgent): TeamStatusWord => status?.[a._id]?.status ?? (drafting.includes(a._id) ? "working" : "idle");
    return [...agents].sort((a, b) => TEAM_STATUS_RANK[word(a)] - TEAM_STATUS_RANK[word(b)]);
  }, [agents, status, drafting]);
  const shown = showAll ? sorted : sorted.slice(0, SHOWN);
  return (
    <>
      <ul className="mt-1 space-y-px">
        {shown.map((a) => {
          const entry = status?.[a._id];
          const isDrafting = !entry && drafting.includes(a._id);
          const disabled = a.isEnabled === false;
          const word: TeamStatusWord = entry?.status ?? (isDrafting ? "working" : "idle");
          const label = disabled ? "disabled" : teamStatusLabel(entry, isDrafting);
          const detail = entry?.taskTitle ? `${label} · ${entry.taskTitle}` : label;
          const name = agentName(a);
          const roleText = agentRoleText(a);
          return (
            <li key={a._id} className="group relative">
              <button
                type="button"
                onClick={() => onOpenAgent(a)}
                title={`${name}${roleText ? ` (${roleText})` : ""} — ${detail}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <InitialAvatar agent avatarParams={a.avatarParams} name={name} size={24} status={disabled ? undefined : word} />
                <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
                  {name}
                  {roleText && <span className="text-[13px] text-ink-3">{` · ${roleText}`}</span>}
                </span>
                <span
                  className={`max-w-[46%] shrink-0 truncate text-right text-[13px] transition-opacity group-hover:opacity-0 ${disabled ? "text-ink-3" : teamStatusTone(word)}`}
                >
                  {label}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDeleteAgent(a)}
                aria-label={`Delete ${name}`}
                title={`Delete ${name}`}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-ink-3 opacity-0 transition hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      {sorted.length > SHOWN && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <span aria-hidden="true" className={`inline-block text-ink-3 transition-transform ${showAll ? "rotate-90" : ""}`}>›</span>
          {showAll ? "Show less" : `${sorted.length - SHOWN} more`}
        </button>
      )}
    </>
  );
}

function LiveRows({ projectId, ...rest }: Omit<Parameters<typeof TeamRows>[0], "status"> & { projectId: string }) {
  const status = useQuery(api.shell.teamStatus, { projectId: projectId as never }) as StatusMap | undefined;
  return <TeamRows {...rest} status={status} />;
}

/** Fallback when the live read model is unavailable: the execution lease view. */
function LeaseRows({ projectId, ...rest }: Omit<Parameters<typeof TeamRows>[0], "status"> & { projectId?: string }) {
  const active = useQuery(api.executionView.activeByAgent, {}) as Record<string, LeaseEntry> | undefined;
  const status = useMemo(
    () => statusFromLeases(active, { projectId, otherProjects: "elsewhere", checkFirst: "review" }),
    [active, projectId],
  );
  return <TeamRows {...rest} status={status} />;
}

const TeamList = forwardRef<
  HTMLElement,
  {
    projectId?: string;
    filter: string;
    open: boolean;
    onToggle: () => void;
    onAdd: () => void;
    onOpenAgent: (agent: TeamAgent) => void;
  }
>(function TeamList({ projectId, filter, open, onToggle, onAdd, onOpenAgent }, ref) {
  const allAgents = useQuery(api.agents.list, {}) as TeamAgent[] | undefined;
  const removeAgent = useMutation(api.agents.remove);
  const toast = useToast();
  const [drafting, setDrafting] = useState<string[]>([]);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  // Chat replies have no execution lease; ChatPanel announces who is drafting.
  useEffect(() => subscribeChatTyping((d) => setDrafting(d.active ? d.agentIds : [])), []);
  const askRemove = (agent: TeamAgent) => {
    const name = agentName(agent);
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

  const q = filter.trim().toLowerCase();
  // The sidebar team is the whole roster, not the clicked project's members:
  // clicking a project must not shrink or reorder the team list.
  const agents = (allAgents ?? []).filter(
    (a) => !q || roleLabel(a.role).toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
  );
  const rowProps = { agents, drafting, onOpenAgent, onDeleteAgent: askRemove };

  return (
    <section ref={ref} aria-label="Team" className="scroll-mt-4">
      <SectionToggle title="Team" count={allAgents ? agents.length : undefined} open={open} onToggle={onToggle} onAdd={onAdd} addLabel="Create agent" chevron />
      {open && allAgents === undefined && (
        <div aria-hidden className="mt-1 space-y-2 px-2 py-1">
          {[55, 40, 62].map((w) => (
            <div key={w} className="flex items-center gap-2.5">
              <span className="h-6 w-6 rounded-full bg-hover" />
              <span className="h-3.5 rounded bg-hover" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      )}
      {open && allAgents !== undefined && agents.length === 0 && (
        <p className="px-2 pt-1.5 text-[13px] text-ink-3">{q ? "No teammates match." : "No agents yet."}</p>
      )}
      {open && agents.length > 0 && (
        projectId ? (
          <QueryBoundary fallback={<LeaseRows {...rowProps} projectId={projectId} />}>
            <LiveRows {...rowProps} projectId={projectId} />
          </QueryBoundary>
        ) : (
          <LeaseRows {...rowProps} />
        )
      )}
      <ConfirmDialog request={confirmReq} pending={confirmPending} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
    </section>
  );
});

export default TeamList;
