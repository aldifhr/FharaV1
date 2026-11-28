
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "@/lib/spaRouter";
import { useFharaRuntime, useMutation, useQuery } from "@fhara/runtime/react";
import { Ban, ChevronRight, Download, Layers, ScrollText, ShieldAlert, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import { HEADER_ACTION, PageHeader } from "@/components/ui/page-header";
import Segmented from "@/components/ui/segmented";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { roleLabel } from "@/lib/agentRoles";
import { clockTime, isSameDay, shortDate } from "@/lib/format";
import { useToast } from "@/components/Toasts";

type Filter = "all" | "config" | "tools" | "denied";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "config", label: "Config" },
  { key: "tools", label: "Tools" },
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
  /** O5 hash chain (null on rows written before it). */
  seq?: number | null;
  hash?: string | null;
};

const PAGE = 50;

const DECISION_TONE: Record<Row["decision"], StatusTone> = {
  allowed: "ok",
  denied: "danger",
  pending: "warn",
  recorded: "neutral",
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
    let spaced = "";
    for (let i = 0; i < row.action.length; i++) {
      const char = row.action[i];
      const prev = row.action[i - 1];
      if (char === "." || char === "_") {
        spaced += " ";
        continue;
      }
      if (i > 0 && char >= "A" && char <= "Z" && prev >= "a" && prev <= "z") spaced += " ";
      spaced += char;
    }
    const text = spaced.toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return `${row.tool} · ${row.action}`;
}

function actorLabel(row: Row): string {
  return row.actorRole ? roleLabel(row.actorRole) : row.actor;
}

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

const CSV_COLUMNS: { key: keyof Row; label: string }[] = [
  { key: "createdAt", label: "createdAt" },
  { key: "actor", label: "actor" },
  { key: "actorRole", label: "actorRole" },
  { key: "tool", label: "tool" },
  { key: "action", label: "action" },
  { key: "decision", label: "decision" },
  { key: "target", label: "target" },
  { key: "projectName", label: "project" },
  { key: "details", label: "details" },
];

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.split('"').join('""')}"`;
}

function toCsv(rows: Row[]): string {
  const header = CSV_COLUMNS.map((c) => c.label).join(",");
  const body = rows.map((row) =>
    CSV_COLUMNS.map((c) => csvCell(row[c.key])).join(","),
  );
  return [header, ...body].join("\r\n");
}

function exportStamp(): string {
  return new Date().toISOString().slice(0, 19).split(":").join("-").replace("T", "-");
}

function AuditPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [older, setOlder] = useState<Row[]>([]);
  // undefined until the first "Load more"; then the cursor that page returned.
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);
  const runtime = useFharaRuntime();
  const remove = useMutation(api.auditLog.remove);
  const removeMany = useMutation(api.auditLog.removeMany);
  const toast = useToast();

  const base = { ...(projectId ? { projectId: projectId as never } : {}), ...filterArgs(filter) };
  // The first page is live; older pages are fetched once on "Load more".
  const first = useQuery(api.auditLog.list, { ...base, limit: PAGE });
  const project = useQuery(api.projects.get, projectId ? { projectId } : "skip");
  // O5: hash-chain check of the audit log (global, newest rows).
  const chain = useQuery(api.auditLog.verifyChain, {});

  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
  }, [filter, projectId]);

  const nextCursor = cursor !== undefined ? cursor : (first?.nextCursor ?? null);
  const firstIds = new Set<string>((first?.items ?? []).map((r) => r._id as string));
  const rows: Row[] = [...((first?.items ?? []) as Row[]), ...older.filter((r) => !firstIds.has(r._id))].filter(
    (r) => !removedIds.has(r._id),
  );
  const stats = useMemo(
    () => ({
      shown: rows.length,
      allowed: rows.filter((r) => r.decision === "allowed").length,
      denied: rows.filter((r) => r.decision === "denied").length,
      pending: rows.filter((r) => r.decision === "pending").length,
    }),
    [rows],
  );

  const loadMore = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await runtime.query(api.auditLog.list, { ...base, limit: PAGE, cursor: nextCursor });
      setOlder((prev) => [...prev, ...(page.items as Row[])]);
      setCursor(page.nextCursor);
    } catch (err) {
      toast("error", "Couldn't load older entries", err instanceof Error ? err.message : undefined);
    } finally {
      setLoadingMore(false);
    }
  };

  const projectName = (project as { name?: string } | null | undefined)?.name;

  /** Page through every row that matches the current filter (bounded). */
  const collectAll = async (): Promise<Row[]> => {
    const collected: Row[] = [];
    let pageCursor: number | null = null;
    for (let page = 0; page < 40; page++) {
      const result: { items: Row[]; nextCursor: number | null } = await runtime.query(
        api.auditLog.list,
        pageCursor === null
          ? { ...base, limit: 100 }
          : { ...base, limit: 100, cursor: pageCursor },
      );
      collected.push(...result.items);
      if (result.nextCursor === null) break;
      pageCursor = result.nextCursor;
    }
    return collected;
  };

  const exportRows = async (format: "json" | "csv") => {
    setExporting(format);
    try {
      const data = await collectAll();
      if (data.length === 0) {
        toast("info", "Nothing to export", "No entries match this filter.");
        return;
      }
      const stamp = exportStamp();
      if (format === "json") {
        downloadText(JSON.stringify(data, null, 2), `audit-log-${stamp}.json`, "application/json");
      } else {
        downloadText(toCsv(data), `audit-log-${stamp}.csv`, "text/csv;charset=utf-8");
      }
      toast("success", "Export ready", `${data.length} ${data.length === 1 ? "entry" : "entries"} downloaded.`);
    } catch (err) {
      toast("error", "Export failed", err instanceof Error ? err.message : undefined);
    } finally {
      setExporting(null);
    }
  };

  const runDelete = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      if (ids.length === 1) {
        await remove({ id: ids[0] as never });
      } else {
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          await removeMany({ ids: chunk.map((id) => id as never) });
        }
      }
      setRemovedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      setOlder((prev) => prev.filter((r) => !ids.includes(r._id)));
      setOpen(null);
      toast("success", ids.length === 1 ? "Entry deleted" : `${ids.length} entries deleted`);
    } catch (err) {
      toast("error", "Couldn't delete", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      setConfirmReq(null);
    }
  };

  const askDelete = (row: Row) =>
    setConfirmReq({
      title: "Delete audit entry?",
      message: `${actionLabel(row)}${row.target ? ` · ${row.target}` : ""} from ${when(row.createdAt)}. This cannot be undone.`,
      confirmLabel: "Delete",
      onOk: () => void runDelete([row._id]),
    });

  const askDeleteShown = () =>
    setConfirmReq({
      title: `Delete ${rows.length} ${rows.length === 1 ? "entry" : "entries"}?`,
      message: "Every entry currently shown for this filter is removed. This cannot be undone.",
      confirmLabel: "Delete shown",
      onOk: () => void runDelete(rows.map((r) => r._id)),
    });

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1440px] min-[112.5rem]:max-w-[1640px]">
          <PageHeader
            eyebrow={projectName ?? "All projects"}
            title="Audit log"
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
                <ScrollText size={17} />
              </span>
            }
            status={chain ? (chain.ok ? { tone: "ok", label: "Chain intact" } : { tone: "danger", label: "Chain broken" }) : null}
            meta={
              <>
                <p className="text-[13.5px] text-ink-2">Tool calls, approvals and configuration changes, newest first.</p>
                {chain && (
                  <p
                    data-testid="audit-chain"
                    title={
                      chain.ok
                        ? `${chain.checked} chained ${chain.checked === 1 ? "entry" : "entries"} verified${chain.preChain ? `, ${chain.preChain} pre-chain` : ""}${chain.truncated ? " (newest only)" : ""}`
                        : chain.reason
                    }
                    className={`mt-1 inline-flex items-center gap-1.5 text-[12.5px] ${chain.ok ? "text-ink-3" : "text-danger"}`}
                  >
                    {chain.ok ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
                    {chain.ok
                      ? `Chain intact · ${chain.checked} verified${chain.preChain ? ` · ${chain.preChain} pre-chain` : ""}${chain.truncated ? " · newest only" : ""}`
                      : `Chain broken at entry ${chain.brokenAt}: ${chain.reason}`}
                  </p>
                )}
              </>
            }
            actions={
              <>
                <button type="button" disabled={exporting !== null} onClick={() => void exportRows("json")} className={HEADER_ACTION}>
                  <Download size={14} />
                  {exporting === "json" ? "Exporting…" : "Export JSON"}
                </button>
                <button type="button" disabled={exporting !== null} onClick={() => void exportRows("csv")} className={HEADER_ACTION}>
                  <Download size={14} />
                  {exporting === "csv" ? "Exporting…" : "Export CSV"}
                </button>
                <button
                  type="button"
                  disabled={rows.length === 0 || busy}
                  onClick={askDeleteShown}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field border border-line bg-panel px-2.5 text-[12.5px] text-ink-3 outline-none transition hover:border-danger/40 hover:bg-danger/5 hover:text-danger focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
                >
                  <Trash2 size={14} />
                  Delete shown
                </button>
              </>
            }
          />

          {first === undefined ? (
            <div className="mt-6 space-y-4" aria-label="Loading audit log">
              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-16 rounded bg-hover" />
                    <div className="mt-3 h-8 w-12 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="h-64 rounded-2xl border border-line bg-panel shadow-card" />
            </div>
          ) : (
            <>
              <section
                aria-label="Audit metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                {[
                  { label: "Shown", value: stats.shown, note: "entries loaded", icon: <Layers size={13} />, tone: "", title: "Entries currently loaded for this filter" },
                  { label: "Allowed", value: stats.allowed, note: "approved", icon: <ShieldCheck size={13} />, tone: "", title: "Allowed decisions among loaded entries" },
                  { label: "Denied", value: stats.denied, note: "blocked", icon: <Ban size={13} />, tone: stats.denied > 0 ? "text-danger" : "", title: "Denied decisions among loaded entries" },
                  { label: "Pending", value: stats.pending, note: "awaiting approval", icon: <Wrench size={13} />, tone: stats.pending > 0 ? "text-warn" : "", title: "Pending decisions among loaded entries" },
                ].map((metric) => (
                  <div key={metric.label} className="p-4 sm:p-5" title={metric.title}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption">{metric.label}</span>
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-inset text-ink-3">{metric.icon}</span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className={`text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${metric.tone || "text-ink"}`}>
                        {metric.value}
                      </span>
                      <span className="truncate text-[12px] text-ink-3">{metric.note}</span>
                    </div>
                  </div>
                ))}
              </section>

              <div className="mt-5">
                <Segmented
                  label="Filter audit log"
                  value={filter}
                  onChange={setFilter}
                  options={FILTERS.map((f) => ({ value: f.key, label: f.label }))}
                />
              </div>

              {rows.length === 0 ? (
                <div className="mt-4 flex flex-col items-center rounded-2xl border border-dashed border-line bg-panel px-5 py-10 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-inset text-ink-3">
                    <ScrollText size={18} />
                  </span>
                  <p className="mt-4 text-[14px] text-ink-2">Nothing logged{filter === "all" ? " yet" : " for this filter"}.</p>
                  <p className="mt-1 text-[13px] text-ink-3">Agent tool calls and settings changes show up here.</p>
                </div>
              ) : (
                <>
                  <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                    <div className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption sm:flex">
                      <span className="min-w-0 flex-1">Entry</span>
                      <span className="hidden w-28 shrink-0 lg:block">Project</span>
                      <span className="w-24 shrink-0">Decision</span>
                      <span className="w-16 shrink-0 text-right">When</span>
                      <span className="w-6 shrink-0" />
                      <span className="w-8 shrink-0" />
                    </div>
                    <ul className="divide-y divide-line">
                      {rows.map((row) => {
                        const expanded = open === row._id;
                        return (
                          <li key={row._id} className="transition-colors hover:bg-inset/60">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                              <button
                                type="button"
                                onClick={() => setOpen(expanded ? null : row._id)}
                                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-field text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:basis-full"
                              >
                                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset text-ink-3">
                                  <Wrench size={13} />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13.5px] font-medium text-ink">{actionLabel(row)}</span>
                                  {row.target && <span className="mt-0.5 block truncate text-[12px] text-ink-3">{row.target}</span>}
                                  <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">
                                    {actorLabel(row)}
                                    {row.projectName && !projectId ? ` · ${row.projectName}` : ""}
                                  </span>
                                </span>
                              </button>
                              <div className="flex shrink-0 items-center gap-3 max-sm:ml-9">
                                <span className="hidden w-28 shrink-0 truncate text-[12px] text-ink-3 lg:block">
                                  {row.projectName ?? "—"}
                                </span>
                                <div className="w-24 shrink-0">
                                  <StatusTag tone={DECISION_TONE[row.decision]}>
                                    {row.decision.charAt(0).toUpperCase() + row.decision.slice(1)}
                                  </StatusTag>
                                </div>
                                <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-ink-3">{when(row.createdAt)}</span>
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={`Details for ${actionLabel(row)}`}
                                  onClick={() => setOpen(expanded ? null : row._id)}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-field text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                                >
                                  <ChevronRight size={14} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => askDelete(row)}
                                  aria-label={`Delete ${actionLabel(row)}`}
                                  title="Delete entry"
                                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-field text-ink-3 outline-none transition hover:bg-hover hover:text-danger focus-visible:ring-2 focus-visible:ring-ink/30"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                            {expanded && (
                              <pre className="mx-4 mb-3 max-h-72 overflow-auto rounded-field border border-line bg-inset px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-2">
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
                  </section>
                  <p className="mt-2 text-[12px] text-ink-3">Showing {rows.length} entries for this filter.</p>
                  {nextCursor !== null && (
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() => void loadMore()}
                        className={HEADER_ACTION}
                      >
                        {loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
      <ConfirmDialog
        request={confirmReq}
        pending={busy}
        onCancel={() => setConfirmReq(null)}
        onConfirm={() => confirmReq?.onOk()}
      />
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
