"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ContextInspector, { CopyButton } from "@/components/context/ContextInspector";
import { diffRuns, lineDiff, type DiffRow, type RunSide } from "@/api/convex/lib/replay";
import { roleLabel } from "@/lib/agentRoles";
import { clockTime } from "@/lib/format";
import { taskStatusLabel } from "@/lib/taskStatus";

const KIND_LABEL: Record<string, string> = {
  instruction: "Instruction",
  classification: "Classification",
  plan: "Plan",
  routing: "Routing",
  llm: "LLM call",
  tool: "Tool call",
  verification: "Verification",
  qa: "QA",
  review: "Review",
  subtask: "Subtask",
  approval: "Approval",
  result: "Result",
  event: "Event",
};

/** Step timeline with prev/next stepping; the failure step is highlighted. */
function Replay({ taskId }: { taskId: string }) {
  const data = useQuery(api.contextSnapshots.replay, { taskId: taskId as never });
  const [index, setIndex] = useState<number | null>(null);
  const steps = data?.steps ?? [];
  // Open on the failure point when there is one, else the first step.
  const current = index ?? (data ? Math.max(0, data.failureIndex) : 0);
  const step = steps[current];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight" || e.key === "j") setIndex((i) => Math.min(steps.length - 1, (i ?? current) + 1));
      if (e.key === "ArrowLeft" || e.key === "k") setIndex((i) => Math.max(0, (i ?? current) - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [steps.length, current]);

  if (data === undefined) return <div className="h-24 rounded-xl bg-hover" aria-label="Loading replay" />;
  if (data === null) return null;

  const stepButton = "inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40";
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <ol className="max-h-[32rem] divide-y divide-line overflow-y-auto">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-current={i === current}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-hover ${i === current ? "bg-hover" : ""}`}
              >
                <span className="w-6 shrink-0 tabular-nums text-ink-3">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${s.failed ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
                    {KIND_LABEL[s.kind] ?? s.kind}
                    {s.agentRole ? ` · ${roleLabel(s.agentRole)}` : ""}
                    {i === data.failureIndex ? " · failure point" : ""}
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-3">
                    {s.kind === "llm" ? s.label : s.eventType ?? s.label}
                    {s.subtaskKey ? ` · ${s.subtaskKey}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-[13px] tabular-nums text-ink-3">
            Step {current + 1} of {steps.length}
            {step ? ` · ${clockTime(step.at)}` : ""}
          </p>
          <div className="flex gap-2">
            <button type="button" className={stepButton} disabled={current <= 0} onClick={() => setIndex(Math.max(0, current - 1))} aria-label="Previous step">
              <ArrowLeft size={14} /> Prev
            </button>
            <button
              type="button"
              className={stepButton}
              disabled={current >= steps.length - 1}
              onClick={() => setIndex(Math.min(steps.length - 1, current + 1))}
              aria-label="Next step"
            >
              Next <ArrowRight size={14} />
            </button>
            {data.failureIndex >= 0 && current !== data.failureIndex && (
              <button type="button" className={stepButton} onClick={() => setIndex(data.failureIndex)}>
                Failure
              </button>
            )}
          </div>
        </div>
        {step && (
          <div className={`rounded-xl border bg-panel px-4 py-3.5 ${step.failed ? "border-red-500/60" : "border-line"}`}>
            <p className={`text-[14px] font-medium ${step.failed ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
              {KIND_LABEL[step.kind] ?? step.kind}
              <span className="font-normal text-ink-3"> · {step.label}</span>
            </p>
            {step.detail && (
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-2">{step.detail}</pre>
            )}
            {step.snapshotId && (
              <div className="mt-4 border-t border-line pt-4">
                <ContextInspector snapshotId={step.snapshotId} />
              </div>
            )}
          </div>
        )}
        {data.snapshotCount === 0 && (
          <p className="mt-2 text-[12px] text-ink-3">No context snapshots for this run (recorded before the feature, past retention, or CONTEXT_SNAPSHOTS=0). Steps come from the event log only.</p>
        )}
      </div>
    </div>
  );
}

const GROUP_LABEL: Record<DiffRow["group"], string> = {
  plan: "Plan",
  routing: "Routed agents",
  prompt: "Prompts by section",
  output: "Outputs",
  error: "Errors",
};

function DiffCell({ text }: { text?: string }) {
  if (text === undefined) return <span className="text-ink-3">—</span>;
  return <span className="line-clamp-3 whitespace-pre-wrap break-words">{text || "(empty)"}</span>;
}

function TextDiff({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => lineDiff(a, b), [a, b]);
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className={l.op === "-" ? "text-red-600 dark:text-red-400" : l.op === "+" ? "text-emerald-700 dark:text-emerald-400" : "text-ink-2"}>
          {l.op === "=" ? "  " : `${l.op} `}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/** Two runs side by side, diffed by step. */
function Compare({ taskId }: { taskId: string }) {
  const candidates = useQuery(api.contextSnapshots.compareCandidates, { taskId: taskId as never });
  const [other, setOther] = useState<string>("");
  const [changedOnly, setChangedOnly] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const a = useQuery(api.contextSnapshots.compareSide, { taskId: taskId as never });
  const b = useQuery(api.contextSnapshots.compareSide, other ? { taskId: other as never } : "skip");
  const rows = useMemo(() => (a && b ? diffRuns(a as RunSide, b as RunSide) : []), [a, b]);
  const shown = changedOnly ? rows.filter((r) => r.mark !== "same") : rows;
  const groups = (["plan", "routing", "prompt", "output", "error"] as const).filter((g) => shown.some((r) => r.group === g));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          Compare with
          <select
            value={other}
            onChange={(e) => setOther(e.target.value)}
            className="h-8 max-w-[22rem] rounded-lg border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-ink-3"
          >
            <option value="">Pick a run…</option>
            {(candidates ?? []).map((c) => (
              <option key={c._id} value={c._id}>
                {c.sameCommand ? "Same ask · " : ""}
                {c.title} · {taskStatusLabel(c.status)} · {new Date(c.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
          Differences only
        </label>
      </div>
      {!other ? (
        <p className="text-[13px] text-ink-3">Pick another run of this ask (listed first) or any recent run in the project.</p>
      ) : !a || !b ? (
        <div className="h-16 rounded-xl bg-hover" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2 text-[12px] text-ink-3">
            <span>Step</span>
            <span className="truncate">This run · {taskStatusLabel(a.status)}</span>
            <span className="truncate">{b.label} · {taskStatusLabel(b.status)}</span>
          </div>
          {groups.length === 0 && <p className="px-4 py-3 text-[13px] text-ink-3">No differences.</p>}
          {groups.map((g) => (
            <div key={g}>
              <p className="border-b border-line px-4 py-1.5 text-[12px] font-medium text-ink-2">{GROUP_LABEL[g]}</p>
              <ul className="divide-y divide-line">
                {shown
                  .filter((r) => r.group === g)
                  .map((r) => {
                    const id = `${r.group}:${r.key}`;
                    const expandable = r.mark === "changed" && (r.a ?? "").length + (r.b ?? "").length > 0;
                    return (
                      <li key={id} className="text-[12.5px]">
                        <button
                          type="button"
                          disabled={!expandable}
                          onClick={() => setOpen(open === id ? null : id)}
                          className="grid w-full grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-4 py-2 text-left enabled:hover:bg-hover"
                        >
                          <span className="truncate text-ink-2" title={r.key}>
                            {r.key}
                            <span className="block text-[11px] text-ink-3">
                              {r.mark === "same" ? "same" : r.mark === "changed" ? "changed" : r.mark === "only_a" ? "only here" : "only there"}
                            </span>
                          </span>
                          <span className="min-w-0 text-ink"><DiffCell text={r.a} /></span>
                          <span className="min-w-0 text-ink"><DiffCell text={r.b} /></span>
                        </button>
                        {open === id && (
                          <div className="px-4 pb-3">
                            <div className="mb-1 flex justify-end gap-3">
                              <CopyButton text={r.a ?? ""} what="Left side" label="Copy left" />
                              <CopyButton text={r.b ?? ""} what="Right side" label="Copy right" />
                            </div>
                            <TextDiff a={r.a ?? ""} b={r.b ?? ""} />
                          </div>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Replay Session: step timeline, plus compare mode. */
export default function ReplaySession({ taskId }: { taskId: string }) {
  const [mode, setMode] = useState<"replay" | "compare">("replay");
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-ink-2">{mode === "replay" ? "Replay" : "Compare"}</h2>
        <div className="flex gap-3 text-[12.5px]" role="tablist" aria-label="Replay mode">
          {(["replay", "compare"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={mode === m ? "text-ink underline decoration-line-strong underline-offset-4" : "text-ink-3 hover:text-ink"}
            >
              {m === "replay" ? "Replay" : "Compare"}
            </button>
          ))}
        </div>
      </div>
      {mode === "replay" ? <Replay taskId={taskId} /> : <Compare taskId={taskId} />}
    </section>
  );
}
