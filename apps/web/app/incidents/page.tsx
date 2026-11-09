"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, CheckCircle2, Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { useToast } from "@/components/Toasts";
import { relativeTime } from "@/lib/runFormat";
import { TRIGGER_LABELS } from "@/lib/incidentLabels";

type StatusFilter = "open" | "resolved" | "all";
type TriggerFilter = "all" | "task_failed" | "subtask_escalated" | "subtask_blocked";
type Row = {
  _id: string;
  projectId: string;
  projectName: string | null;
  taskId: string;
  taskTitle: string | null;
  trigger: string;
  status: string;
  title: string;
  subtaskKey: string | null;
  failurePoint: { title?: string; role?: string } | null;
  error: string | null;
  owner: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className="mt-0.5 text-[22px] font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="truncate text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

/**
 * Incident Room: the dedicated board for handling system failures — failed
 * runs and escalated / blocked subtasks. Triage from here (claim, resolve,
 * reopen) or open a row for the full detail (owner note, escalation,
 * suggest-fix, events, audit).
 */
function IncidentRoom() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const projectId = params.get("project") ?? undefined;
  const filter = (params.get("status") as StatusFilter | null) ?? "open";
  const projects = useQuery(api.projects.list, {}) as Array<{ _id: string; name: string }> | undefined;
  const rows = useQuery(api.incidents.list, {
    ...(projectId ? { projectId: projectId as never } : {}),
    ...(filter !== "all" ? { status: filter } : {}),
  }) as Row[] | undefined;
  const update = useMutation(api.incidents.update);
  const [trigger, setTrigger] = useState<TriggerFilter>("all");
  const [search, setSearch] = useState("");
  const [working, setWorking] = useState<string | null>(null);

  const stats = useMemo(() => {
    if (!rows) return null;
    const open = rows.filter((r) => r.status === "open").length;
    const failed = rows.filter((r) => r.trigger === "task_failed").length;
    const unassigned = rows.filter((r) => r.status === "open" && !r.owner).length;
    const resolvedToday = rows.filter(
      (r) => r.status === "resolved" && r.resolvedAt && Date.now() - r.resolvedAt < 86_400_000,
    ).length;
    return { open, failed, unassigned, resolvedToday };
  }, [rows]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (trigger !== "all" && row.trigger !== trigger) return false;
      if (!q) return true;
      return (
        row.title.toLowerCase().includes(q) ||
        (row.taskTitle ?? "").toLowerCase().includes(q) ||
        (row.projectName ?? "").toLowerCase().includes(q) ||
        (row.owner ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, trigger, search]);

  const setFilter = (next: StatusFilter) => {
    const q = new URLSearchParams(params.toString());
    q.set("status", next);
    router.replace(`/incidents?${q.toString()}`);
  };

  const setProjectFilter = (next: string | undefined) => {
    const q = new URLSearchParams(params.toString());
    if (next) q.set("project", next);
    else q.delete("project");
    const qs = q.toString();
    router.replace(qs ? `/incidents?${qs}` : "/incidents");
  };

  const triage = async (row: Row, patch: { status?: "open" | "resolved"; owner?: string }, label: string) => {
    setWorking(row._id);
    try {
      await update({ incidentId: row._id as never, ...patch });
      toast("success", label);
    } catch {
      toast("error", "Couldn't update", "Try again.");
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-4xl">
          <header>
            <h1 className="text-[26px] font-semibold tracking-tight">Incident Room</h1>
            <p className="mt-1 max-w-2xl text-[14px] text-ink-2">
              The board for handling system failures: failed runs plus escalated or blocked subtasks. Claim one, note what you
              did, resolve it — or open it for the replay, escalation and suggest-fix.
            </p>
          </header>

          {stats && (
            <div className="mt-5 grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel sm:grid-cols-4 sm:divide-y-0">
              <Stat label="Open" value={String(stats.open)} sub="needing attention" />
              <Stat label="Unassigned" value={String(stats.unassigned)} sub="no owner yet" />
              <Stat label="Task failed" value={String(stats.failed)} sub="hard failures" />
              <Stat label="Resolved (24h)" value={String(stats.resolvedToday)} sub="closed today" />
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex gap-4 text-[13px]" role="tablist" aria-label="Incident status">
              {(["open", "resolved", "all"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  onClick={() => setFilter(key)}
                  className={filter === key ? "text-ink underline decoration-line-strong underline-offset-4" : "text-ink-3 hover:text-ink"}
                >
                  {key === "open" ? "Open" : key === "resolved" ? "Resolved" : "All"}
                </button>
              ))}
            </div>
            <select
              value={projectId ?? ""}
              onChange={(event) => setProjectFilter(event.target.value || undefined)}
              aria-label="Project"
              className="ml-auto h-[30px] max-w-[180px] truncate rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <option value="">All projects</option>
              {projects?.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search incidents…"
              aria-label="Search incidents"
              className="h-[30px] w-44 rounded-lg border border-line bg-panel px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Trigger">
            {(["all", "task_failed", "subtask_escalated", "subtask_blocked"] as TriggerFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={trigger === key}
                onClick={() => setTrigger(key)}
                className={`rounded-lg border border-line px-2.5 py-1 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  trigger === key ? "bg-hover font-medium text-ink" : "bg-panel text-ink-3 hover:text-ink"
                }`}
              >
                {key === "all" ? "All triggers" : TRIGGER_LABELS[key]}
              </button>
            ))}
          </div>

          {rows === undefined ? (
            <div className="mt-8 space-y-3" aria-label="Loading incidents">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                {filter === "resolved" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No incidents here.</p>
              <p className="mt-1 text-[13px] text-ink-3">A failed run or an escalated subtask opens one automatically.</p>
            </div>
          ) : (
            <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {visible.map((row) => (
                <li key={row._id}>
                  <div className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.status === "open" ? (row.trigger === "task_failed" ? "bg-destructive" : "bg-warn") : "bg-ink-3"}`}
                    />
                    <Link href={`/incidents/${row._id}`} className="min-w-0 flex-1">
                      <p className="truncate text-[14px]">{row.title}</p>
                      <p className="truncate text-[12.5px] text-ink-3">
                        {[
                          TRIGGER_LABELS[row.trigger],
                          projectId ? null : row.projectName,
                          row.failurePoint?.title ?? null,
                          row.owner ? `Owner ${row.owner}` : row.status === "open" ? "Unassigned" : null,
                          row.status === "resolved" ? "Resolved" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </Link>
                    <span className="shrink-0 text-[12.5px] tabular-nums text-ink-3">{relativeTime(row.createdAt)}</span>
                    {row.status === "open" && !row.owner && (
                      <button
                        type="button"
                        disabled={working === row._id}
                        onClick={() => void triage(row, { owner: "central" }, "Claimed")}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-[12px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
                      >
                        <Plus size={12} /> Claim
                      </button>
                    )}
                    {row.status === "open" ? (
                      <button
                        type="button"
                        disabled={working === row._id}
                        onClick={() => void triage(row, { status: "resolved" }, "Resolved")}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-[12px] text-emerald-700 outline-none transition hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                      >
                        <CheckCircle2 size={12} /> Resolve
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={working === row._id}
                        onClick={() => void triage(row, { status: "open" }, "Reopened")}
                        className="shrink-0 rounded-lg border border-line px-2 py-1 text-[12px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
                      >
                        Reopen
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[12px] text-ink-3">
            Triage here, or open an incident for its error, escalation options, replay, audit trail and suggest-fix.
          </p>
        </div>
      </main>
    </div>
  );
}

export default function IncidentsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <IncidentRoom />
    </Suspense>
  );
}
