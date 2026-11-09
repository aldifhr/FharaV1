"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { BarChart3 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import { compact, duration, pct, usd } from "@/lib/metrics";

type Days = 7 | 30 | 90;
const RANGES: Days[] = [7, 30, 90];

function Segmented({ value, onChange }: { value: Days; onChange: (d: Days) => void }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-lg border border-line bg-panel p-0.5">
      {RANGES.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          onClick={() => onChange(d)}
          className={`rounded-md px-2.5 py-1 text-[12.5px] tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
            value === d ? "bg-ink text-canvas" : "text-ink-2 hover:bg-hover hover:text-ink"
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 px-4 py-4">
      <p className="text-[12.5px] text-ink-3">{label}</p>
      <p className="mt-1 text-[26px] font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

/** Inline SVG sparkline; gaps (null) break the line. */
function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const w = 240;
  const h = 36;
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) {
    return <p className="text-[12px] text-ink-3">No data</p>;
  }
  const max = Math.max(...defined);
  const min = Math.min(0, ...defined);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    const x = (i * step).toFixed(1);
    const y = (h - 2 - ((v - min) / span) * (h - 4)).toFixed(1);
    current += `${current ? "L" : "M"}${x},${y}`;
  });
  if (current) segments.push(current);
  const lastIndex = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
  const last = values[lastIndex] as number;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={label} className="text-ink-2">
      <line x1="0" x2={w} y1={h - 1} y2={h - 1} className="stroke-line" strokeWidth="1" />
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
      <circle cx={lastIndex * step} cy={h - 2 - ((last - min) / span) * (h - 4)} r="2.5" className="fill-ink" />
    </svg>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-2 text-[12px] font-medium text-ink-3 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

function EvalsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const projectId = params.get("project") ?? undefined;
  const daysParam = Number(params.get("days"));
  const [days, setDays] = useState<Days>(RANGES.includes(daysParam as Days) ? (daysParam as Days) : 7);
  const tzOffsetMinutes = useMemo(() => new Date().getTimezoneOffset(), []);
  const projects = useQuery(api.projects.list, {}) as { _id: string; name: string }[] | undefined;
  const data = useQuery(api.evals.summary, {
    days,
    tzOffsetMinutes,
    ...(projectId ? { projectId: projectId as never } : {}),
  });

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const projectName = projects?.find((p) => p._id === projectId)?.name;
  const worstKey =
    data && data.agents.length > 1 && (data.agents[0].failureRate ?? 0) > 0 ? data.agents[0].key : null;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              {projectName && <p className="truncate text-[13px] text-ink-3">{projectName}</p>}
              <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Evaluations</h1>
            </div>
            <div className="flex items-center gap-2">
              {projects && projects.length > 1 && (
                <select
                  aria-label="Project"
                  value={projectId ?? ""}
                  onChange={(e) => setParam("project", e.target.value || undefined)}
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
              <Segmented
                value={days}
                onChange={(d) => {
                  setDays(d);
                  setParam("days", d === 7 ? undefined : String(d));
                }}
              />
            </div>
          </header>
          <p className="mt-6 text-[15px] text-ink-2">
            {data === undefined
              ? "Loading…"
              : data.hasData
                ? `${data.taskSuccess.finished} finished ${data.taskSuccess.finished === 1 ? "task" : "tasks"} in the last ${days} days`
                : `Nothing ran in the last ${days} days`}
          </p>

          {data === undefined ? (
            <div className="mt-10 space-y-3" aria-label="Loading evaluations">
              <div className="h-24 animate-pulse rounded-xl bg-hover" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : !data.hasData ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <BarChart3 size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No runs to evaluate yet.</p>
              <p className="mt-1 text-[13px] text-ink-3">Success rates, QA results and cost appear once tasks run.</p>
            </div>
          ) : (
            <>
              <section className="mt-10 grid grid-cols-4 divide-x divide-line overflow-hidden rounded-xl border border-line bg-panel max-[640px]:grid-cols-2 max-[640px]:divide-x-0">
                <Tile
                  label="Task success"
                  value={pct(data.taskSuccess.rate)}
                  sub={`${data.taskSuccess.done} of ${data.taskSuccess.finished} done`}
                />
                <Tile
                  label="QA pass rate"
                  value={pct(data.qa.rate)}
                  sub={
                    data.qa.source === "evaluations"
                      ? `${data.qa.evaluations.passed} of ${data.qa.evaluations.passed + data.qa.evaluations.failed} verdicts`
                      : data.qa.source === "qa_subtasks"
                        ? `${data.qa.qaSubtasks.completed} of ${data.qa.qaSubtasks.completed + data.qa.qaSubtasks.failed} QA steps`
                        : "No QA yet"
                  }
                />
                <Tile
                  label="Tool-call success"
                  value={pct(data.toolCalls.rate)}
                  sub={
                    data.toolCalls.allowed + data.toolCalls.denied
                      ? `${data.toolCalls.denied} denied of ${data.toolCalls.allowed + data.toolCalls.denied}`
                      : "No tool calls"
                  }
                />
                <Tile
                  label="Avg cost per task"
                  value={usd(data.cost.avgPerTask)}
                  sub={data.cost.medianPerTask !== null ? `median ${usd(data.cost.medianPerTask)}` : "no pricing"}
                />
              </section>
              {data.cost.note && <p className="mt-2 text-[12px] text-ink-3">{data.cost.note}</p>}

              <section className="mt-10 grid grid-cols-2 gap-6 max-[640px]:grid-cols-1">
                <div>
                  <h2 className="mb-2 flex items-baseline justify-between text-[13px] font-medium text-ink-2">
                    Success rate
                    <span className="text-[12px] font-normal text-ink-3">daily</span>
                  </h2>
                  <Sparkline values={data.trend.map((d) => d.successRate)} label="Daily task success rate" />
                </div>
                <div>
                  <h2 className="mb-2 flex items-baseline justify-between text-[13px] font-medium text-ink-2">
                    Cost
                    <span className="text-[12px] font-normal tabular-nums text-ink-3">{usd(data.cost.total)} total</span>
                  </h2>
                  <Sparkline
                    values={data.cost.pricedCalls ? data.trend.map((d) => d.cost) : []}
                    label="Daily estimated cost"
                  />
                </div>
              </section>

              <section className="mt-10">
                <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
                  Agents
                  <span className="tabular-nums text-ink-3">{data.agents.length}</span>
                </h2>
                <div className="overflow-x-auto rounded-xl border border-line bg-panel">
                  <table className="w-full min-w-[560px] text-[13px]">
                    <thead className="border-b border-line">
                      <tr>
                        <Th>Role</Th>
                        <Th right>Runs</Th>
                        <Th right>Failure</Th>
                        <Th right>Avg time</Th>
                        <Th right>Retries</Th>
                        <Th right>Tokens</Th>
                        <Th right>Cost</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.agents.map((a) => {
                        const worst = a.key === worstKey;
                        return (
                          <tr key={a.key} className={worst ? "bg-hover" : undefined}>
                            <td className="px-4 py-2.5">
                              <span className={worst ? "font-medium text-ink" : "text-ink"}>{roleLabel(a.role)}</span>
                              {worst && <span className="ml-2 text-[12px] text-ink-3">most failures</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{a.executions}</td>
                            <td className={`px-4 py-2.5 text-right tabular-nums ${worst ? "font-medium text-ink" : "text-ink-2"}`}>
                              {pct(a.failureRate)}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{duration(a.avgDurationMs)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{a.retries}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{compact(a.tokens)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{usd(a.cost)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="mt-10">
                <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
                  Models
                  <span className="tabular-nums text-ink-3">{data.models.length}</span>
                </h2>
                {data.models.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">No model calls in this window.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-line bg-panel">
                    <table className="w-full min-w-[560px] text-[13px]">
                      <thead className="border-b border-line">
                        <tr>
                          <Th>Model</Th>
                          <Th right>Calls</Th>
                          <Th right>In</Th>
                          <Th right>Out</Th>
                          <Th right>Cost</Th>
                          <Th right>Failure</Th>
                          <Th right>Avg time</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {data.models.map((m) => (
                          <tr key={m.model}>
                            <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-[12.5px] text-ink" title={m.model}>
                              {m.model}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{m.calls}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{compact(m.inputTokens)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{compact(m.outputTokens)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{usd(m.cost)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{pct(m.failureRate)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{duration(m.avgDurationMs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-2 text-[12px] text-ink-3">
                  {data.modelAttribution === "executionId"
                    ? "Failure and time come from the runs each call belonged to."
                    : "Failure and time are matched by task and agent, so an agent that used two models on one task counts for both."}
                </p>
              </section>

              {data.anyTruncated && (
                <p className="mt-8 text-[12px] text-ink-3">
                  This range has more activity than one read covers, so the numbers reflect the most recent part of it.
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <EvalsPage />
    </Suspense>
  );
}
