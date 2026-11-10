"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConvex, useMutation, useQuery } from "convex/react";
import { ChevronRight, Download, ScrollText, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
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
  /** O5 hash chain (null on rows written before it). */
  seq?: number | null;
  hash?: string | null;
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
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: Row[]): string {
  const header = CSV_COLUMNS.map((c) => c.label).join(",");
  const body = rows.map((row) =>
    CSV_COLUMNS.map((c) => csvCell(row[c.key])).join(","),
  );
  return [header, ...body].join("\r\n");
}

function exportStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
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
  const convex = useConvex();
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

  /** Page through every row that matches the current filter (bounded). */
  const collectAll = async (): Promise<Row[]> => {
    const collected: Row[] = [];
    let pageCursor: number | null = null;
    for (let page = 0; page < 40; page++) {
      const result: { items: Row[]; nextCursor: number | null } = await convex.query(
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
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              {projectName && <p className="truncate text-[13px] text-ink-3">{projectName}</p>}
              <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Audit log</h1>
              <p className="mt-1 text-[15px] text-ink-2">Tool calls, approvals and configuration changes, newest first.</p>
              {chain && (
                <p
                  data-testid="audit-chain"
                  title={
                    chain.ok
                      ? `${chain.checked} chained ${chain.checked === 1 ? "entry" : "entries"} verified${chain.preChain ? `, ${chain.preChain} pre-chain` : ""}${chain.truncated ? " (newest only)" : ""}`
                      : chain.reason
                  }
                  className={`mt-2 inline-flex items-center gap-1.5 text-[12.5px] ${chain.ok ? "text-ink-3" : "text-destructive"}`}
                >
                  {chain.ok ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
                  {chain.ok
                    ? `Chain intact · ${chain.checked} verified${chain.preChain ? ` · ${chain.preChain} pre-chain` : ""}`
                    : `Chain broken at entry ${chain.brokenAt}: ${chain.reason}`}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={exporting !== null}
                onClick={() => void exportRows("json")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
              >
                <Download size={14} />
                {exporting === "json" ? "Exporting…" : "Export JSON"}
              </button>
              <button
                type="button"
                disabled={exporting !== null}
                onClick={() => void exportRows("csv")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
              >
                <Download size={14} />
                {exporting === "csv" ? "Exporting…" : "Export CSV"}
              </button>
              <button
                type="button"
                disabled={rows.length === 0 || busy}
                onClick={askDeleteShown}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12.5px] text-ink-3 outline-none transition hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
              >
                <Trash2 size={14} />
                Delete shown
              </button>
            </div>
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
                      <div className="flex items-center gap-2 px-4 py-2.5 transition hover:bg-hover">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : row._id)}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
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
                        <button
                          type="button"
                          onClick={() => askDelete(row)}
                          aria-label={`Delete ${actionLabel(row)}`}
                          title="Delete entry"
                          className="shrink-0 rounded-lg p-1.5 text-ink-3 outline-none transition hover:bg-hover hover:text-destructive focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
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
