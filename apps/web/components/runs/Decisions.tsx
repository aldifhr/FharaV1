"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { DECISION_TYPE_LABELS, type DecisionType } from "@/api/convex/lib/calibration/capture";
import ContextInspector from "@/components/context/ContextInspector";

/**
 * Decision Outcome Calibration: each orchestrator decision of the run →
 * what it expected → its deterministic outcome label → the factors. A
 * plain list; the label is coloured text, never a pill.
 */

const LABEL_TEXT: Record<string, string> = {
  good: "Good",
  suboptimal: "Suboptimal",
  bad: "Bad",
  unknown: "Unknown",
};
const LABEL_CLASS: Record<string, string> = {
  good: "text-ink",
  suboptimal: "text-warn",
  bad: "text-destructive",
  unknown: "text-ink-3",
};

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Decisions({ taskId }: { taskId: string }) {
  const rows = useQuery(api.calibration.forTask, { taskId: taskId as never });
  const [open, setOpen] = useState<string | null>(null);
  if (!rows || rows.length === 0) return null;
  const bad = rows.filter((row) => row.label === "bad").length;
  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink-2">
        <span className="flex items-baseline gap-2">
          Decisions
          <span className="tabular-nums text-ink-3">{rows.length}</span>
          {bad > 0 && <span className="tabular-nums text-destructive">{bad} bad</span>}
        </span>
      </h2>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((row) => {
          const expected = row.expected?.objective ?? row.expected?.note ?? null;
          return (
            <li key={row._id} className="py-2.5 text-[12.5px]">
              <div className="flex items-baseline gap-3">
                <span className="w-16 shrink-0 tabular-nums text-ink-3">{clock(row.decidedAt)}</span>
                <span className="w-28 shrink-0 text-ink-2">{DECISION_TYPE_LABELS[row.type as DecisionType] ?? row.type}</span>
                <span className="min-w-0 flex-1 break-words text-ink">
                  {row.chosen}
                  {row.subtaskKey && <span className="text-ink-3"> · {row.subtaskKey}</span>}
                </span>
                <span className={`shrink-0 ${LABEL_CLASS[row.label] ?? "text-ink-3"}`} title={row.final ? "Final" : "Provisional: the run is still going"}>
                  {LABEL_TEXT[row.label] ?? row.label}
                  {!row.final && row.label !== "unknown" ? "*" : ""}
                </span>
              </div>
              <div className="ml-[7.75rem] mt-0.5 space-y-0.5 text-ink-3 max-[640px]:ml-0">
                {row.reason && <p className="break-words">Why: {row.reason}</p>}
                {row.alternatives.length > 0 && <p className="break-words">Considered: {row.alternatives.join(", ")}</p>}
                {expected && <p className="break-words">Expected: {expected}</p>}
                {row.expected?.requirements && row.expected.requirements.length > 0 && (
                  <p className="break-words">Serves: {row.expected.requirements.join("; ")}</p>
                )}
                {row.factors.length > 0 && <p className="break-words text-ink-2">{row.factors.join(" · ")}</p>}
                {row.snapshotId && (
                  <button
                    type="button"
                    onClick={() => setOpen((current) => (current === row._id ? null : row._id))}
                    className="text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink"
                  >
                    {open === row._id ? "Hide inputs" : "Inputs"}
                  </button>
                )}
              </div>
              {open === row._id && row.snapshotId && (
                <div className="mt-3 border-t border-line pt-3">
                  <ContextInspector snapshotId={row.snapshotId} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
