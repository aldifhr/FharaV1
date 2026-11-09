"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Scale } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { useToast } from "@/components/Toasts";
import { errorText } from "@/components/review/Improve";
import { LABEL_CLASS, LABEL_TEXT } from "@/components/runs/Decisions";
import { DECISION_TYPE_LABELS, type DecisionType } from "@/api/convex/lib/calibration/capture";
import {
  MIN_ESTIMATE_SAMPLES,
  MIN_ROUTING_SAMPLES,
  type Recommendation,
} from "@/api/convex/lib/calibration/aggregate";
import { relativeTime } from "@/lib/runFormat";

/**
 * Decision Outcome Calibration: how the orchestrator's decisions turned
 * out, and recommendations a person may apply (diff first, audited) or
 * dismiss. Nothing applies by itself.
 */

type Summary = FunctionReturnType<typeof api.calibration.summary>;
const WINDOWS = [7, 30, 90] as const;

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}
function times(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(2)}×`;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        {title}
        {aside !== undefined && <span className="tabular-nums text-ink-3">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

function diffLines(rec: Recommendation): string[] {
  const a = rec.apply;
  if (!a) return [];
  if (a.kind === "agent_priority") return [`${a.agentName} · priority`, `- ${a.from}`, `+ ${a.to}`];
  const scope = `${a.role}${a.complexity === "any" ? "" : ` × ${a.complexity}`}`;
  return [`Estimator multiplier · ${scope} · ${a.metric}`, `- ${a.from}`, `+ ${a.to}`];
}

function RecommendationItem({ rec, projectId, sinceDays }: { rec: Recommendation; projectId?: string; sinceDays: number }) {
  const toast = useToast();
  const apply = useMutation(api.calibration.apply);
  const dismiss = useMutation(api.calibration.dismiss);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<"apply" | "dismiss" | null>(null);
  const scope = { ...(projectId ? { projectId: projectId as never } : {}), sinceDays };

  const run = async (kind: "apply" | "dismiss") => {
    setBusy(kind);
    try {
      if (kind === "apply" && rec.apply) {
        await apply({ recId: rec.id, ...scope, expectedFrom: rec.apply.from, expectedTo: rec.apply.to });
        toast("success", "Applied", rec.title);
      } else {
        await dismiss({ recId: rec.id, ...scope });
      }
    } catch (err) {
      toast("error", kind === "apply" ? "Couldn't apply" : "Couldn't dismiss", errorText(err));
    } finally {
      setBusy(null);
      setReviewing(false);
    }
  };

  return (
    <div className="py-3">
      <p className="text-[14px] text-ink">{rec.title}</p>
      <p className="mt-0.5 text-[12.5px] text-ink-3">{rec.detail}</p>
      {reviewing && rec.apply && (
        <pre className="mt-2 overflow-auto rounded-lg border border-line px-3 py-2 font-mono text-[12px] leading-relaxed">
          {diffLines(rec).map((line, i) => (
            <div key={i} className={line.startsWith("+") ? "text-brand-ink" : line.startsWith("-") ? "text-destructive" : "text-ink-3"}>
              {line}
            </div>
          ))}
        </pre>
      )}
      <div className="mt-2 flex gap-4 text-[12.5px]">
        {rec.apply && !reviewing && (
          <button type="button" onClick={() => setReviewing(true)} className="text-ink underline decoration-line-strong underline-offset-4 hover:text-brand-ink">
            Apply…
          </button>
        )}
        {rec.apply && reviewing && (
          <>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("apply")}
              className="text-ink underline decoration-line-strong underline-offset-4 hover:text-brand-ink disabled:opacity-50"
            >
              {busy === "apply" ? "Applying…" : "Confirm apply"}
            </button>
            <button type="button" onClick={() => setReviewing(false)} className="text-ink-3 hover:text-ink">
              Cancel
            </button>
          </>
        )}
        <button type="button" disabled={busy !== null} onClick={() => run("dismiss")} className="text-ink-3 hover:text-ink disabled:opacity-50">
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
        <span className="ml-auto tabular-nums text-ink-3">{rec.samples} samples</span>
      </div>
    </div>
  );
}

function Body({ data, projectId, sinceDays }: { data: Summary; projectId?: string; sinceDays: number }) {
  const types = Object.entries(data.counts) as Array<[string, { good: number; suboptimal: number; bad: number; unknown: number }]>;
  return (
    <>
      <Section title="Recommendations" aside={data.recommendations.length}>
        {data.recommendations.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            Nothing to recommend. Routing needs {MIN_ROUTING_SAMPLES} labelled picks per agent × capability, the estimator {MIN_ESTIMATE_SAMPLES} subtasks per role × complexity.
          </p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {data.recommendations.map((rec) => (
              <li key={rec.id}>
                <RecommendationItem rec={rec} projectId={projectId} sinceDays={sinceDays} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decisions" aside={`${data.labelled} labelled of ${data.total}${data.truncated ? " (capped)" : ""}`}>
        {types.length === 0 ? (
          <p className="text-[13px] text-ink-3">No labelled decisions in this window yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {types.map(([type, c]) => (
              <li key={type} className="flex items-baseline gap-3 py-2 text-[12.5px]">
                <span className="w-32 shrink-0 text-ink">{DECISION_TYPE_LABELS[type as DecisionType] ?? type}</span>
                <span className="tabular-nums text-brand-ink">{c.good} good</span>
                <span className="tabular-nums text-warn">{c.suboptimal} suboptimal</span>
                <span className="tabular-nums text-destructive">{c.bad} bad</span>
                <span className="tabular-nums text-ink-3">{c.unknown} unknown</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {data.routing.length > 0 && (
        <Section title="Routing by agent × capability" aside={data.routing.length}>
          <ul className="divide-y divide-line border-y border-line">
            {data.routing.map((row) => (
              <li key={`${row.agentName}:${row.capability}`} className="flex items-baseline gap-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {row.agentName} <span className="text-ink-3">· {row.capability}</span>
                </span>
                <span className="w-24 shrink-0 text-right tabular-nums text-ink-2">
                  {row.good}/{row.labelled} good
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-ink-3">{pct(row.goodRate)}</span>
                <span className={`w-20 shrink-0 text-right ${row.trend === "declining" ? "text-destructive" : "text-ink-3"}`}>{row.trend ?? "—"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-ink-3">
            Performance-based routing scores, when enabled, live on each agent&apos;s profile under Team.
          </p>
        </Section>
      )}

      {data.estimator.length > 0 && (
        <Section title="Estimator: actual ÷ estimate" aside={data.estimator.length}>
          <ul className="divide-y divide-line border-y border-line">
            {data.estimator.map((row) => (
              <li key={`${row.projectId}:${row.role}:${row.complexity}`} className="flex items-baseline gap-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {row.role}
                  <span className="text-ink-3">
                    {" "}· {row.complexity}
                    {!projectId && row.projectName ? ` · ${row.projectName}` : ""}
                  </span>
                </span>
                <span className="w-36 shrink-0 text-right tabular-nums text-ink-2">
                  tokens {times(row.tokens.ratio)} <span className="text-ink-3">n={row.tokens.samples}</span>
                </span>
                <span className="w-36 shrink-0 text-right tabular-nums text-ink-2">
                  time {times(row.duration.ratio)} <span className="text-ink-3">n={row.duration.samples}</span>
                </span>
                <span className="w-28 shrink-0 text-right tabular-nums text-ink-3">
                  ×{row.multipliers.tokens} / ×{row.multipliers.duration}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Replans and planning">
        <ul className="divide-y divide-line border-y border-line text-[12.5px]">
          <li className="flex items-baseline gap-3 py-2">
            <span className="flex-1 text-ink">Replan effectiveness</span>
            <span className="tabular-nums text-ink-2">
              {data.replan.samples > 0 ? `${data.replan.good}/${data.replan.samples} recovered · ${pct(data.replan.rate)}` : "no replans"}
            </span>
          </li>
          <li className="flex items-baseline gap-3 py-2">
            <span className="flex-1 text-ink">Planner requirement-miss rate</span>
            <span className="tabular-nums text-ink-2">
              {data.planner.samples > 0 ? `${pct(data.planner.rate)} of ${data.planner.samples} plans` : "no coverage checks"}
            </span>
          </li>
        </ul>
      </Section>

      {data.recent.length > 0 && (
        <Section title="Recent bad and suboptimal decisions" aside={data.recent.length}>
          <ul className="divide-y divide-line border-y border-line">
            {data.recent.map((row) => (
              <li key={row._id} className="py-2 text-[12.5px]">
                <div className="flex items-baseline gap-3">
                  <span className="w-28 shrink-0 text-ink-2">{DECISION_TYPE_LABELS[row.type as DecisionType] ?? row.type}</span>
                  <Link href={`/runs/${row.taskId}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
                    {row.chosen}
                    {row.subtaskKey && <span className="text-ink-3"> · {row.subtaskKey}</span>}
                  </Link>
                  <span className={`shrink-0 ${LABEL_CLASS[row.label]}`}>{LABEL_TEXT[row.label]}</span>
                  <span className="w-20 shrink-0 text-right text-ink-3">{relativeTime(row.decidedAt)}</span>
                </div>
                {row.factors.length > 0 && <p className="ml-[7.75rem] mt-0.5 break-words text-ink-3 max-[640px]:ml-0">{row.factors.join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.history.length > 0 && (
        <Section title="History" aside={data.history.length}>
          <ul className="divide-y divide-line border-y border-line">
            {data.history.map((row) => (
              <li key={row._id} className="flex items-baseline gap-3 py-2 text-[12.5px]">
                <span className="w-20 shrink-0 text-ink-2">{row.action === "applied" ? "Applied" : "Dismissed"}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{row.title}</span>
                <span className="w-20 shrink-0 text-right text-ink-3">{relativeTime(row.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function CalibrationPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const [sinceDays, setSinceDays] = useState<number>(30);
  const data = useQuery(api.calibration.summary, { ...(projectId ? { projectId: projectId as never } : {}), sinceDays });

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[26px] font-semibold tracking-tight">Calibration</h1>
              <p className="mt-1 text-[15px] text-ink-2">How the orchestrator&apos;s decisions turned out. Recommendations change a setting only when you apply them.</p>
            </div>
            <div className="mt-2 flex shrink-0 gap-3 text-[12.5px]" role="tablist" aria-label="Window">
              {WINDOWS.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="tab"
                  aria-selected={sinceDays === days}
                  onClick={() => setSinceDays(days)}
                  className={sinceDays === days ? "text-ink underline decoration-line-strong underline-offset-4" : "text-ink-3 hover:text-ink"}
                >
                  {days}d
                </button>
              ))}
            </div>
          </header>

          {data === undefined ? (
            <p className="mt-10 text-[13px] text-ink-3">Loading…</p>
          ) : data.total === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <Scale size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No decisions recorded in the last {sinceDays} days.</p>
              <p className="mt-1 text-[12.5px] text-ink-3">New runs record them as they go; older runs can be backfilled.</p>
            </div>
          ) : (
            <Body data={data} projectId={projectId} sinceDays={sinceDays} />
          )}
        </div>
      </main>
    </div>
  );
}

export default function CalibrationPageWrapper() {
  return (
    <Suspense fallback={null}>
      <CalibrationPage />
    </Suspense>
  );
}
