"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import type { VerificationCardData } from "@/api/convex/cardTypes";
import { CARD_DIVIDER, CardHeader, CardShell, IconTile, MUTED, Pill, StatusWord, formatDuration } from "./primitives";

const OUTCOME = {
  passed: { tone: "green", label: "Passed" },
  failed: { tone: "red", label: "Failed" },
  inconclusive: { tone: "gray", label: "Inconclusive" },
} as const;

/** Build / test / lint results per check. A step that did not run says so. */
/**
 * Per-phase label: the fix count restarts after each QA fix round, so a
 * re-verification after QA reads "after QA fix", not "after fix 2" again.
 */
function verificationTitle(data: VerificationCardData): string {
  const phase = typeof data.phase === "number" ? data.phase : 0;
  const base = phase > 0 ? `Verification after QA fix${phase > 1 ? ` ${phase}` : ""}` : "Verification";
  if (data.iteration > 0) return phase > 0 ? `${base} · fix ${data.iteration}` : `Verification after fix ${data.iteration}`;
  return base;
}

export default function VerificationCard({ data }: { data: VerificationCardData }) {
  const [showLog, setShowLog] = useState(false);
  const outcome = OUTCOME[data.outcome] ?? OUTCOME.inconclusive;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const duration = formatDuration(data.durationMs);
  const targets = new Set(checks.map((c) => c.target).filter(Boolean));
  return (
    <CardShell
      header={
        <CardHeader
          icon={
            <IconTile tone={data.outcome === "failed" ? "red" : data.outcome === "passed" ? "green" : "gray"}>
              <ShieldCheck size={15} />
            </IconTile>
          }
          title={verificationTitle(data)}
          subtitle={[duration && `took ${duration}`, checks.length === 0 && "no checks reported"].filter(Boolean).join(" · ") || undefined}
          pill={<Pill tone={outcome.tone}>{outcome.label}</Pill>}
        />
      }
    >
      {checks.length > 0 && (
        <ul className={`border-t px-4 py-2 ${CARD_DIVIDER}`}>
          {checks.map((check, index) => (
            <li key={`${check.target ?? ""}:${check.name}:${index}`} className="flex items-center gap-3 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium capitalize text-ink">{check.name}</span>
                {targets.size > 1 && check.target && <span className={`ml-1.5 font-mono text-[11px] ${MUTED}`}>{check.target}</span>}
                {check.detail && check.status !== "passed" && (
                  <span className={`ml-2 text-[12px] ${MUTED}`}>{check.detail}</span>
                )}
              </span>
              {formatDuration(check.durationMs) && (
                <span className={`shrink-0 tabular-nums text-[11px] ${MUTED}`}>{formatDuration(check.durationMs)}</span>
              )}
              <span className="w-24 shrink-0 text-right text-[12px]">
                <StatusWord
                  status={check.status}
                  size={13}
                  label={
                    check.status === "passed" && check.counts
                      ? `${check.counts.passed} of ${check.counts.total}`
                      : undefined
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.logTail && (
        <div className={`border-t ${CARD_DIVIDER}`}>
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            aria-expanded={showLog}
            className={`flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12px] font-medium outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 ${MUTED}`}
          >
            {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Log tail
          </button>
          {showLog && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-panel-2 px-4 py-3 font-mono text-[11px] leading-5 text-ink-2">
              {data.logTail}
            </pre>
          )}
        </div>
      )}
    </CardShell>
  );
}
