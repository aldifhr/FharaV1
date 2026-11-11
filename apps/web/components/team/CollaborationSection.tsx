"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Segmented from "@/components/ui/segmented";
import GraphCanvas from "@/components/graph/GraphCanvas";
import { positionRing } from "@/lib/dagLayout";

type Days = "7" | "30" | "90";
const DAY_OPTIONS: ReadonlyArray<{ value: Days; label: string }> = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
];

type EdgeType = "delegation" | "chat" | "review_loop" | "dependency";
const EDGE_TYPES: ReadonlyArray<{ key: EdgeType; label: string; one: string; many: string }> = [
  { key: "delegation", label: "Delegations", one: "delegation", many: "delegations" },
  { key: "chat", label: "Chat handoffs", one: "chat handoff", many: "chat handoffs" },
  { key: "review_loop", label: "Review/QA → fix", one: "review/QA fix", many: "review/QA fixes" },
  { key: "dependency", label: "Dependencies", one: "dependency", many: "dependencies" },
];

const SIZE = { nodeW: 108, nodeH: 34, pad: 16, minRadius: 150 };

/**
 * Collaboration graph (orgIntel.collaboration): roles as nodes, weighted
 * edges counting delegations, CTO chat handoffs, review/QA → fix loops and
 * cross-role DAG dependencies. Toggle edge types; the list below the graph
 * gives every edge with its breakdown.
 */
export default function CollaborationSection() {
  const [projectId, setProjectId] = useState<string>("");
  const [days, setDays] = useState<Days>("30");
  const [types, setTypes] = useState<Record<EdgeType, boolean>>({ delegation: true, chat: true, review_loop: true, dependency: true });
  const projects = useQuery(api.projects.list, {}) as { _id: string; name: string }[] | undefined;
  const data = useQuery(api.orgIntel.collaboration, {
    sinceDays: Number(days),
    ...(projectId ? { projectId: projectId as never } : {}),
  });

  const view = useMemo(() => {
    if (!data) return null;
    const edges = data.edges
      .map((e) => {
        const weight = EDGE_TYPES.reduce((sum, t) => sum + (types[t.key] ? e.counts[t.key] : 0), 0);
        const parts = EDGE_TYPES.filter((t) => types[t.key] && e.counts[t.key] > 0).map(
          (t) => `${e.counts[t.key]} ${e.counts[t.key] === 1 ? t.one : t.many}`
        );
        return { ...e, weight, parts };
      })
      .filter((e) => e.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    const label = new Map(data.nodes.map((n) => [n.key, n.label]));
    const pos = positionRing(data.nodes.map((n) => n.key), SIZE);
    return { edges, label, pos };
  }, [data, types]);

  return (
    <section className="mt-14" aria-labelledby="collab-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="collab-heading" className="text-[17px] font-semibold tracking-tight">
          Collaboration
        </h2>
        <div className="flex items-center gap-2">
          {projects && projects.length > 1 && (
            <select
              aria-label="Project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-[30px] max-w-[180px] truncate rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Segmented label="Time window" value={days} options={DAY_OPTIONS} onChange={setDays} />
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Edge types">
        {EDGE_TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={types[t.key]}
            onClick={() => setTypes((cur) => ({ ...cur, [t.key]: !cur[t.key] }))}
            className={`rounded-lg border border-line px-2.5 py-1 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 ${
              types[t.key] ? "bg-hover font-medium text-ink" : "bg-panel text-ink-3 hover:text-ink"
            }`}
          >
            {t.label}
            {data ? <span className="tabular-nums text-ink-3"> {data.totals[t.key]}</span> : null}
          </button>
        ))}
      </div>

      {!data || !view ? (
        <div className="mt-6 h-72 animate-pulse rounded-xl bg-hover" aria-label="Loading collaboration" />
      ) : (
        <>
          <div className="mt-6">
            <GraphCanvas
              ariaLabel="Collaboration graph"
              route="direct"
              width={view.pos.width}
              height={view.pos.height}
              edges={view.edges.map((e) => ({
                from: e.from,
                to: e.to,
                weight: e.weight,
                label: String(e.weight),
                title: `${view.label.get(e.from)} → ${view.label.get(e.to)}: ${e.parts.join(", ")}`,
              }))}
              nodes={data.nodes.map((n) => ({
                key: n.key,
                ...view.pos.boxOf(n.key),
                muted: n.weight === 0,
                label: n.label,
                title: `${n.label}${n.recognized ? "" : " (custom role)"}`,
                children: <span className="truncate text-center text-[12px] font-medium text-ink">{n.label}</span>,
              }))}
            />
          </div>
          {view.edges.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">No collaboration of the selected kinds in {days} days.</p>
          ) : (
            <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
              {view.edges.slice(0, 12).map((e) => (
                <li key={`${e.from}->${e.to}`} className="flex items-baseline gap-3 px-4 py-2">
                  <span className="w-44 shrink-0 truncate">
                    {view.label.get(e.from)} <span className="text-ink-3">→</span> {view.label.get(e.to)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-3">{e.parts.join(" · ")}</span>
                  <span className="shrink-0 tabular-nums">{e.weight}</span>
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-3 space-y-1 text-[12px] text-ink-3">
            {data.totals.chatInferred > 0 && (
              <li>
                {data.totals.chatInferred} chat handoff(s) are inferred from the CTO&apos;s @mentions in older replies;{" "}
                {data.totals.chatRecorded} were recorded when they happened.
              </li>
            )}
            {data.truncated.length > 0 && <li>Read limit reached for {data.truncated.join(", ")}; older rows are left out.</li>}
          </ul>
        </>
      )}
    </section>
  );
}
