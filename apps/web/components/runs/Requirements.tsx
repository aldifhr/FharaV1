"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import {
  REQUIREMENT_STATE_LABELS,
  type RequirementCoverage,
  type RequirementState,
} from "@/api/convex/lib/requirements";

/**
 * Plan 025: requirement → subtasks → acceptance → evidence → state. The
 * state is computed by the same deterministic check the worker runs
 * before "done". Plain rows, divide-y, theme tokens only.
 */

function stateTone(state: RequirementState): string {
  if (state === "covered") return "text-ink";
  if (state === "missing_evidence") return "text-warn";
  return "text-destructive";
}

function evidenceTone(status: string): string {
  if (status === "pass") return "text-ink-2";
  if (status === "fail") return "text-destructive";
  return "text-ink-3";
}

function RequirementItem({ entry, quote }: { entry: RequirementCoverage; quote?: string }) {
  const [open, setOpen] = useState(entry.state !== "covered");
  return (
    <li className="py-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      >
        {open ? <ChevronDown size={13} className="shrink-0 self-center text-ink-3" /> : <ChevronRight size={13} className="shrink-0 self-center text-ink-3" />}
        <span className="shrink-0 font-mono text-[11.5px] text-ink-3">{entry.requirement.id}</span>
        <span className="min-w-0 flex-1 break-words text-ink">{entry.requirement.text}</span>
        <span className={`shrink-0 ${stateTone(entry.state)}`}>{REQUIREMENT_STATE_LABELS[entry.state]}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 pl-6 text-[12.5px]">
          {quote && quote !== entry.requirement.text && (
            <p className="break-words text-ink-3">“{quote}”</p>
          )}
          {entry.reason && <p className={`break-words ${stateTone(entry.state)}`}>{entry.reason}</p>}
          {entry.subtasks.length > 0 && (
            <ul className="divide-y divide-line">
              {entry.subtasks.map((subtask) => (
                <li key={subtask.key} className="py-1.5">
                  <p className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-ink-2">{subtask.title}</span>
                    <span className="shrink-0 text-ink-3">
                      {subtask.status.replace(/_/g, " ")}
                      {subtask.acceptanceStatus ? ` · ${subtask.acceptanceStatus}` : ""}
                    </span>
                  </p>
                  {subtask.acceptance.length > 0 && (
                    <p className="break-words text-ink-3">Acceptance: {subtask.acceptance.join("; ")}</p>
                  )}
                  {subtask.evidence.length === 0 ? (
                    <p className="text-ink-3">No evidence yet</p>
                  ) : (
                    <ul className="mt-0.5 space-y-0.5">
                      {subtask.evidence.map((item, index) => (
                        <li key={`${item.kind}:${item.ref}:${index}`} className={`break-words ${evidenceTone(item.status)}`}>
                          {item.status === "pass" ? "✓" : item.status === "fail" ? "✕" : "–"} {item.kind}
                          <span className="font-mono text-[11.5px]"> {item.ref}</span>
                          {item.summary ? <span className="text-ink-3"> · {item.summary}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function Requirements({
  taskId,
  title = "Requirements",
  variant = "page",
}: {
  taskId: string;
  title?: string;
  /** "page" = a /runs section; "thread" = inline in the task thread. */
  variant?: "page" | "thread";
}) {
  const data = useQuery(api.traceability.requirements, { taskId: taskId as never });
  if (data === undefined) {
    return <div className={`${variant === "page" ? "mt-10 " : ""}h-10 animate-pulse rounded-lg bg-hover`} aria-label="Loading requirements" />;
  }
  if (!data?.report || data.report.requirements.length === 0) return null;
  const { report, coverage } = data;
  const gaps = report.uncovered.length + report.missingEvidence.length;
  return (
    <section className={variant === "page" ? "mt-10" : undefined} aria-label={title}>
      <h2 className={`mb-2 flex items-baseline gap-2 text-[13px] ${variant === "page" ? "font-medium text-ink-2" : "font-normal text-ink-3"}`}>
        {title}
        <span className="tabular-nums text-ink-3">
          {report.covered.length}/{report.requirements.length} covered
        </span>
        {coverage?.outcome === "completed_with_gaps" && <span className="text-destructive">· Completed with gaps</span>}
        {coverage?.outcome !== "completed_with_gaps" && gaps > 0 && (
          <span className="text-warn">
            · {gaps} {gaps === 1 ? "gap" : "gaps"}
          </span>
        )}
      </h2>
      <ul className="divide-y divide-line border-y border-line">
        {report.requirements.map((entry) => (
          <RequirementItem key={entry.requirement.id} entry={entry} quote={data.quotes[entry.requirement.id]} />
        ))}
      </ul>
    </section>
  );
}
