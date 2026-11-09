"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import Segmented from "@/components/ui/segmented";
import { compact, duration, pct, usd } from "@/lib/metrics";
import { relativeTime, statusDot } from "@/lib/runFormat";

type Days = "7" | "30" | "90";
const DAY_OPTIONS: ReadonlyArray<{ value: Days; label: string }> = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
];

function Row({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-4 px-4 py-2.5">
      <span className="w-44 shrink-0 text-[13px] text-ink-2">{label}</span>
      <span className="min-w-0 flex-1 text-[14px] tabular-nums text-ink">
        {value}
        {note !== undefined && note !== null && <span className="text-ink-3"> · {note}</span>}
      </span>
    </li>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Agent performance profile (orgIntel.agentProfile): one agent's work in a
 * 7/30/90-day window — subtasks by status and success rate, time, tokens
 * and cost, fixes, how its work fared in review and QA, the verdicts it
 * gave, evaluations of the tasks it worked on, chat replies, and its
 * latest subtasks linking to their runs. Role label only.
 */
export default function AgentProfilePage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [days, setDays] = useState<Days>("30");
  const [projectId, setProjectId] = useState<string>("");
  const projects = useQuery(api.projects.list, {}) as { _id: string; name: string }[] | undefined;
  const p = useQuery(api.orgIntel.agentProfile, {
    agentId: agentId as never,
    sinceDays: Number(days),
    ...(projectId ? { projectId: projectId as never } : {}),
  });

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <Link href="/team" className="inline-flex items-center gap-1 text-[13px] text-ink-3 outline-none transition hover:text-ink focus-visible:text-ink">
            <ArrowLeft size={13} /> Team
          </Link>

          {p === undefined ? (
            <div className="mt-6 space-y-3" aria-label="Loading profile">
              <div className="h-8 w-1/3 animate-pulse rounded-lg bg-hover" />
              <div className="h-64 animate-pulse rounded-xl bg-hover" />
            </div>
          ) : p === null ? (
            <p className="mt-10 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">This agent no longer exists.</p>
          ) : (
            <>
              <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="text-[26px] font-semibold tracking-tight">{p.agent.label}</h1>
                  <p className="mt-1 text-[13px] text-ink-3">
                    {p.agent.enabled ? "Enabled" : "Disabled"}
                    {` · ${p.agent.runtime === "opencode" ? "OpenCode" : "Built-in"}`}
                    {` · concurrency ${p.agent.maxConcurrency ?? 1}`}
                    {p.agent.recognized ? "" : " · custom role"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {projects && projects.length > 1 && (
                    <select
                      aria-label="Project"
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="h-[30px] max-w-[180px] truncate rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      <option value="">All projects</option>
                      {projects.map((proj) => (
                        <option key={proj._id} value={proj._id}>
                          {proj.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Segmented label="Time window" value={days} options={DAY_OPTIONS} onChange={setDays} />
                </div>
              </header>

              <ul className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                <Row
                  label="Subtasks"
                  value={p.subtasks.total}
                  note={
                    p.subtasks.total
                      ? `${p.subtasks.status.done} done, ${p.subtasks.status.failed} failed${p.subtasks.status.running ? `, ${p.subtasks.status.running} running` : ""}${p.subtasks.status.blocked ? `, ${p.subtasks.status.blocked} blocked` : ""}${p.subtasks.status.pending ? `, ${p.subtasks.status.pending} pending` : ""}`
                      : undefined
                  }
                />
                <Row label="Success rate" value={pct(p.subtasks.successRate)} note={p.subtasks.successRate === null ? "nothing finished yet" : "done ÷ (done + failed)"} />
                <Row
                  label="Time per run"
                  value={`${duration(p.duration.medianMs)} median`}
                  note={p.duration.timedRuns ? `${duration(p.duration.avgMs)} average over ${plural(p.duration.timedRuns, "run")}` : undefined}
                />
                <Row
                  label="Tokens"
                  value={`${p.tokens.estimated ? "≈" : ""}${compact(p.tokens.total)}`}
                  note={`${usd(p.tokens.cost)} · ${plural(p.tokens.calls, "LLM call")}`}
                />
                <Row label="Fixes" value={p.fixes} note={`fix subtasks it ran · ${plural(p.executions.retries, "retry", "retries")}`} />
                <Row
                  label="Review of its work"
                  value={pct(p.workReviewed.rate)}
                  note={p.workReviewed.tasks ? `approved first time in ${p.workReviewed.firstPass} of ${plural(p.workReviewed.tasks, "task")}` : "no reviewed tasks"}
                />
                <Row
                  label="QA of its work"
                  value={pct(p.workQaed.rate)}
                  note={p.workQaed.tasks ? `passed first time in ${p.workQaed.firstPass} of ${plural(p.workQaed.tasks, "task")}` : "no QA'd tasks"}
                />
                {(p.reviewRuns > 0 || p.qaRuns > 0) && (
                  <Row
                    label="Verdicts it gave"
                    value={`${p.reviewRuns + p.qaRuns} passes`}
                    note={[
                      p.reviewRuns ? `review: ${p.verdictsGiven.review.approved} approved, ${p.verdictsGiven.review.changesRequested} changes requested` : null,
                      p.qaRuns ? `QA: ${p.verdictsGiven.qa.passed} passed, ${p.verdictsGiven.qa.failed} failed${p.verdictsGiven.qa.blocked ? `, ${p.verdictsGiven.qa.blocked} blocked` : ""}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                )}
                <Row
                  label="Evaluations"
                  value={p.evals.tasks ? `${p.evals.passed} passed` : "—"}
                  note={p.evals.tasks ? `${p.evals.failed} failed, ${p.evals.inconclusive} inconclusive, of ${plural(p.evals.tasks, "task")} it worked on` : "no evaluated tasks"}
                />
                <Row label="Chat replies" value={p.chatReplies} />
              </ul>

              <h2 className="mt-10 mb-3 text-[13px] font-medium text-ink-2">Latest subtasks</h2>
              {p.recent.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">No subtasks in {days} days.</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                  {p.recent.map((r) => (
                    <li key={`${r.taskId}-${r.key}`}>
                      <Link
                        href={`/runs/${r.taskId}`}
                        className="flex items-center gap-3 px-4 py-2.5 outline-none transition hover:bg-hover focus-visible:bg-hover"
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(r.status)}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px]">{r.title}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {r.taskTitle ?? "Task"} · {r.kind.replace(/_/g, " ")} · {r.status.replace(/_/g, " ")}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-[12px] tabular-nums text-ink-3">
                          {r.durationMs !== null ? `${duration(r.durationMs)} · ` : ""}
                          {relativeTime(r.at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {p.truncated.length > 0 && (
                <p className="mt-3 text-[12px] text-ink-3">Read limit reached for {p.truncated.join(", ")}; older rows are left out.</p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
