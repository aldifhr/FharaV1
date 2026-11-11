"use client";
// Paradev A2 (plan audit/paradev-plan-2026-11-11.md, P-A): CI checks of the
// task's PR, one row per ciChecks entry. Pattern only from Paradev's
// PRDetailCard (its styling uses tinted backgrounds; this is plain rows).
import { CheckCircle2, Circle, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import type { ChangesPr } from "@/api/convex/lib/changeset";
import { checkRows, checksSummary } from "@/lib/changesView";

const GLYPH = { passed: CheckCircle2, failed: XCircle, pending: Circle } as const;

export default function ChecksList({
  checks,
  onRefresh,
  refreshing,
}: {
  checks: ChangesPr["ciChecks"];
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const rows = checkRows(checks);
  return (
    <section aria-label="Checks" className="space-y-1.5">
      <div className="flex items-center gap-2 px-4">
        <h3 className="text-[13px] font-semibold text-ink">Checks</h3>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{rows.length ? checksSummary(checks) : "No checks reported"}</span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
            Refresh
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((row, i) => {
            const Glyph = GLYPH[row.status];
            return (
              <li key={`${row.name}-${i}`} data-testid="changes-check-row" className="flex items-center gap-2.5 px-4 py-2 text-[13px]">
                <Glyph size={14} className={`shrink-0 ${row.status === "passed" ? "text-ink-3" : "text-ink"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ink" title={row.name}>
                  {row.name}
                </span>
                <span className={`shrink-0 ${row.status === "failed" ? "font-semibold text-ink" : "text-ink-3"}`}>{row.word}</span>
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                  >
                    Details <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
