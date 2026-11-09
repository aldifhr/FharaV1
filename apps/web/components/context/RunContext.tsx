"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import ContextInspector, { SnapshotPicker } from "./ContextInspector";
import { formatTokens } from "@/lib/runFormat";

/** Context Inspector on a run: every LLM call of the task, one inspected at a time. */
export default function RunContext({ taskId }: { taskId: string }) {
  const rows = useQuery(api.contextSnapshots.forTask, { taskId: taskId as never });
  const [selected, setSelected] = useState<string | null>(null);
  if (rows === undefined) return null;
  const total = rows.reduce((n, r) => n + r.promptTokens, 0);
  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        Context
        <span className="tabular-nums text-ink-3">
          {rows.length} {rows.length === 1 ? "call" : "calls"}
          {rows.length > 0 ? ` · ~${formatTokens(total)} prompt tokens` : ""}
        </span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-3">No context snapshots for this run.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <div className="max-h-72 overflow-y-auto px-2 py-1">
            <SnapshotPicker rows={rows} selected={selected ?? undefined} onSelect={(id) => setSelected(selected === id ? null : id)} />
          </div>
          {selected && (
            <div className="border-t border-line px-4 py-4">
              <ContextInspector snapshotId={selected} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
