import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "@/lib/spaRouter";
import { useFharaRuntime, useMutation, useQuery } from "@fhara/runtime/react";
import { Activity, AlertTriangle, Cpu, Download, FileJson, FileText, GitBranch, Layers, Trash2 } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { buildRunBundleJson, buildRunBundleMarkdown, type RunExportData } from "@/lib/runExport";
import { deletableRuns, deleteAllCopy } from "@/lib/runDelete";
import { roleLabel } from "@/lib/agentRoles";
import { taskStatusLabel } from "@/lib/taskStatus";
import { formatDuration, formatTokens, relativeTime, statusDot } from "@/lib/runFormat";
import webPackage from "../../package.json";

type RunFilter = "all" | "active" | "failed" | "done";

const RUN_FILTERS: { key: RunFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "failed", label: "Failed" },
  { key: "done", label: "Done" },
];

const APP_VERSION: string | null = typeof webPackage.version === "string" ? webPackage.version : null;
const EXPORT_BATCH = 5;

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

function exportStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).split(":").join("-").replace("T", "-");
}

/**
 * Runs: every task as an execution run, newest first, across projects
 * (or one project with `?project=<id>`). A row opens its trace.
 */
function RunsPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const data = useQuery(api.runs.list, projectId ? { projectId: projectId as never, limit: 50 } : { limit: 50 });
  const removeTask = useMutation(api.tasks.remove);
  const runtime = useFharaRuntime();
  const toast = useToast();
  const [filter, setFilter] = useState<RunFilter>("all");
  const [confirm, setConfirm] = useState<(ConfirmRequest & { run: () => Promise<void> }) | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<"json" | "md" | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const runs = data?.runs;

  const stats = useMemo(() => {
    if (!runs) return { active: 0, queued: 0, failed: 0, tokens: 0 };
    let active = 0;
    let queued = 0;
    let failed = 0;
    let tokens = 0;
    for (const r of runs) {
      if (r.status === "running") active++;
      else if (r.status === "queued") queued++;
      else if (r.status === "failed") failed++;
      tokens += r.inputTokens + r.outputTokens;
    }
    return { active, queued, failed, tokens };
  }, [runs]);

  const filteredRuns = useMemo(() => {
    if (!runs) return [];
    if (filter === "active") return runs.filter((r) => r.status === "running" || r.status === "queued" || r.status === "needs_approval" || r.status === "waiting_input");
    if (filter === "failed") return runs.filter((r) => r.status === "failed" || r.status === "rejected");
    if (filter === "done") return runs.filter((r) => r.status === "done");
    return runs;
  }, [runs, filter]);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  /** Full traces for the runs currently shown, fetched in small batches. */
  const collectTraces = async (): Promise<RunExportData[]> => {
    const traces: RunExportData[] = [];
    for (let i = 0; i < filteredRuns.length; i += EXPORT_BATCH) {
      const batch = filteredRuns.slice(i, i + EXPORT_BATCH);
      const loaded = await Promise.all(
        batch.map((r) => runtime.query(api.runs.get, { taskId: r.taskId as never })),
      );
      for (const trace of loaded) if (trace) traces.push(trace);
    }
    return traces;
  };

  const exportAll = async (format: "json" | "md") => {
    setExportOpen(false);
    if (filteredRuns.length === 0) {
      toast("info", "Nothing to export", "No runs match this filter.");
      return;
    }
    setExporting(format);
    try {
      const traces = await collectTraces();
      if (traces.length === 0) throw new Error("No run traces could be loaded.");
      const exportedAt = Date.now();
      const scope = projectId ? "project" : "all-projects";
      if (format === "json") {
        downloadText(
          buildRunBundleJson(traces, { exportedAt, appVersion: APP_VERSION, projectId: projectId ?? null }),
          `runs-${scope}-${exportStamp(exportedAt)}.json`,
          "application/json;charset=utf-8",
        );
      } else {
        downloadText(
          buildRunBundleMarkdown(traces, { exportedAt, appVersion: APP_VERSION }),
          `runs-${scope}-${exportStamp(exportedAt)}.md`,
          "text/markdown;charset=utf-8",
        );
      }
      toast("success", "Export ready", `${traces.length} ${traces.length === 1 ? "run" : "runs"} downloaded.`);
    } catch (err) {
      toast("error", "Export failed", err instanceof Error ? err.message : undefined);
    } finally {
      setExporting(null);
    }
  };

  const deleteAll = () => {
    if (filteredRuns.length === 0) {
      toast("info", "Nothing to delete", "No runs match this filter.");
      return;
    }
    const targets = deletableRuns(filteredRuns);
    const skipped = filteredRuns.length - targets.length;
    if (targets.length === 0) {
      toast("info", "Nothing to delete", "Every run matching this filter is still running.");
      return;
    }
    const noun = targets.length === 1 ? "run" : "runs";
    setConfirm({
      ...deleteAllCopy(targets.length, skipped),
      run: async () => {
        setBulkDeleting(true);
        let deleted = 0;
        const failures: string[] = [];
        try {
          for (const r of targets) {
            try {
              await removeTask({ taskId: r.taskId as never });
              deleted++;
            } catch (err) {
              if (failures.length === 0) failures.push(err instanceof Error ? err.message : "Failed to delete run");
            }
          }
          setConfirm(null);
          if (failures.length > 0) {
            toast("error", "Some runs could not be deleted", `${deleted} deleted, ${failures.length} failed. ${failures[0]}`);
          } else {
            toast("success", `${noun[0].toUpperCase()}${noun.slice(1)} deleted`, `${deleted} ${noun} deleted${skipped > 0 ? `, ${skipped} running skipped` : ""}.`);
          }
        } finally {
          setBulkDeleting(false);
        }
      },
    });
  };

  const deleteRun = (taskId: string, title: string) => {
    setConfirm({
      title: `Delete run "${title}"?`,
      message: "This run and its task data will be deleted. Audit history is kept.",
      confirmLabel: "Delete run",
      run: async () => {
        setDeleting(taskId);
        try {
          await removeTask({ taskId: taskId as never });
          toast("success", "Run deleted", title);
          setConfirm(null);
        } catch (err) {
          toast("error", "Failed to delete run", err instanceof Error ? err.message : "Failed to delete run");
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1440px] min-[112.5rem]:max-w-[1640px]">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-baseline gap-3">
              <h1 className="text-[24px] font-semibold tracking-tight text-ink">Runs</h1>
              {data?.projectName && (
                <span className="truncate text-[13px] text-ink-3">{data.projectName}</span>
              )}
              {projectId && (
                <Link href="/runs" className="text-[12.5px] font-medium text-brand hover:underline">
                  All projects
                </Link>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center rounded-lg border border-line bg-hover p-0.5">
                {RUN_FILTERS.map((f) => {
                  const selected = filter === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFilter(f.key)}
                      aria-pressed={selected}
                      className={`rounded-md px-3 py-1 text-[12.5px] font-medium transition ${
                        selected ? "bg-panel text-ink shadow-card" : "text-ink-2 hover:text-ink"
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <div ref={exportRef} className="relative shrink-0">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                  disabled={exporting !== null || deleting !== null || bulkDeleting || !filteredRuns.length}
                  onClick={() => setExportOpen((o) => !o)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
                >
                  <Download size={14} />
                  {exporting ? "Exporting…" : "Export all"}
                </button>
                {exportOpen && (
                  <div role="menu" className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none" onClick={() => void exportAll("json")}>
                      <FileJson size={14} className="text-ink-3" /> Full traces (.json)
                    </button>
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none" onClick={() => void exportAll("md")}>
                      <FileText size={14} className="text-ink-3" /> Run reports (.md)
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={!filteredRuns.length || deleting !== null || bulkDeleting || exporting !== null}
                onClick={deleteAll}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-danger focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
              >
                <Trash2 size={14} />
                {bulkDeleting ? "Deleting…" : "Delete all"}
              </button>
            </div>
          </header>

          {runs === undefined ? (
            <div className="mt-6 space-y-5" aria-label="Loading runs">
              <div className="grid grid-cols-2 divide-x divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-20 rounded bg-hover" />
                    <div className="mt-3 h-8 w-14 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="h-64 rounded-2xl border border-line bg-panel shadow-card" />
            </div>
          ) : runs.length === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <GitBranch size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No runs yet.</p>
              <p className="mt-1 text-[13px] text-ink-3">Each task the team works on shows up here with its full trace.</p>
            </div>
          ) : (
            <>
              {/* KPI Strip */}
              <section
                aria-label="Run metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                <div className="p-5" title="Recent execution runs loaded">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Runs</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <Layers size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2">
                    <span className="text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">
                      {runs.length}
                    </span>
                    <span className="text-[12.5px] text-ink-3">recent</span>
                  </div>
                </div>

                <div className="p-5" title="Currently running or queued tasks">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Active</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <Activity size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2">
                    <span className={`text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${stats.active > 0 ? "text-brand" : "text-ink"}`}>
                      {stats.active}
                    </span>
                    <span className="text-[12.5px] tabular-nums text-ink-3">
                      {stats.queued > 0 ? `${stats.queued} queued` : "running"}
                    </span>
                  </div>
                </div>

                <div className="p-5" title="Failed runs in this list">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Failed</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <AlertTriangle size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2">
                    <span className={`text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${stats.failed > 0 ? "text-danger" : "text-ink"}`}>
                      {stats.failed}
                    </span>
                    <span className="text-[12.5px] text-ink-3">
                      {stats.failed > 0 ? "need review" : "none"}
                    </span>
                  </div>
                </div>

                <div className="p-5" title="Total input + output tokens across visible runs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-2">Tokens</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hover text-ink-3">
                      <Cpu size={13} />
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2">
                    <span className="text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">
                      {stats.tokens > 0 ? formatTokens(stats.tokens) : "—"}
                    </span>
                    <span className="text-[12.5px] text-ink-3">total</span>
                  </div>
                </div>
              </section>

              {/* Runs Table */}
              <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                <div className="hidden items-center gap-4 border-b border-line px-5 py-2.5 text-[12px] text-ink-3 sm:flex">
                  <span className="min-w-0 flex-1">Run</span>
                  <span className="w-24 text-right">Duration</span>
                  <span className="w-20 text-right">Tokens</span>
                  <span className="w-20 text-right">Steps</span>
                  <span className="w-20 text-right">When</span>
                  <span className="w-9" />
                </div>
                {filteredRuns.length === 0 ? (
                  <p className="px-5 py-8 text-center text-[13px] text-ink-3">No runs match this filter.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {filteredRuns.map((r) => {
                      const tokens = r.inputTokens + r.outputTokens;
                      const sub = [
                        projectId ? null : r.projectName,
                        r.roles.length ? r.roles.map(roleLabel).join(", ") : null,
                        r.errorCount ? `${r.errorCount} ${r.errorCount === 1 ? "error" : "errors"}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const pct = r.subtasksTotal ? Math.round((r.subtasksDone / r.subtasksTotal) * 100) : 0;
                      return (
                        <li key={r.taskId} className="flex items-center transition hover:bg-hover/50">
                          <Link href={`/runs/${r.taskId}`} className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3">
                            <span
                              title={taskStatusLabel(r.status)}
                              aria-label={taskStatusLabel(r.status)}
                              className={`h-2 w-2 shrink-0 rounded-full ${statusDot(r.status)}`}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[14px] font-medium text-ink">{r.title}</p>
                              <p className="truncate text-[12.5px] text-ink-3">{sub || taskStatusLabel(r.status)}</p>
                              {r.subtasksTotal > 0 && r.status === "running" && (
                                <div className="mt-1.5 h-[3px] w-40 max-w-full overflow-hidden rounded-full bg-line">
                                  <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                                </div>
                              )}
                            </div>
                            <span className="hidden w-24 shrink-0 text-right text-[12.5px] tabular-nums text-ink-2 sm:inline">
                              {r.durationMs !== null ? formatDuration(r.durationMs) : taskStatusLabel(r.status)}
                            </span>
                            <span className="hidden w-20 shrink-0 text-right text-[12.5px] tabular-nums text-ink-2 sm:inline">
                              {tokens ? `${r.tokensEstimated ? "≈" : ""}${formatTokens(tokens)}` : "—"}
                            </span>
                            <span className="hidden w-20 shrink-0 text-right text-[12.5px] tabular-nums text-ink-2 sm:inline">
                              {r.subtasksTotal ? `${r.subtasksDone}/${r.subtasksTotal}` : "—"}
                            </span>
                            <span className="w-20 shrink-0 text-right text-[12.5px] tabular-nums text-ink-3">
                              {relativeTime(r.createdAt)}
                            </span>
                          </Link>
                          <button
                            type="button"
                            aria-label={`Delete run ${r.title}`}
                            title={r.status === "running" ? "Running runs can't be deleted" : "Delete run"}
                            disabled={r.status === "running" || deleting === r.taskId || bulkDeleting}
                            onClick={() => deleteRun(r.taskId, r.title)}
                            className="mr-3 shrink-0 rounded-lg p-2 text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
                          >
                            <Trash2 size={15} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </main>
      <ConfirmDialog
        request={confirm}
        pending={deleting !== null || bulkDeleting}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirm?.run()}
      />
    </div>
  );
}

export default function RunsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <RunsPage />
    </Suspense>
  );
}
