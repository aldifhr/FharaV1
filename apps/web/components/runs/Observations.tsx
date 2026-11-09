"use client";

import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { OBSERVATION_LABELS, type ObservationType } from "@/api/convex/lib/observations";

/**
 * Plan 025: the typed execution observations of a run, oldest first — the
 * structured facts the decision engine receives. A plain list.
 */

const ATTENTION = new Set<ObservationType>([
  "agent_failed",
  "test_failed",
  "gate_failed",
  "scope_violation",
  "no_progress",
  "dependency_blocked",
  "provider_error",
]);

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Observations({ taskId }: { taskId: string }) {
  const rows = useQuery(api.traceability.observations, { taskId: taskId as never });
  if (rows === undefined) {
    return <div className="mt-10 h-10 animate-pulse rounded-lg bg-hover" aria-label="Loading observations" />;
  }
  if (!rows || rows.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        Observations
        <span className="tabular-nums text-ink-3">{rows.length}</span>
      </h2>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((row) => {
          const type = row.eventType as ObservationType;
          const facts = [
            row.facts.errorCode,
            row.facts.affectedFiles?.length ? `${row.facts.affectedFiles.length} file(s): ${row.facts.affectedFiles.slice(0, 3).join(", ")}` : null,
            row.facts.findings?.[0] ?? null,
          ].filter(Boolean);
          return (
            <li key={row._id} className="flex items-baseline gap-3 py-2 text-[12.5px]">
              <span className="w-16 shrink-0 tabular-nums text-ink-3">{clock(row.observedAt)}</span>
              <span className={`w-36 shrink-0 ${ATTENTION.has(type) ? "text-destructive" : "text-ink"}`}>
                {OBSERVATION_LABELS[type] ?? row.eventType}
              </span>
              <span className="min-w-0 flex-1 break-words text-ink-2">
                {[row.source.subtaskKey, row.source.tool].filter(Boolean).join(" · ")}
                {facts.length > 0 && <span className="text-ink-3"> — {facts.join(" · ")}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
