"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import { taskStatusLabel } from "@/lib/taskStatus";
import { clockTime } from "@/lib/format";
import {
  formatCost,
  formatDuration,
  formatTokens,
  isActiveStatus,
  isErrorStatus,
  statusDot,
} from "@/lib/runFormat";

type Run = NonNullable<FunctionReturnType<typeof api.runs.get>>;
type Step = Run["steps"][number];

const STEP_KIND_LABEL: Record<string, string> = {
  received: "You",
  plan: "Plan",
  verdict: "Verdict",
  evaluation: "Evaluation",
  approval: "Approval",
  push: "Push",
  final: "Result",
};

/** Display by role only; non-agent steps get their kind. */
function stepLabel(step: Step): string {
  if (step.role) return roleLabel(step.role);
  return STEP_KIND_LABEL[step.type] ?? "Step";
}

const STRIPES = {
  backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 4px, transparent 4px 8px)",
};

/** Re-render every second while the run is live, so running bars grow. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return now;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        {title}
        {aside !== undefined && <span className="tabular-nums text-ink-3">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

function Mono({ label, text, defaultOpen = false }: { label: string; text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const long = text.length > 600 || text.split("\n").length > 12;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[12px] font-medium text-ink-2 hover:text-ink"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
        <span className="font-normal tabular-nums text-ink-3">{text.length.toLocaleString()} chars</span>
      </button>
      {open && (
        <pre
          className={`mt-1.5 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink ${long ? "max-h-80" : ""}`}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="truncate text-[12.5px] tabular-nums text-ink">{children}</dd>
    </div>
  );
}

function StepDetail({ step, stepByKey }: { step: Step; stepByKey: Map<string, Step> }) {
  const t = step.tokens;
  return (
    <div className="space-y-3 border-t border-line bg-canvas/40 px-4 py-3.5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="Status">{step.status.replace(/_/g, " ")}</Field>
        {step.startedAt !== undefined && <Field label="Started">{clockTime(step.startedAt)}</Field>}
        {step.durationMs !== undefined && <Field label="Duration">{formatDuration(step.durationMs)}</Field>}
        {step.attempt !== undefined && <Field label="Attempt">{step.attempt}</Field>}
        {step.capability && <Field label="Capability">{step.capability}</Field>}
        {step.subtaskKind && <Field label="Kind">{step.subtaskKind.replace(/_/g, " ")}</Field>}
        {step.origin && step.origin !== "plan" && <Field label="Origin">{step.origin.replace(/_/g, " ")}</Field>}
        {step.reviewRound !== undefined && <Field label="Review round">{step.reviewRound}</Field>}
        {t && (
          <>
            <Field label="Model">{t.models.join(", ") || "—"}</Field>
            <Field label="Tokens in / out">
              {formatTokens(t.inputTokens)} / {formatTokens(t.outputTokens)}
            </Field>
            <Field label="Calls">{t.calls}</Field>
            <Field label="Est. cost">{formatCost(t.estimatedCost)}</Field>
          </>
        )}
      </dl>
      {t?.approximate && (
        <p className="text-[12px] text-ink-3">Tokens matched to this step by agent and time (recorded before calls were linked to steps).</p>
      )}
      {step.handedOffFrom && step.handedOffFrom.length > 0 && (
        <p className="text-[12.5px] text-ink-2">
          <span className="text-ink-3">Handed off from </span>
          {step.handedOffFrom.map((h, i) => (
            <span key={h.key}>
              {i > 0 && ", "}
              {roleLabel(h.role)}
              <span className="text-ink-3"> · {stepByKey.get(h.key)?.title ?? h.key}</span>
            </span>
          ))}
        </p>
      )}
      {step.detail && <p className="whitespace-pre-wrap text-[13px] text-ink-2">{step.detail}</p>}
      {step.plans && step.plans.length > 0 && (
        <ul className="space-y-1 text-[12.5px] text-ink-2">
          {step.plans.map((p) => (
            <li key={p.version}>
              <span className="font-medium text-ink">v{p.version}</span> · {p.strategy}
              {p.createdBy === "fallback" ? " (fallback)" : ""}
              {p.subtaskCount !== null ? ` · ${p.subtaskCount} subtasks` : ""} · {clockTime(p.createdAt)}
            </li>
          ))}
        </ul>
      )}
      {step.error && (
        <div>
          <p className="text-[12px] font-medium text-red-600 dark:text-red-400">Error</p>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-red-600 dark:text-red-400">{step.error}</pre>
        </div>
      )}
      {step.input && <Mono label="Input" text={step.input} defaultOpen={step.input.length < 400} />}
      {step.output && <Mono label="Output" text={step.output} />}
    </div>
  );
}

function Waterfall({ run, now }: { run: Run; now: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const stepByKey = useMemo(() => {
    const m = new Map<string, Step>();
    for (const s of run.steps) if (s.subtaskKey && s.type === "execution") m.set(s.subtaskKey, s);
    return m;
  }, [run.steps]);

  const live = run.task.endedAt === null;
  const runStart = Math.min(run.task.createdAt, ...run.steps.map((s) => s.startedAt ?? Number.POSITIVE_INFINITY));
  const lastEnd = Math.max(...run.steps.map((s) => s.completedAt ?? s.startedAt ?? 0));
  const runEnd = live ? Math.max(now, lastEnd) : Math.max(run.task.endedAt ?? lastEnd, lastEnd);
  const span = Math.max(1, runEnd - runStart);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, ((ms - runStart) / span) * 100))}%`;

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
      {run.steps.map((step) => {
        const running = isActiveStatus(step.status) && step.completedAt === undefined;
        const error = isErrorStatus(step.status) || Boolean(step.error && step.type !== "push");
        const start = step.startedAt;
        const end = step.completedAt ?? (running ? now : undefined);
        const hasBar = start !== undefined && end !== undefined && end - start > 0;
        const tokens = step.tokens ? step.tokens.inputTokens + step.tokens.outputTokens : 0;
        const expanded = open === step.id;
        return (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : step.id)}
              aria-expanded={expanded}
              className="grid w-full grid-cols-[minmax(0,13rem)_minmax(0,1fr)_5.5rem] items-center gap-3 px-4 py-2.5 text-left transition hover:bg-hover max-sm:grid-cols-[minmax(0,1fr)_5rem]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(step.status)}`} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">
                    {stepLabel(step)}
                    {step.attempt && step.attempt > 1 ? <span className="font-normal text-ink-3"> · try {step.attempt}</span> : null}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">{step.title}</span>
                </span>
              </span>
              <span className="relative h-5 max-sm:hidden" aria-hidden="true">
                <span className="absolute inset-y-[9px] left-0 right-0 rounded-full bg-line" />
                {start !== undefined &&
                  (hasBar ? (
                    <span
                      className={`absolute inset-y-1 rounded ${error ? "bg-red-500" : running ? "text-ink-3" : "bg-ink/70"}`}
                      style={{
                        left: pct(start),
                        width: `max(3px, calc(${pct(end!)} - ${pct(start)}))`,
                        ...(running && !error ? STRIPES : {}),
                      }}
                    />
                  ) : (
                    <span
                      className={`absolute inset-y-0.5 w-[3px] -translate-x-1/2 rounded ${error ? "bg-red-500" : "bg-ink-2"}`}
                      style={{ left: pct(start) }}
                    />
                  ))}
              </span>
              <span className="text-right text-[12px] tabular-nums leading-tight">
                <span className="block text-ink-2">
                  {running ? formatDuration(now - (start ?? now)) : step.durationMs !== undefined && step.durationMs > 0 ? formatDuration(step.durationMs) : ""}
                </span>
                <span className="block text-ink-3">{tokens ? `${formatTokens(tokens)} tok${step.tokens?.approximate ? "*" : ""}` : ""}</span>
              </span>
            </button>
            {expanded && <StepDetail step={step} stepByKey={stepByKey} />}
          </li>
        );
      })}
    </ul>
  );
}

function Agents({ run }: { run: Run }) {
  const byAgent = run.totals.byAgent;
  if (run.handoffs.length === 0 && byAgent.length === 0) return null;
  return (
    <Section title="Agents">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {run.handoffs.length > 0 && (
          <ul className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3">
            {run.handoffs.map((h) => (
              <li key={`${h.from}-${h.to}`} className="flex items-center gap-1.5 text-[13px]">
                <span>{roleLabel(h.from)}</span>
                <ArrowRight size={12} className="text-ink-3" />
                <span>{roleLabel(h.to)}</span>
                {h.count > 1 && <span className="tabular-nums text-ink-3">×{h.count}</span>}
              </li>
            ))}
          </ul>
        )}
        {byAgent.length > 0 && (
          <ul className={`divide-y divide-line ${run.handoffs.length ? "border-t border-line" : ""}`}>
            {byAgent.map((a) => (
              <li key={a.role} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{roleLabel(a.role)}</span>
                <span className="tabular-nums text-ink-3">{a.calls} calls</span>
                <span className="w-24 text-right tabular-nums text-ink-2">
                  {formatTokens(a.inputTokens)} / {formatTokens(a.outputTokens)}
                </span>
                <span className="w-16 text-right tabular-nums text-ink-3">{formatCost(a.estimatedCost)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function Events({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  if (run.events.length === 0) return null;
  return (
    <section className="mt-10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-ink"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Raw events
        <span className="tabular-nums text-ink-3">
          {run.events.length}
          {run.eventsTruncated ? " (latest)" : ""}
        </span>
      </button>
      {open && (
        <ul className="mt-3 max-h-[480px] divide-y divide-line overflow-y-auto rounded-xl border border-line bg-panel font-mono text-[11.5px]">
          {run.events.map((e) => (
            <li key={e._id} className="px-3 py-1.5">
              <div className="flex gap-2">
                <span className="w-10 shrink-0 tabular-nums text-ink-3">{e.sequence ?? "—"}</span>
                <span className="w-12 shrink-0 tabular-nums text-ink-3">{clockTime(e.createdAt)}</span>
                <span className={`min-w-0 flex-1 break-words ${e.level === "error" ? "text-red-600 dark:text-red-400" : e.level === "warn" ? "text-ink" : "text-ink-2"}`}>
                  {e.type}
                  {e.subtaskKey ? <span className="text-ink-3"> [{e.subtaskKey}]</span> : null}
                  {e.message ? <span className="text-ink"> {e.message}</span> : null}
                </span>
              </div>
              {e.payload && <p className="ml-24 mt-0.5 break-all text-ink-3">{e.payload}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function RunTracePage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId;
  const run = useQuery(api.runs.get, taskId ? { taskId: taskId as never } : "skip");
  const live = run ? run.task.endedAt === null : false;
  const now = useNow(live);

  const models = run ? Object.keys(run.totals.byModel) : [];
  const duration = run ? (run.totals.durationMs ?? now - run.task.startedAt) : null;
  const errors = run ? run.steps.filter((s) => isErrorStatus(s.status)).length : 0;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={run?.task.projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-4xl">
          <Link
            href={run ? `/runs?project=${run.task.projectId}` : "/runs"}
            className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink"
          >
            <ArrowLeft size={13} /> Runs
          </Link>

          {run === undefined ? (
            <div className="mt-6 space-y-3" aria-label="Loading run">
              <div className="h-8 w-1/2 animate-pulse rounded-lg bg-hover" />
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : run === null ? (
            <p className="mt-10 text-[14px] text-ink-2">This run no longer exists.</p>
          ) : (
            <>
              <header className="mt-3">
                <p className="truncate text-[13px] text-ink-3">{run.task.projectName}</p>
                <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight">{run.task.title}</h1>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot(run.task.status)}`} />
                    {taskStatusLabel(run.task.status)}
                  </span>
                  <span className="text-ink-3">·</span>
                  <span className="tabular-nums">{formatDuration(duration)}</span>
                  <span className="text-ink-3">·</span>
                  <span className="tabular-nums">
                    {formatTokens(run.totals.inputTokens)} in / {formatTokens(run.totals.outputTokens)} out
                  </span>
                  <span className="text-ink-3">·</span>
                  <span className="tabular-nums">{formatCost(run.totals.estimatedCost)}</span>
                  {errors > 0 && (
                    <>
                      <span className="text-ink-3">·</span>
                      <span className="text-red-600 dark:text-red-400">
                        {errors} {errors === 1 ? "error" : "errors"}
                      </span>
                    </>
                  )}
                </p>
                {models.length > 0 && <p className="mt-1 truncate text-[12.5px] text-ink-3">{models.join(", ")}</p>}
                {run.task.errorMessage && (
                  <p className="mt-3 rounded-lg border border-line px-3 py-2 text-[13px] text-red-600 dark:text-red-400">{run.task.errorMessage}</p>
                )}
              </header>

              <Section title="Timeline" aside={run.steps.length}>
                <Waterfall run={run} now={now} />
                {(run.steps.some((s) => s.tokens?.approximate) || run.totals.unattributed) && (
                  <p className="mt-2 text-[12px] text-ink-3">
                    * tokens matched by agent and time.
                    {run.totals.unattributed
                      ? ` ${formatTokens(run.totals.unattributed.inputTokens + run.totals.unattributed.outputTokens)} tokens could not be tied to a step.`
                      : ""}
                  </p>
                )}
              </Section>

              <Agents run={run} />
              <Events run={run} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
