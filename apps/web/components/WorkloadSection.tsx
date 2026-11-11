"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Segmented from "@/components/ui/segmented";
import { compact, duration, usd } from "@/lib/metrics";
import { roleLabel } from "@/lib/agentRoles";

type Days = "7" | "30" | "90";
const DAY_OPTIONS: ReadonlyArray<{ value: Days; label: string }> = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
];

/**
 * Workload by role (workload.byRole): how real work — subtasks, tokens,
 * time, fallback routes — is spread across the team. The summary line is
 * computed by the backend from the counts, never written by a model.
 */
export default function WorkloadSection() {
  const [projectId, setProjectId] = useState<string>("");
  const [days, setDays] = useState<Days>("30");
  const projects = useQuery(api.projects.list, {}) as { _id: string; name: string }[] | undefined;
  const data = useQuery(api.workload.byRole, {
    sinceDays: Number(days),
    ...(projectId ? { projectId: projectId as never } : {}),
  });

  const th = "px-3 py-2 text-right font-normal";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <section className="mt-14" aria-labelledby="workload-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="workload-heading" className="text-[17px] font-semibold tracking-tight">
          Workload
        </h2>
        <div className="flex items-center gap-2">
          {projects && projects.length > 1 && (
            <select
              aria-label="Project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-[30px] max-w-[180px] truncate rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Segmented label="Time window" value={days} options={DAY_OPTIONS} onChange={setDays} />
        </div>
      </header>

      <p className="mt-4 text-[14px] text-ink-2">{data === undefined ? "Loading…" : data.summary}</p>

      {data === undefined ? (
        <div className="mt-6 h-48 animate-pulse rounded-xl bg-hover" aria-label="Loading workload" />
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-b border-line text-[12px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-normal">Role</th>
                  <th className={th}>Subtasks</th>
                  <th className={th}>Done / Failed</th>
                  <th className={th}>Tokens</th>
                  <th className={th}>Cost</th>
                  <th className={th}>Avg time</th>
                  <th className={th} title="Routed without an exact capability match / all routes">
                    Fallback routes
                  </th>
                  <th className="w-[22%] px-3 py-2 text-left font-normal">Share of subtasks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((r) => {
                  const idle = r.subtasks === 0 && r.tokens === 0;
                  return (
                    <tr key={r.key} className={idle ? "text-ink-3" : "text-ink"}>
                      <td className="px-3 py-2 text-left">
                        <span className={idle ? "" : "font-medium"}>{r.label}</span>
                        {!r.recognized && r.key !== "unattributed" && (
                          <span className="text-ink-3" title="Stored role is not one of the nine fixed roles">
                            {" "}
                            · custom role
                          </span>
                        )}
                      </td>
                      <td className={td}>{r.subtasks}</td>
                      <td className={td}>
                        {r.status.done}
                        <span className="text-ink-3"> / </span>
                        {r.status.failed}
                      </td>
                      <td className={td} title={r.tokensEstimated ? "Includes chars/4 estimates (provider reported no usage)" : undefined}>
                        {r.tokensEstimated ? "≈" : ""}
                        {compact(r.tokens)}
                        <span className="text-ink-3"> · {r.tokenShare}%</span>
                      </td>
                      <td className={td}>{usd(r.cost)}</td>
                      <td className={td} title={r.medianDurationMs !== null ? `Median ${duration(r.medianDurationMs)} over ${r.timedRuns} run(s)` : undefined}>
                        {duration(r.avgDurationMs)}
                      </td>
                      <td className={td}>
                        {r.routes ? (
                          <>
                            {r.fallbackRoutes}
                            <span className="text-ink-3"> / {r.routes}</span>
                          </>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
                            <div className="h-full rounded-full bg-ink-2" style={{ width: `${Math.min(100, r.subtaskShare)}%` }} />
                          </div>
                          <span className="w-10 shrink-0 text-right tabular-nums text-ink-3">{r.subtaskShare}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="mt-3 space-y-1 text-[12px] text-ink-3">
            <li>
              {data.totals.subtasks} subtasks · {compact(data.totals.tokens)} tokens · {usd(data.totals.cost)} ·{" "}
              {data.totals.fallbackRoutes} of {data.totals.routes} routes were fallbacks · {data.totals.chatReplies} agent
              replies
            </li>
            {data.totals.subtasksWithoutRouteEvent > 0 && (
              <li>
                {data.totals.subtasksWithoutRouteEvent} subtask(s) have no routing event, so whether they were a fallback is
                unknown.
              </li>
            )}
            {data.totals.unassignedSubtasks > 0 && (
              <li>{data.totals.unassignedSubtasks} subtask(s) were never assigned and are not counted per role.</li>
            )}
            {data.loadAware.count > 0 && (
              <li>
                Load-aware routing moved {data.loadAware.count} subtask(s) to an agent with spare capacity
                {data.loadAware.recent[0]
                  ? ` — latest: ${data.loadAware.recent[0].fromRole ? roleLabel(data.loadAware.recent[0].fromRole) : "?"} → ${data.loadAware.recent[0].toRole ? roleLabel(data.loadAware.recent[0].toRole) : "?"}${data.loadAware.recent[0].reason ? ` (${data.loadAware.recent[0].reason})` : ""}`
                  : ""}
                .
              </li>
            )}
            {data.truncated.length > 0 && <li>Read limit reached for {data.truncated.join(", ")}; older rows are left out.</li>}
          </ul>
        </>
      )}
    </section>
  );
}
