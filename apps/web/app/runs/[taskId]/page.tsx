"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Copy, Download, FileJson, FileText } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import SubtaskLiveOutput from "@/components/SubtaskLiveOutput";
import { useToast } from "@/components/Toasts";
import { buildRunJson, buildRunMarkdown, exportFilename } from "@/lib/runExport";
import webPackage from "../../../package.json";
import { roleLabel } from "@/lib/agentRoles";
import { taskStatusLabel } from "@/lib/taskStatus";
import { clockTime } from "@/lib/format";
import RoutingInspector from "@/components/runs/RoutingInspector";
import PlanGraph from "@/components/runs/PlanGraph";
import Contracts from "@/components/runs/Contracts";
import { ReviewerSection, SecondOpinionButton } from "@/components/review/Reviewer";
import ReplaySession from "@/components/runs/ReplaySession";
import RunContext from "@/components/context/RunContext";
import ReplanDiff from "@/components/runs/ReplanDiff";
import { MODEL_TIER_LABELS, type ModelTierKey } from "@/api/convex/lib/modelTiers";
import { formatEstimateLine } from "@/api/convex/lib/estimate";
import {
  formatCost,
  formatDuration,
  formatTokens,
  isActiveStatus,
  isErrorStatus,
  statusDot,
} from "@/lib/runFormat";
import { PERMISSION_MODE_LABELS, normalizePermissionMode } from "@/api/convex/lib/permissionModes";

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
  // Approvals wait on the user, not on the agent that asked.
  if (step.type === "approval") return "You";
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
        <span className="font-normal tabular-nums text-ink-3">{text.length.toLocaleString("en-US")} chars</span>
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

