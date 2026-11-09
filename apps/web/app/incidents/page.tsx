"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { relativeTime } from "@/lib/runFormat";
import { TRIGGER_LABELS } from "@/lib/incidentLabels";

/**
 * Incident Room: every failed run and escalated / blocked subtask, newest
 * first. A row opens the incident; `?project=<id>` narrows to one project.
 */
function IncidentsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? undefined;
  const filter = (params.get("status") as "open" | "resolved" | "all" | null) ?? "open";
  const rows = useQuery(api.incidents.list, {
    ...(projectId ? { projectId: projectId as never } : {}),
    ...(filter !== "all" ? { status: filter } : {}),
  });
  const setFilter = (next: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("status", next);
    router.replace(`/incidents?${q.toString()}`);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header>
            <h1 className="text-[26px] font-semibold tracking-tight">Incidents</h1>
            <p className="mt-1 text-[15px] text-ink-2">
              {rows === undefined
                ? "Loading…"
                : rows.length === 0
                  ? filter === "open"
                    ? "Nothing open"
                    : "No incidents"
                  : `${rows.length} ${filter === "all" ? "" : `${filter} `}${rows.length === 1 ? "incident" : "incidents"}`}
            </p>
            <div className="mt-3 flex gap-4 text-[13px]" role="tablist" aria-label="Incident status">
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
              {projectId && (
                <Link href="/incidents" className="ml-auto text-ink-3 hover:text-ink">
                  Show all projects
                </Link>
              )}
            </div>
          </header>

          {rows === undefined ? (
            <div className="mt-8 space-y-3" aria-label="Loading incidents">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <AlertTriangle size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No incidents here.</p>
              <p className="mt-1 text-[13px] text-ink-3">A failed run or an escalated subtask opens one automatically.</p>
            </div>
          ) : (
            <ul className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {rows.map((row) => (
                <li key={row._id}>
                  <Link href={`/incidents/${row._id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-hover">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.status === "open" ? (row.trigger === "task_failed" ? "bg-destructive" : "bg-warn") : "bg-ink-3"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px]">{row.title}</p>
                      <p className="truncate text-[12.5px] text-ink-3">
                        {[
                          TRIGGER_LABELS[row.trigger],
                          projectId ? null : row.projectName,
                          row.failurePoint?.title ?? null,
                          row.owner ? `Owner ${row.owner}` : null,
                          row.status === "resolved" ? "Resolved" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-[12.5px] tabular-nums text-ink-3">{relativeTime(row.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

export default function IncidentsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <IncidentsPage />
    </Suspense>
  );
}
