"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ESCALATION_LABELS, type EscalationKind } from "@/api/convex/lib/subtaskContract";

/**
 * Plan 022: per-subtask contract and acceptance on /runs. Acceptance is
 * shown apart from the execution status: delivered (gates not evaluated
 * yet) → accepted / rejected / blocked, or escalated. Each gate lists its
 * pass / fail / skipped result with the evidence it was judged on. Plain
 * text with status dots and theme tokens; no pills.
 */

type Gate = { id: string; criterion: string; check: string; target?: string; required?: boolean };
type GateResult = { gateId: string; status: "pass" | "fail" | "skipped"; evidence: { kind: string; ref?: string; summary: string } };
export type ContractRow = {
  key: string;
  title: string;
  kind: string;
  status: string;
  origin: string | null;
  objective: string | null;
  scope: string[];
  constraints: string[];
  deliverable: string | null;
  acceptance: Gate[];
  acceptanceStatus: string | null;
  acceptanceReason: string | null;
  gateResults: GateResult[];
  escalation: { kind: string; reason: string; detail?: string; source?: string } | null;
};

const ACCEPTANCE_LABEL: Record<string, string> = {
  delivered: "Delivered · gates pending",
  accepted: "Accepted",
  rejected: "Gates failed",
  blocked: "Blocked",
  escalated: "Escalated",
};

function acceptanceDot(status: string | null): string {
  switch (status) {
    case "accepted":
      return "bg-emerald-500";
    case "rejected":
    case "blocked":
      return "bg-red-500";
    case "escalated":
      return "bg-orange-500";
    default:
      return "bg-ink-3";
  }
}

function gateMark(status: GateResult["status"] | undefined): { glyph: string; cls: string; label: string } {
  if (status === "pass") return { glyph: "✓", cls: "text-emerald-600 dark:text-emerald-400", label: "pass" };
  if (status === "fail") return { glyph: "✕", cls: "text-red-600 dark:text-red-400", label: "fail" };
  if (status === "skipped") return { glyph: "–", cls: "text-ink-3", label: "skipped" };
  return { glyph: "·", cls: "text-ink-3", label: "not evaluated" };
}

function ContractItem({ row }: { row: ContractRow }) {
  const [open, setOpen] = useState(row.acceptanceStatus === "rejected" || row.acceptanceStatus === "escalated" || row.acceptanceStatus === "blocked");
  const results = new Map(row.gateResults.map((result) => [result.gateId, result]));
  const passed = row.gateResults.filter((result) => result.status === "pass").length;
  return (
    <li className="px-4 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${acceptanceDot(row.acceptanceStatus)}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ink">{row.title}</span>
        <span className="shrink-0 text-ink-3">
          {row.acceptanceStatus ? ACCEPTANCE_LABEL[row.acceptanceStatus] ?? row.acceptanceStatus : row.status.replace(/_/g, " ")}
          {row.gateResults.length > 0 && <span className="tabular-nums"> · {passed}/{row.acceptance.length} gates</span>}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 pl-6 text-[12.5px]">
          {row.objective && (
            <p className="break-words text-ink-2">
              <span className="text-ink-3">Objective </span>
              {row.objective}
            </p>
          )}
          {row.scope.length > 0 && (
            <p className="break-words font-mono text-[11.5px] text-ink-3" title="Scope (allowedPaths)">
              {row.scope.join("  ")}
            </p>
          )}
          {row.constraints.length > 0 && (
            <p className="break-words text-ink-2">
              <span className="text-ink-3">Must not change </span>
              {row.constraints.join("; ")}
            </p>
          )}
          {row.deliverable && (
            <p className="break-words text-ink-2">
              <span className="text-ink-3">Deliverable </span>
              {row.deliverable}
            </p>
          )}
          {row.escalation && (
            <p className="break-words text-orange-700 dark:text-orange-300">
              {ESCALATION_LABELS[row.escalation.kind as EscalationKind] ?? row.escalation.kind}
              {row.escalation.detail ? ` (${row.escalation.detail})` : ""}: {row.escalation.reason}
            </p>
          )}
          {row.acceptanceReason && row.acceptanceStatus !== "escalated" && (
            <p className="break-words text-red-600 dark:text-red-400">{row.acceptanceReason}</p>
          )}
          {row.acceptance.length > 0 && (
            <ul className="space-y-1">
              {row.acceptance.map((gate) => {
                const result = results.get(gate.id);
                const mark = gateMark(result?.status);
                return (
                  <li key={gate.id} className="flex items-start gap-2">
                    <span className={`w-3 shrink-0 text-center ${mark.cls}`} aria-label={mark.label}>
                      {mark.glyph}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      <span className="text-ink">{gate.criterion}</span>
                      <span className="text-ink-3">
                        {" "}· {gate.check.replace(/_/g, " ")}
                        {gate.target ? ` ${gate.target}` : ""}
                        {gate.required === false || (gate.check === "manual" && gate.required !== true) ? " · optional" : ""}
                      </span>
                      {result && (
                        <span className="block text-ink-3">
                          {result.evidence.summary}
                          {result.evidence.ref ? <span className="font-mono text-[11.5px]"> · {result.evidence.ref}</span> : null}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function Contracts({ rows }: { rows: ContractRow[] }) {
  const planned = rows.filter((row) => row.acceptance.length > 0 || row.objective || row.escalation);
  if (planned.length === 0) return null;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
      {planned.map((row) => (
        <ContractItem key={row.key} row={row} />
      ))}
    </ul>
  );
}
