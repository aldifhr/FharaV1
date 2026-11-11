"use client";
// Paradev A2 (plan audit/paradev-plan-2026-11-11.md, P-A): branch, base, flow
// state in plain text, PR facts and the one action (Open PR / Refresh /
// Retry). Pattern only from Paradev's ChangesControl/ShipControl/PRStatusGroup
// (their styling uses tinted backgrounds; this uses theme tokens only).
import { ExternalLink, GitBranch, GitPullRequest, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type { ChangesForTask } from "@/api/convex/changes";
import { selectActionButton, selectStatusLabel } from "@/api/convex/lib/changeset";
import { prFactsText, prLine } from "@/lib/changesView";

const BTN = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = `${BTN} bg-ink text-canvas hover:opacity-90`;
const BTN_PLAIN = `${BTN} border border-line text-ink hover:bg-hover`;

const DISABLED_REASON = {
  "no-branch": "No branch yet",
  "worktree-gone": "The worktree was removed, so the branch can't be pushed from here",
} as const;

export type HeaderActing = null | "pr" | "refresh";

export default function ChangesHeader({
  view,
  acting,
  onOpenPr,
  onRefresh,
}: {
  view: ChangesForTask;
  acting: HeaderActing;
  onOpenPr: () => void;
  onRefresh: () => void;
}) {
  const action = selectActionButton(view.flow);
  const status = selectStatusLabel(view.flow);
  const pr = view.pr;
  const facts = pr ? prFactsText(pr) : [];
  const commit = view.commit;
  const drift = commit && (commit.ahead !== undefined || commit.behind !== undefined)
    ? `${commit.ahead ?? 0} ahead · ${commit.behind ?? 0} behind${commit.comparedTo ? ` ${commit.comparedTo}` : ""}`
    : null;
  const errorText = view.flow.kind === "error" ? view.flow.message : null;

  return (
    <div className="space-y-2 px-4 pt-4" data-testid="changes-header">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
            <GitBranch size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
            {view.branchName ? (
              <span className="min-w-0 truncate font-mono text-[12.5px]" title={view.branchName}>
                {view.branchName}
              </span>
            ) : (
              <span className="text-ink-3">No branch</span>
            )}
            {view.base && <span className="shrink-0 text-ink-3">→ {view.base}</span>}
          </p>
          <p className="text-[12.5px] text-ink-3" data-testid="changes-status">
            {[status, drift].filter(Boolean).join(" · ")}
          </p>
        </div>
        {action.kind === "open-pr" && (
          <button type="button" onClick={onOpenPr} disabled={acting !== null} className={BTN_PRIMARY}>
            {acting === "pr" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <GitPullRequest size={14} aria-hidden="true" />}
            Open PR
          </button>
        )}
        {action.kind === "retry" && (
          <button type="button" onClick={onOpenPr} disabled={acting !== null || !view.pushId} className={BTN_PLAIN}>
            {acting === "pr" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
            Retry
          </button>
        )}
        {action.kind === "refresh-pr" && (
          <button type="button" onClick={onRefresh} disabled={acting !== null} className={BTN_PLAIN}>
            {acting === "refresh" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            Refresh
          </button>
        )}
      </div>
      {pr && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-2">
          {pr.url ? (
            <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-ink underline-offset-2 hover:underline">
              {prLine(pr)} <ExternalLink size={11} aria-hidden="true" />
            </a>
          ) : (
            <span className="font-medium text-ink">{prLine(pr)}</span>
          )}
          {pr.title && <span className="min-w-0 truncate">{pr.title}</span>}
          {facts.map((fact) => (
            <span key={fact} className="text-ink-3">
              · {fact}
            </span>
          ))}
        </p>
      )}
      {action.kind === "disabled" && <p className="text-[12.5px] text-ink-3">{DISABLED_REASON[action.reason]}</p>}
      {errorText && <p className="text-[12.5px] text-ink-2">{errorText}</p>}
    </div>
  );
}
