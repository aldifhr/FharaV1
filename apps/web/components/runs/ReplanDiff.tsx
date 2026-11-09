"use client";

import type { ReplanView, ReplanViewEntry } from "@/api/convex/lib/replanView";

/**
 * Replan Intelligence on /runs: for each replanned plan version, what
 * failed, what it affected, the diff (added / removed / modified /
 * preserved) with the planner's reasoning per changed node, and the
 * frozen nodes carried over without re-running. Plain divide-y lists,
 * theme tokens and text marks; no pills, no tinted cards.
 */

const MARK: Record<"added" | "removed" | "modified" | "preserved", { glyph: string; label: string }> = {
  added: { glyph: "+", label: "Added" },
  removed: { glyph: "−", label: "Removed" },
  modified: { glyph: "~", label: "Modified" },
  preserved: { glyph: "=", label: "Preserved" },
};

function EntryRow({ entry, change }: { entry: ReplanViewEntry; change: keyof typeof MARK }) {
  const mark = MARK[change];
  const notes = [
    entry.frozen ? "frozen · not re-run" : null,
    entry.restored ? "planner rewrote it · restored" : null,
    entry.outsideImpact ? "outside the failed branch" : null,
    change === "modified" && entry.fields.length > 0 ? `changed ${entry.fields.join(", ")}` : null,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-3 px-4 py-2 text-[13px]">
      <span className="w-3 shrink-0 text-center font-mono text-ink-3" aria-label={mark.label} title={mark.label}>
        {mark.glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-ink">{entry.title}</span>
        <span className="text-ink-3">
          {" "}· <span className="font-mono text-[11.5px]">{entry.key}</span>
          {entry.kind ? ` · ${entry.kind.replace(/_/g, " ")}` : ""}
          {notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}
        </span>
        {change !== "preserved" && (
          <span className={`block break-words text-[12.5px] ${entry.reasoning ? "text-ink-2" : "text-ink-3"}`}>
            {entry.reasoning ?? "No reasoning given by the planner"}
          </span>
        )}
      </span>
    </li>
  );
}

function ReplanItem({ view }: { view: ReplanView }) {
  const counts = (["added", "removed", "modified", "preserved"] as const)
    .map((change) => `${view[change].length} ${MARK[change].label.toLowerCase()}`)
    .join(" · ");
  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="space-y-1 px-4 py-3 text-[13px]">
        <p className="text-ink">
          Plan v{view.fromVersion} → v{view.toVersion}
          <span className="tabular-nums text-ink-3"> · {counts}</span>
          {view.attempts > 1 && <span className="text-ink-3"> · accepted on attempt {view.attempts}</span>}
        </p>
        {view.reason && <p className="line-clamp-3 break-words text-[12.5px] text-ink-2">{view.reason}</p>}
        <p className="text-[12px] text-ink-3">
          Failed: {view.failedKeys.length > 0 ? view.failedKeys.join(", ") : "plan-level"}
          {view.impactKeys.length > 0 ? ` · Affected: ${view.impactKeys.join(", ")}` : ""}
          {view.frozenKeys.length > 0 ? ` · Frozen: ${view.frozenKeys.join(", ")}` : ""}
        </p>
        {view.rejected.map((message, index) => (
          <p key={index} className="break-words text-[12px] text-ink-3">
            Rejected attempt {index + 1}: {message}
          </p>
        ))}
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {view.added.map((entry) => <EntryRow key={`a:${entry.key}`} entry={entry} change="added" />)}
        {view.modified.map((entry) => <EntryRow key={`m:${entry.key}`} entry={entry} change="modified" />)}
        {view.removed.map((entry) => <EntryRow key={`r:${entry.key}`} entry={entry} change="removed" />)}
        {view.preserved.map((entry) => <EntryRow key={`p:${entry.key}`} entry={entry} change="preserved" />)}
      </ul>
    </div>
  );
}

export default function ReplanDiff({ replans }: { replans: ReplanView[] }) {
  return (
    <div className="space-y-3">
      {replans.map((view) => (
        <ReplanItem key={`${view.fromVersion}-${view.toVersion}`} view={view} />
      ))}
    </div>
  );
}
