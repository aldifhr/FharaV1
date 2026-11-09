"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConvex, useQuery } from "convex/react";
import { ChevronRight, ScrollText } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { roleLabel } from "@/lib/agentRoles";
import { clockTime, isSameDay, shortDate } from "@/lib/format";
import { useToast } from "@/components/Toasts";

type Filter = "all" | "config" | "tools" | "denied";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "config", label: "Config changes" },
  { key: "tools", label: "Tool calls" },
  { key: "denied", label: "Denied" },
];

type Row = {
  _id: string;
  createdAt: number;
  actor: string;
  actorRole: string | null;
  tool: string;
  action: string;
  decision: "allowed" | "denied" | "pending" | "recorded";
  target: string | null;
  details: unknown;
  projectName: string | null;
};

const PAGE = 50;

const DOT: Record<Row["decision"], string> = {
  allowed: "bg-ink-2",
  denied: "bg-destructive",
  pending: "bg-warn",
  recorded: "bg-line-strong",
};

function filterArgs(filter: Filter) {
  if (filter === "config") return { category: "config" as const };
  if (filter === "tools") return { category: "tools" as const };
  if (filter === "denied") return { decision: "denied" as const };
  return {};
}

function when(ms: number): string {
  return isSameDay(ms) ? clockTime(ms) : `${shortDate(ms)} ${clockTime(ms)}`;
}

/** "agent.update" -> "Agent update"; tool calls read "run_command · run". */
function actionLabel(row: Row): string {
  if (row.tool === "config" || row.tool === "approval") {
    const text = row.action.replace(/[._]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return `${row.tool} · ${row.action}`;
}

function actorLabel(row: Row): string {
  return row.actorRole ? roleLabel(row.actorRole) : row.actor;
}

function AuditPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [older, setOlder] = useState<Row[]>([]);
  // undefined until the first "Load more"; then the cursor that page returned.
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const convex = useConvex();
  const toast = useToast();

  const base = { ...(projectId ? { projectId: projectId as never } : {}), ...filterArgs(filter) };
  // The first page is live; older pages are fetched once on "Load more".
  const first = useQuery(api.auditLog.list, { ...base, limit: PAGE });
  const project = useQuery(api.projects.get, projectId ? { projectId } : "skip");

  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
  }, [filter, projectId]);

  const nextCursor = cursor !== undefined ? cursor : (first?.nextCursor ?? null);
  const firstIds = new Set<string>((first?.items ?? []).map((r) => r._id as string));
  const rows: Row[] = [...((first?.items ?? []) as Row[]), ...older.filter((r) => !firstIds.has(r._id))];

  const loadMore = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await convex.query(api.auditLog.list, { ...base, limit: PAGE, cursor: nextCursor });
      setOlder((prev) => [...prev, ...(page.items as Row[])]);
      setCursor(page.nextCursor);
    } catch (err) {
      toast("error", "Couldn't load older entries", err instanceof Error ? err.message : undefined);
    } finally {
      setLoadingMore(false);
    }
  };

  const projectName = (project as { name?: string } | null | undefined)?.name;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header>
            {projectName && <p className="truncate text-[13px] text-ink-3">{projectName}</p>}
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Audit log</h1>
            <p className="mt-1 text-[15px] text-ink-2">Tool calls, approvals and configuration changes, newest first.</p>
          </header>

          <div role="tablist" aria-label="Filter" className="mt-8 flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-3 py-1 text-[12.5px] outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  filter === f.key
                    ? "border-ink bg-ink text-canvas"
                    : "border-line bg-panel text-ink-2 hover:bg-hover hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {first === undefined ? (
            <div className="mt-6 space-y-3" aria-label="Loading audit log">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <ScrollText size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">Nothing logged{filter === "all" ? " yet" : " for this filter"}.</p>
              <p className="mt-1 text-[13px] text-ink-3">Agent tool calls and settings changes show up here.</p>
            </div>
          ) : (
            <>
              <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                {rows.map((row) => {
                  const expanded = open === row._id;
                  return (
                    <li key={row._id}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : row._id)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition hover:bg-hover focus-visible:bg-hover"
                      >
                        <span
                          aria-label={row.decision}
                          title={row.decision}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[row.decision]}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px]">
                            <span className="text-ink">{actionLabel(row)}</span>
                            {row.target && <span className="text-ink-2"> · {row.target}</span>}
                          </p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {actorLabel(row)}
                            {row.projectName && !projectId ? ` · ${row.projectName}` : ""}
                            {row.decision !== "recorded" ? ` · ${row.decision}` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{when(row.createdAt)}</span>
                        <ChevronRight
                          size={14}
                          className={`shrink-0 text-ink-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                        />
                      </button>
                      {expanded && (
                        <pre className="mx-4 mb-3 max-h-72 overflow-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-2">
                          {JSON.stringify(
                            { tool: row.tool, action: row.action, decision: row.decision, actor: row.actor, target: row.target, details: row.details },
                            null,
                            2,
                          )}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
              {nextCursor !== null && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                    className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
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
      <AuditPage />
    </Suspense>
  );
}
