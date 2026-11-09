"use client";

import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { compact, duration, pct } from "@/lib/metrics";

/**
 * Plan 027: this agent's routing score per capability with its factor
 * breakdown (agentPerformance.agentScores). Scores are smoothed toward a
 * prior; below the minimum sample size the score is the prior itself, so
 * a new agent starts neutral. Used by performance routing when it is on.
 */
export default function PerformanceScoreSection({
  agentId,
  projectId,
  days,
}: {
  agentId: string;
  projectId: string;
  days: number;
}) {
  const data = useQuery(api.agentPerformance.agentScores, {
    agentId: agentId as never,
    sinceDays: days,
    ...(projectId ? { projectId: projectId as never } : {}),
  });

  return (
    <section className="mt-10" aria-labelledby="perf-score-heading">
      <h2 id="perf-score-heading" className="mb-1 text-[13px] font-medium text-ink-2">
        Routing score
      </h2>
      <p className="mb-3 text-[12px] text-ink-3">
        {data
          ? `Per capability over ${data.sinceDays} days. Smoothed toward ${data.prior.toFixed(2)}; under ${data.minSamples} finished subtasks the score is that prior.${
              data.performanceRouting === true ? " Performance routing is on for this project." : data.performanceRouting === false ? " Performance routing is off for this project." : ""
            }`
          : "Per capability, smoothed toward a neutral prior."}
      </p>
      {data === undefined ? (
        <p className="rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">Loading…</p>
      ) : data === null ? null : data.scores.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">No finished subtasks in this window yet.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {data.scores.map((s) => (
            <li key={s.capability} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="truncate text-[13.5px] text-ink">{s.capability}</span>
                <span className="shrink-0 text-[14px] tabular-nums text-ink">
                  {s.score.toFixed(2)}
                  <span className="text-[12px] text-ink-3">
                    {" "}
                    · {s.samples} {s.samples === 1 ? "subtask" : "subtasks"}
                    {s.insufficient ? " · prior (too few)" : ""}
                  </span>
                </span>
              </div>
              <dl className="mt-1.5 grid grid-cols-2 gap-x-6 gap-y-0.5 text-[12px] tabular-nums text-ink-3 sm:grid-cols-3">
                <Factor label="Success" rate={s.factors.success.rate} raw={s.factors.success.raw} n={s.factors.success.n} />
                <Factor label="Acceptance" rate={s.factors.acceptance.rate} raw={s.factors.acceptance.raw} n={s.factors.acceptance.n} />
                <Factor label="Retry / fix" rate={s.factors.retry.rate} raw={s.factors.retry.raw} n={s.factors.retry.n} />
                <Factor label="Regression" rate={s.factors.regression.rate} raw={s.factors.regression.raw} n={s.factors.regression.n} />
                <div className="flex justify-between gap-2">
                  <dt>Median time</dt>
                  <dd className="text-ink-2">{duration(s.factors.efficiency.medianDurationMs)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Tokens / accepted</dt>
                  <dd className="text-ink-2">{compact(s.factors.efficiency.tokensPerAccepted)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {data && data.truncated.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-3">Read limit reached for {data.truncated.join(", ")}; older rows are left out.</p>
      )}
    </section>
  );
}

function Factor({ label, rate, raw, n }: { label: string; rate: number; raw: number | null; n: number }) {
  return (
    <div className="flex justify-between gap-2" title={raw === null ? "No evidence; prior used" : `Raw ${pct(raw)} over ${n}`}>
      <dt>{label}</dt>
      <dd className="text-ink-2">
        {pct(rate)}
        <span className="text-ink-3"> ({raw === null ? "prior" : `${pct(raw)} of ${n}`})</span>
      </dd>
    </div>
  );
}
