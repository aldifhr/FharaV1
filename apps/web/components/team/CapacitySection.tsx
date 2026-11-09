"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Segmented from "@/components/ui/segmented";
import { useToast } from "@/components/Toasts";

type RoutingChoice = "default" | "on" | "off";
const ROUTING_OPTIONS: ReadonlyArray<{ value: RoutingChoice; label: string }> = [
  { value: "default", label: "Default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * Workload Manager — live capacity (orgIntel.capacity): executions each
 * agent is running now against its concurrency limit, and the project's
 * load-aware routing setting. Live: Convex re-renders as executions start
 * and finish.
 */
export default function CapacitySection() {
  const toast = useToast();
  const [projectId, setProjectId] = useState<string>("");
  const projects = useQuery(api.projects.list, {}) as { _id: string; name: string }[] | undefined;
  const data = useQuery(api.orgIntel.capacity, projectId ? { projectId: projectId as never } : {});
  const setRouting = useMutation(api.orgIntel.setLoadAwareRouting);
  const [saving, setSaving] = useState(false);

  const choice: RoutingChoice = data?.loadAwareRouting === true ? "on" : data?.loadAwareRouting === false ? "off" : "default";
  async function changeRouting(next: RoutingChoice) {
    if (!projectId || next === choice) return;
    setSaving(true);
    try {
      await setRouting({ projectId: projectId as never, enabled: next === "default" ? null : next === "on" });
    } catch (err) {
      toast("error", `Couldn't change load-aware routing: ${err instanceof Error ? err.message : "please try again"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-14" aria-labelledby="capacity-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="capacity-heading" className="text-[17px] font-semibold tracking-tight">
          Capacity
        </h2>
        {projects && projects.length > 0 && (
          <select
            aria-label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-[30px] max-w-[180px] truncate rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </header>

      <p className="mt-4 text-[14px] text-ink-2">
        {data === undefined
          ? "Loading…"
          : `${data.totals.running} running of ${data.totals.limit} slots · ${data.totals.atCapacity} ${data.totals.atCapacity === 1 ? "agent" : "agents"} at capacity`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px]">
        <span className="text-ink-2">Load-aware routing</span>
        {projectId ? (
          <>
            <Segmented label="Load-aware routing" value={choice} options={ROUTING_OPTIONS} onChange={(v) => void changeRouting(v)} />
            <span className="text-[12px] text-ink-3">
              {saving
                ? "Saving…"
                : choice === "default"
                  ? "Uses the worker default (ORCHESTRATOR_LOAD_AWARE_ROUTING, off unless set)."
                  : choice === "on"
                    ? "Among agents with the capability, the one with spare capacity gets the subtask."
                    : "Routing ignores load."}
            </span>
          </>
        ) : (
          <span className="text-[12px] text-ink-3">Pick a project to change it.</span>
        )}
      </div>

      {data === undefined ? (
        <div className="mt-6 h-40 animate-pulse rounded-xl bg-hover" aria-label="Loading capacity" />
      ) : data.rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">No agents.</p>
      ) : (
        <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {data.rows.map((r) => {
            const pct = Math.min(100, Math.round(r.utilization * 100));
            const full = r.running >= r.limit;
            return (
              <li key={r.agentId} className={`px-4 py-3 ${r.enabled ? "" : "opacity-50"}`}>
                <div className="flex items-center gap-3">
                  <Link href={`/team/${r.agentId}`} className="w-28 shrink-0 truncate text-[14px] font-medium text-ink outline-none hover:underline focus-visible:underline">
                    {r.label}
                  </Link>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
                    <div className="h-full rounded-full bg-ink-2" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-28 shrink-0 text-right text-[13px] tabular-nums" title={`${r.running} running of ${r.limit} concurrent slots`}>
                    {r.running} / {r.limit}
                    <span className="text-ink-3">{!r.enabled ? " · off" : full ? " · full" : ` · ${r.spare} free`}</span>
                  </span>
                </div>
                {(r.work.length > 0 || r.stale > 0) && (
                  <ul className="mt-1.5 space-y-0.5 pl-[124px] text-[12px] text-ink-3 max-[640px]:pl-0">
                    {r.work.slice(0, 3).map((w) => (
                      <li key={`${w.taskId}-${w.subtaskKey}`} className="truncate">
                        <Link href={`/runs/${w.taskId}`} className="hover:text-ink">
                          {w.taskTitle ?? "Task"}
                        </Link>
                        {w.subtaskKey ? ` · ${w.subtaskKey}` : ""}
                        {w.status === "waiting_approval" ? " · waiting for approval" : ""}
                      </li>
                    ))}
                    {r.work.length > 3 && <li>+{r.work.length - 3} more</li>}
                    {r.stale > 0 && <li>{r.stale} stale execution(s) with a lapsed lease are not counted.</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data?.truncated && <p className="mt-3 text-[12px] text-ink-3">Read limit reached; some active executions are left out.</p>}
    </section>
  );
}