function StepDetail({ step, stepByKey, taskId }: { step: Step; stepByKey: Map<string, Step>; taskId: string }) {
  const t = step.tokens;
  const running = isActiveStatus(step.status) && step.completedAt === undefined;
  return (
    <div className="space-y-3 border-t border-line bg-canvas/40 px-4 py-3.5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="Status">{step.status.replace(/_/g, " ")}</Field>
        {step.startedAt !== undefined && <Field label="Started">{clockTime(step.startedAt)}</Field>}
        {step.durationMs !== undefined && (
          <Field label={step.waiting ? "Waiting" : "Duration"}>{formatDuration(step.durationMs)}</Field>
        )}
        {step.attempt !== undefined && <Field label="Attempt">{step.attempt}</Field>}
        {step.capability && <Field label="Capability">{step.capability}</Field>}
        {step.subtaskKind && <Field label="Kind">{step.subtaskKind.replace(/_/g, " ")}</Field>}
        {step.origin && step.origin !== "plan" && <Field label="Origin">{step.origin.replace(/_/g, " ")}</Field>}
        {step.reviewRound !== undefined && <Field label="Review round">{step.reviewRound}</Field>}
        {t && (
          <>
            <Field label="Model">{t.models.join(", ") || "—"}</Field>
            <Field label="Tokens in / out">
              {t.estimated ? "≈" : ""}{formatTokens(t.inputTokens)} / {formatTokens(t.outputTokens)}
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
      {running && step.type === "execution" && step.subtaskKey && (
        <SubtaskLiveOutput taskId={taskId} subtaskKey={step.subtaskKey} className="" />
      )}
      {step.type === "execution" && step.subtaskKey && !running && (step.status === "completed" || step.status === "failed" || step.status === "blocked") && (
        <SecondOpinionButton taskId={taskId} subtaskKey={step.subtaskKey} />
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
                      className={`absolute inset-y-1 rounded ${
                        step.waiting
                          ? "border border-dashed border-ink-3 bg-ink/10"
                          : error ? "bg-red-500" : running ? "text-ink-3" : "bg-ink/70"
                      }`}
                      style={{
                        left: pct(start),
                        width: `max(3px, calc(${pct(end!)} - ${pct(start)}))`,
                        ...(running && !error && !step.waiting ? STRIPES : {}),
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
                <span className={`block ${step.waiting ? "text-ink-3" : "text-ink-2"}`} title={step.waiting ? "Waiting for your approval" : undefined}>
                  {running ? formatDuration(now - (start ?? now)) : step.durationMs !== undefined && step.durationMs > 0 ? formatDuration(step.durationMs) : ""}
                </span>
                <span className="block text-ink-3">{tokens ? `${step.tokens?.estimated ? "≈" : ""}${formatTokens(tokens)} tok${step.tokens?.approximate ? "*" : ""}` : ""}</span>
              </span>
            </button>
            {expanded && <StepDetail step={step} stepByKey={stepByKey} taskId={run.task._id} />}
          </li>
        );
      })}
    </ul>
  );
}

/** Plan 022: tokens / cost per model tier (planner vs workers vs reviewer). */
function TierBreakdown({ run }: { run: Run }) {
  const tiers = (["planner", "worker", "reviewer"] as const).map((key) => ({ key, ...run.totals.byTier[key] }));
  const other = run.totals.byTier.other;
  if (tiers.every((t) => t.calls === 0) && other.calls === 0) return null;
  return (
    <ul className="divide-y divide-line border-b border-line">
      {tiers.map((t) => (
        <li key={t.key} className="flex items-center gap-3 px-4 py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">
            {MODEL_TIER_LABELS[t.key as ModelTierKey]}
            {run.totals.modelTiers[t.key as ModelTierKey] ? <span className="text-ink-3"> · tier model</span> : null}
          </span>
          <span className="tabular-nums text-ink-3">{t.calls} calls</span>
          <span className="w-24 text-right tabular-nums text-ink-2">
            {formatTokens(t.inputTokens)} / {formatTokens(t.outputTokens)}
          </span>
          <span className="w-16 text-right tabular-nums text-ink-3">{formatCost(t.estimatedCost)}</span>
        </li>
      ))}
      {other.calls > 0 && (
        <li className="flex items-center gap-3 px-4 py-2 text-[13px] text-ink-3">
          <span className="min-w-0 flex-1 truncate">Other</span>
          <span className="tabular-nums">{other.calls} calls</span>
          <span className="w-24 text-right tabular-nums">
            {formatTokens(other.inputTokens)} / {formatTokens(other.outputTokens)}
          </span>
          <span className="w-16 text-right tabular-nums">{formatCost(other.estimatedCost)}</span>
        </li>
      )}
    </ul>
  );
}

function Agents({ run }: { run: Run }) {
  const byAgent = run.totals.byAgent;
  if (run.handoffs.length === 0 && byAgent.length === 0) return null;
  return (
    <Section title="Agents">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <TierBreakdown run={run} />
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

/** "+12%" / "−8%" relative to the estimate; null when it would mislead. */
function delta(actual: number, estimate: number): string | null {
  if (!estimate || !Number.isFinite(actual)) return null;
  const pct = Math.round(((actual - estimate) / estimate) * 100);
  if (pct === 0) return "on estimate";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

/** After the run: what the estimate said next to what happened. */
function EstimateVsActual({ run }: { run: Run }) {
  const estimate = run.plan?.estimate;
  if (!estimate || run.task.endedAt === null) return null;
  const actualTokens = run.totals.inputTokens + run.totals.outputTokens;
  const duration = run.totals.durationMs;
  const inRange =
    duration !== null && duration >= estimate.durationMs.low && duration <= estimate.durationMs.high;
  const rows: Array<{ label: string; est: string; actual: string; note: string | null }> = [
    {
      label: "Tokens",
      est: `~${formatTokens(estimate.tokens.total)}`,
      actual: `${run.totals.estimated ? "≈" : ""}${formatTokens(actualTokens)}`,
      note: delta(actualTokens, estimate.tokens.total),
    },
    {
      label: "Cost",
      est: estimate.cost === null ? "—" : `~${formatCost(estimate.cost)}${estimate.costPartial ? "+" : ""}`,
      actual: formatCost(run.totals.estimatedCost),
      note:
        estimate.cost !== null && run.totals.estimatedCost !== null ? delta(run.totals.estimatedCost, estimate.cost) : null,
    },
    {
      label: "Duration",
      est: `${formatDuration(estimate.durationMs.low)} – ${formatDuration(estimate.durationMs.high)}`,
      actual: formatDuration(duration),
      note: duration === null ? null : inRange ? "within range" : duration < estimate.durationMs.low ? "faster" : "slower",
    },
  ];
  return (
    <Section title="Estimate vs actual">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-[6rem_1fr_1fr_6rem] items-center gap-3 px-4 py-2 text-[13px] max-sm:grid-cols-[5rem_1fr_1fr]">
              <span className="text-ink-2">{r.label}</span>
              <span className="tabular-nums text-ink-3">est. {r.est}</span>
              <span className="tabular-nums text-ink">{r.actual}</span>
              <span className="text-right text-[12px] tabular-nums text-ink-3 max-sm:hidden">{r.note ?? ""}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">
        An estimate from this project&apos;s recent runs ({estimate.basis.fromRole + estimate.basis.fromKind} of {estimate.subtaskCount} subtasks from history), not a guarantee. Review, QA and fix rounds added during the run, retries and planning are not in it.
        {(estimate as { carriedOver?: boolean }).carriedOver ? " The run was replanned; this is the first plan's estimate." : ""}
      </p>
    </Section>
  );
}

const APP_VERSION: string | null = typeof webPackage.version === "string" ? webPackage.version : null;

function downloadText(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Header menu: copy / download the run as Markdown or JSON (for pasting into an AI assistant). */
function ExportMenu({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run_ = (fn: () => void | Promise<void>) => () => {
    setOpen(false);
    void Promise.resolve()
      .then(fn)
      .catch((err) => toast("error", "Export failed", err instanceof Error ? err.message : undefined));
  };
  const opts = () => ({ exportedAt: Date.now(), appVersion: APP_VERSION });

  const copyMarkdown = run_(async () => {
    const md = buildRunMarkdown(run, opts());
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard is not available in this browser.");
    await navigator.clipboard.writeText(md);
    toast("success", "Run report copied", `${md.length.toLocaleString("en-US")} chars of Markdown`);
  });
  const downloadMarkdown = run_(() => {
    const o = opts();
    downloadText(buildRunMarkdown(run, o), exportFilename(run, "md", o.exportedAt), "text/markdown;charset=utf-8");
  });
  const downloadJson = run_(() => {
    const o = opts();
    downloadText(buildRunJson(run, o), exportFilename(run, "json", o.exportedAt), "application/json;charset=utf-8");
  });

  const item = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <Download size={14} />
        Export
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
          <button type="button" role="menuitem" className={item} onClick={copyMarkdown}>
            <Copy size={14} className="text-ink-3" /> Copy as Markdown
          </button>
          <button type="button" role="menuitem" className={item} onClick={downloadMarkdown}>
            <FileText size={14} className="text-ink-3" /> Download .md
          </button>
          <button type="button" role="menuitem" className={item} onClick={downloadJson}>
            <FileJson size={14} className="text-ink-3" /> Download .json
          </button>
        </div>
      )}
    </div>
  );
}

export default function RunTracePage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId;
  const run = useQuery(api.runs.get, taskId ? { taskId: taskId as never } : "skip");
  const [view, setView] = useState<"timeline" | "graph">("timeline");
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
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-ink-3">{run.task.projectName}</p>
                    <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight">{run.task.title}</h1>
                  </div>
                  <ExportMenu run={run} />
                </div>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot(run.task.status)}`} />
                    {taskStatusLabel(run.task.status)}
                  </span>
                  <span className="text-ink-3">·</span>
                  <span className="tabular-nums">{formatDuration(duration)}</span>
                  <span className="text-ink-3">·</span>
                  <span className="text-[13px] text-ink-3" title="Permission mode">
                    {PERMISSION_MODE_LABELS[normalizePermissionMode((run.task as { permissionMode?: string }).permissionMode)]}
                  </span>
                  <span className="text-ink-3">·</span>
                  <span className="tabular-nums">
                    {run.totals.estimated ? "≈" : ""}{formatTokens(run.totals.inputTokens)} in / {formatTokens(run.totals.outputTokens)} out
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
                {run.plan?.estimate && (
                  <p className="mt-1 text-[12.5px] tabular-nums text-ink-3" title="An estimate from this project's recent runs, not a guarantee">
                    {formatEstimateLine(run.plan.estimate)}
                  </p>
                )}
                {run.task.errorMessage && (
                  <p className="mt-3 rounded-lg border border-line px-3 py-2 text-[13px] text-red-600 dark:text-red-400">{run.task.errorMessage}</p>
                )}
              </header>

              <section className="mt-10">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h2 className="flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
                    {view === "timeline" ? "Timeline" : "Graph"}
                    <span className="tabular-nums text-ink-3">{view === "timeline" ? run.steps.length : run.graph.length}</span>
                  </h2>
                  <div className="flex gap-3 text-[12.5px]" role="tablist" aria-label="Run view">
                    {(["timeline", "graph"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="tab"
                        aria-selected={view === v}
                        onClick={() => setView(v)}
                        className={view === v ? "text-ink underline decoration-line-strong underline-offset-4" : "text-ink-3 hover:text-ink"}
                      >
                        {v === "timeline" ? "Timeline" : "Graph"}
                      </button>
                    ))}
                  </div>
                </div>
                {view === "graph" ? <PlanGraph nodes={run.graph} /> : <Waterfall run={run} now={now} />}
                {(run.steps.some((s) => s.tokens?.approximate) || run.totals.unattributed) && (
                  <p className="mt-2 text-[12px] text-ink-3">
                    * tokens matched by agent and time.
                    {run.totals.unattributed
                      ? ` ${formatTokens(run.totals.unattributed.inputTokens + run.totals.unattributed.outputTokens)} tokens could not be tied to a step.`
                      : ""}
                  </p>
                )}
              </section>

              {run.totals.estimated && (
                <p className="-mt-2 text-[12px] text-ink-3">≈ the provider reported no token usage for some calls; those counts are estimated (chars/4).</p>
              )}

              <EstimateVsActual run={run} />

              {run.contracts.some((c) => c.acceptance.length > 0 || c.objective || c.escalation) && (
                <Section title="Acceptance">
                  <Contracts rows={run.contracts} />
                </Section>
              )}

              <ReviewerSection
                taskId={run.task._id}
                subtaskTitles={Object.fromEntries(run.steps.filter((st) => st.subtaskKey).map((st) => [st.subtaskKey!, st.title]))}
                heading={(aside) => (
                  <h2 className="mb-1 mt-10 flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink-2">
                    Reviewer
                    {aside}
                  </h2>
                )}
              />

              {run.replans.length > 0 && (
                <Section title="Replan" aside={run.replans.length}>
                  <ReplanDiff replans={run.replans} />
                </Section>
              )}

              <Section title="Routing">
                <RoutingInspector routing={run.routing} instruction={run.task.command} />
              </Section>

              <ReplaySession taskId={String(run.task._id)} />
              <RunContext taskId={String(run.task._id)} />

              <Agents run={run} />
              <Events run={run} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
