"use client";

import { forwardRef, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import InitialAvatar from "../InitialAvatar";
import QueryBoundary from "../shell/QueryBoundary";
import { roleLabel } from "@/lib/agentRoles";
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
import { projectMembers } from "@/lib/projectMembers";

export type TeamAgent = { _id: string; name: string; role: string; isEnabled?: boolean };

const SHOWN = 7;

function TeamRows({
  agents,
  status,
  drafting,
  onOpenAgent,
}: {
  agents: TeamAgent[];
  status?: StatusMap;
  drafting: string[];
  onOpenAgent: (agent: TeamAgent) => void;
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
          return (
            <li key={a._id}>
              <button
                type="button"
                onClick={() => onOpenAgent(a)}
                title={`${roleLabel(a.role)} — ${detail}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <InitialAvatar name={roleLabel(a.role)} size={24} status={disabled ? undefined : word} />
                <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{roleLabel(a.role)}</span>
                <span className={`max-w-[46%] shrink-0 truncate text-right text-[13px] ${disabled ? "text-ink-3" : teamStatusTone(word)}`}>{label}</span>
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
  const project = useQuery(api.projects.get, projectId ? { projectId: projectId as never } : "skip");
  const [drafting, setDrafting] = useState<string[]>([]);
  // Chat replies have no execution lease; ChatPanel announces who is drafting.
  useEffect(() => subscribeChatTyping((d) => setDrafting(d.active ? d.agentIds : [])), []);

  const memberIds = (project as { agentIds?: string[] } | null | undefined)?.agentIds;
  const q = filter.trim().toLowerCase();
  const agents = projectMembers(allAgents, memberIds)
    .filter((a) => !q || roleLabel(a.role).toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  const rowProps = { agents, drafting, onOpenAgent };

  return (
    <section ref={ref} aria-label="Team" className="scroll-mt-4">
      <SectionToggle title="Team" count={allAgents ? agents.length : undefined} open={open} onToggle={onToggle} onAdd={onAdd} addLabel="Create agent" chevron />
      {open && allAgents === undefined && (
        <div aria-hidden className="mt-1 space-y-2 px-2 py-1">
          {[55, 40, 62].map((w) => (
            <div key={w} className="flex items-center gap-2.5">
              <span className="h-6 w-6 animate-pulse rounded-full bg-hover" />
              <span className="h-3.5 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />
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
    </section>
  );
});

export default TeamList;
