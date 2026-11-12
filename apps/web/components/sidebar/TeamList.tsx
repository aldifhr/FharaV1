"use client";

import { forwardRef, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import InitialAvatar from "../InitialAvatar";
import TeamStatusSource, { useDraftingAgentIds } from "../agents/TeamStatusSource";
import { agentName, agentRoleText, fixedAgentIds, roleLabel, teamInDisplayOrder } from "@/lib/agentRoles";
import { agentStatusView, type StatusMap } from "@/lib/teamStatus";
import { SectionToggle } from "./SectionToggle";

export type TeamAgent = { _id: string; _creationTime?: number; name: string; role: string; isEnabled?: boolean; avatarParams?: unknown };

/** Extra (non-fixed) agents shown before "N more"; the fixed team is always shown in full. */
const EXTRAS_SHOWN = 3;

function TeamRow({ agent, status, drafting, onOpen }: { agent: TeamAgent; status?: StatusMap; drafting: boolean; onOpen: () => void }) {
  const view = agentStatusView(status?.[agent._id], { isEnabled: agent.isEnabled, drafting });
  const name = agentName(agent);
  const roleText = agentRoleText(agent);
  const detail = view.detail ? `${view.label} · ${view.detail}` : view.label;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`${name}${roleText ? ` (${roleText})` : ""} — ${detail}`}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <InitialAvatar agent avatarParams={agent.avatarParams} name={name} size={24} status={view.avatar} />
        <span className={`min-w-0 flex-1 truncate text-[15px] ${view.kind === "disabled" ? "text-ink-3" : "text-ink"}`}>
          {name}
          {roleText && <span className="text-[13px] text-ink-3">{` · ${roleText}`}</span>}
        </span>
        <span
          data-status={view.kind}
          className={`flex max-w-[46%] shrink-0 items-center gap-1.5 truncate text-right text-[13px] ${view.needsYou ? "text-ink" : "text-ink-3"}`}
        >
          {view.needsYou && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />}
          <span className="truncate">{view.label}</span>
        </span>
      </button>
    </li>
  );
}

function TeamRows({
  agents,
  fixedIds,
  status,
  drafting,
  onOpenAgent,
}: {
  agents: TeamAgent[];
  fixedIds: ReadonlySet<string>;
  status?: StatusMap;
  drafting: string[];
  onOpenAgent: (agent: TeamAgent) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Fixed order (CTO first … then extra agents); never re-sorted by status.
  const ordered = useMemo(() => teamInDisplayOrder(agents, fixedIds), [agents, fixedIds]);
  const fixed = ordered.filter((a) => fixedIds.has(a._id));
  const extras = ordered.filter((a) => !fixedIds.has(a._id));
  const hidden = showAll ? 0 : Math.max(0, extras.length - EXTRAS_SHOWN);
  const shown = [...fixed, ...extras.slice(0, extras.length - hidden)];
  return (
    <>
      <ul className="mt-1 space-y-px">
        {shown.map((a) => (
          <TeamRow key={a._id} agent={a} status={status} drafting={drafting.includes(a._id)} onOpen={() => onOpenAgent(a)} />
        ))}
      </ul>
      {extras.length > EXTRAS_SHOWN && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <span aria-hidden="true" className={`inline-block text-ink-3 transition-transform ${showAll ? "rotate-90" : ""}`}>›</span>
          {showAll ? "Show less" : `${hidden} more`}
        </button>
      )}
    </>
  );
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
  const drafting = useDraftingAgentIds();

  const q = filter.trim().toLowerCase();
  // The sidebar team is the whole roster, not the clicked project's members:
  // clicking a project must not shrink or reorder the team list.
  const agents = (allAgents ?? []).filter(
    (a) => !q || roleLabel(a.role).toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
  );
  const fixedIds = useMemo(() => fixedAgentIds(allAgents), [allAgents]);

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
        <TeamStatusSource projectId={projectId}>
          {(status) => <TeamRows agents={agents} fixedIds={fixedIds} status={status} drafting={drafting} onOpenAgent={onOpenAgent} />}
        </TeamStatusSource>
      )}
    </section>
  );
});

export default TeamList;
