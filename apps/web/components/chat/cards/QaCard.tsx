"use client";

import { Check, Loader2, Minus, X } from "lucide-react";
import type { QaCardData, QaCardRow } from "@/api/convex/cardTypes";
import { CARD_DIVIDER, CardShell, MUTED, Pill } from "./primitives";

const OUTCOME = {
  running: { tone: "blue", label: "Running" },
  passed: { tone: "green", label: "Passed" },
  failed: { tone: "red", label: "Issues found" },
  blocked: { tone: "gray", label: "Skipped" },
} as const;

function RowIcon({ status }: { status: QaCardRow["status"] }) {
  if (status === "passed") return <Check size={15} strokeWidth={2.5} className="text-[#1f9d55] dark:text-emerald-400" aria-hidden="true" />;
  if (status === "failed") return <X size={15} strokeWidth={2.5} className="text-[#d83a3a] dark:text-rose-400" aria-hidden="true" />;
  if (status === "running") return <Loader2 size={15} strokeWidth={2.5} className="animate-spin text-[#e5671f] dark:text-orange-400" aria-hidden="true" />;
  return <Minus size={15} strokeWidth={2.5} className="text-[#b9b6c2] dark:text-neutral-600" aria-hidden="true" />;
}

const ROW_WORD: Record<QaCardRow["status"], string> = {
  passed: "clean",
  failed: "issues",
  running: "running",
  pending: "queued",
  not_run: "not run",
};

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Checklist of viewports (or the one structural pass) with live status. */
export default function QaCard({ data }: { data: QaCardData }) {
  const outcome = OUTCOME[data.outcome] ?? OUTCOME.blocked;
  const rows: QaCardRow[] =
    Array.isArray(data.rows) && data.rows.length > 0
      ? data.rows
      : (data.checks ?? []).map((check) => ({
          label: check.label,
          status: check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "not_run",
          detail: check.detail,
        }));
  const urls = Array.isArray(data.urls) ? data.urls : [];
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const intro =
    data.outcome === "blocked"
      ? "QA skipped"
      : rows.length > 1
        ? `Checking on ${rows.length === 3 ? "three" : rows.length} widths`
        : "Browser check";
  return (
    <CardShell>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-[#26242e] dark:text-neutral-100">
            {intro}
            {data.iteration > 0 ? <span className={`ml-1.5 text-[12px] font-normal ${MUTED}`}>after fix {data.iteration}</span> : null}
          </p>
          {urls.length > 0 && (
            <p className={`mt-0.5 truncate text-[12px] ${MUTED}`}>
              {urls.map((url) => (
                <code key={url} className="mr-1.5 rounded bg-[#f3f2f7] px-1 py-px font-mono text-[11px] text-[#4c4a55] dark:bg-white/10 dark:text-neutral-200">
                  {hostOf(url)}
                </code>
              ))}
            </p>
          )}
        </div>
        <Pill tone={outcome.tone}>{outcome.label}</Pill>
      </div>
      {data.reason && <p className={`px-4 pt-1.5 text-[12px] ${MUTED}`}>{data.reason}</p>}
      {rows.length > 0 && (
        <ul className="px-4 pb-3 pt-2" aria-live="polite">
          {rows.map((row, index) => (
            <li key={`${row.label}-${index}`} className="flex items-center gap-2.5 py-1 text-[13px]">
              <RowIcon status={row.status} />
              <span className="min-w-0 flex-1 truncate text-[#34323d] dark:text-neutral-100" title={row.detail}>
                {row.label}
              </span>
              <span
                className={`shrink-0 text-[12px] ${
                  row.status === "failed" ? "font-medium text-[#d83a3a] dark:text-rose-400" : MUTED
                }`}
              >
                {ROW_WORD[row.status] ?? row.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {issues.length > 0 && (
        <div className={`border-t px-4 py-2.5 ${CARD_DIVIDER}`}>
          <p className={`text-[11px] font-semibold uppercase tracking-wide ${MUTED}`}>Issues</p>
          <ul className="mt-1 space-y-1">
            {issues.map((issue, index) => (
              <li key={index} className="flex gap-2 text-[12px] text-[#4c4a55] dark:text-neutral-300">
                <X size={13} className="mt-0.5 shrink-0 text-[#d83a3a] dark:text-rose-400" aria-hidden="true" />
                <span className="min-w-0 break-words">{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {Array.isArray(data.screenshots) && data.screenshots.length > 0 && (
        <div className={`flex gap-2 overflow-x-auto border-t px-4 py-2.5 ${CARD_DIVIDER}`}>
          {data.screenshots.map((shot) => (
            <a key={shot.url} href={shot.url} target="_blank" rel="noreferrer" className="shrink-0">
              <img
                src={shot.url}
                alt={shot.label ?? "QA screenshot"}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-20 w-auto rounded-md border border-[#e9e8ef] object-cover dark:border-white/10"
              />
            </a>
          ))}
        </div>
      )}
    </CardShell>
  );
}

/** The running QA card's "what is happening now", for the chat status line. */
export function qaStatusLine(data: QaCardData | undefined): { url?: string; width?: number; label?: string } | null {
  if (!data || data.outcome !== "running") return null;
  const running = (data.rows ?? []).find((row) => row.status === "running");
  return { url: data.urls?.[0], width: running?.width, label: running?.label };
}
