"use client";

import { roleLabel } from "@/lib/agentRoles";
import type { RoutingView } from "@/api/convex/lib/routing";

/**
 * Intent & Routing Inspector: instruction → classification → planner →
 * each subtask's capability → agent (by role) and why → hand-offs. A plain
 * vertical flow with thin connector lines; data comes only from recorded
 * task events (runs.get → lib/routing.ts).
 */

const PLANNER_TEXT: Record<RoutingView["planner"]["mode"], string> = {
  cto: "Planned by the CTO",
  fallback: "Planned by the CTO as a stand-in planner",
  heuristic: "Deterministic fallback plan (no LLM planner)",
  unknown: "Planner not recorded",
};

function Node({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <li className="relative pl-6">
      {!last && <span className="absolute left-[5px] top-4 bottom-0 w-px bg-line" aria-hidden="true" />}
      <span className="absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border border-line-strong bg-panel" aria-hidden="true" />
      <p className="text-[11.5px] text-ink-3">{label}</p>
      <div className="pb-4 text-[13px] text-ink">{children}</div>
    </li>
  );
}

export default function RoutingInspector({ routing, instruction }: { routing: RoutingView; instruction: string | undefined }) {
  const c = routing.classification;
  const p = routing.planner;
  return (
    <ol className="rounded-xl border border-line bg-panel px-4 pt-3.5">
      <Node label="Instruction">
        <p className="line-clamp-2 break-words text-ink-2">{instruction ?? "—"}</p>
      </Node>
      <Node label="Classification">
        {c ? (
          <>
            <p>
              {c.kind ?? "unknown"}
              {c.complexity ? <span className="text-ink-2"> · {c.complexity} complexity</span> : null}
              {c.strategy ? <span className="text-ink-2"> · {c.strategy}</span> : null}
            </p>
            {c.concerns.length > 0 && <p className="mt-0.5 text-[12px] text-ink-2">Concerns: {c.concerns.join(", ")}</p>}
            {c.reasons.length > 0 && <p className="mt-0.5 text-[12px] text-ink-3">{c.reasons.slice(0, 4).join(" · ")}</p>}
          </>
        ) : (
          <p className="text-ink-3">Not recorded</p>
        )}
      </Node>
      <Node label="Planner">
        <p>
          {PLANNER_TEXT[p.mode]}
          {p.planVersion !== null ? <span className="text-ink-2"> · plan v{p.planVersion}</span> : null}
          {p.createdBy === "user" ? <span className="text-ink-2"> · edited by you</span> : null}
        </p>
        {p.reason && <p className="mt-0.5 text-[12px] text-ink-2">{p.reason}</p>}
        {p.reasoning && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-3">{p.reasoning}</p>}
      </Node>
      <Node label="Routing" last={routing.handoffs.length === 0}>
        {routing.subtasks.length === 0 ? (
          <p className="text-ink-3">No subtasks</p>
        ) : (
          <ul className="space-y-2">
            {routing.subtasks.map((s) => (
              <li key={s.key} className="min-w-0">
                <p className="truncate">
                  <span className="text-ink-2">{s.capability}</span>
                  <span className="text-ink-3"> → </span>
                  <span className="font-medium">{s.role ? roleLabel(s.role) : "not routed yet"}</span>
                  <span className="text-ink-3"> · {s.title}</span>
                </p>
                {s.why.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 text-[12px] text-ink-3">
                    {s.why.map((w) => (
                      <li key={w} className="line-clamp-2 break-words">{w}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Node>
      {routing.handoffs.length > 0 && (
        <Node label="Hand-offs" last>
          <ul className="space-y-1">
            {routing.handoffs.map((h, i) => (
              <li key={`${h.kind}-${h.from}-${h.to}-${i}`} className="text-[12.5px]">
                {roleLabel(h.from)} <span className="text-ink-3">→</span> {roleLabel(h.to)}
                <span className="text-ink-3">
                  {h.kind === "delegation" ? ` · delegation${h.decision ? ` (${h.decision.toLowerCase()})` : ""}` : " · dependency"}
                </span>
                {h.reason && <span className="block line-clamp-1 text-[12px] text-ink-3">{h.reason}</span>}
              </li>
            ))}
          </ul>
        </Node>
      )}
    </ol>
  );
}
