"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueries, useQuery } from "convex/react";
import { ChevronRight } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { matchesChord, useKeybindings } from "@/lib/keybindings";
import { useUiPref } from "@/lib/uiPrefs";
import {
  THREAD_FILTER_OPTIONS,
  THREAD_GROUP_BY_OPTIONS,
  adjacentThreadId,
  buildThreadTree,
  threadHref,
  visibleThreadIds,
  type ThreadFilter,
  type ThreadGroupBy,
  type ThreadItem,
  type ThreadRowView,
} from "@/lib/threadTree";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionToggle } from "./SectionToggle";
import ThreadRow from "./ThreadRow";

/** Projects whose threads are loaded (newest projects first) and rows per project. */
const MAX_PROJECTS = 20;
const PER_PROJECT = 50;
/** Rows shown per group before "N more" (all rows show while filtering). */
const SHOWN = 6;

type ProjectRow = { _id: string; name: string };
type ListRow = Omit<ThreadItem, "projectId" | "projectName">;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Threads of every visible project, flattened. `undefined` until the first load. */
function useAllThreads(): ThreadItem[] | undefined {
  const projects = useQuery(api.projects.list, {}) as ProjectRow[] | undefined;
  const shown = useMemo(() => (projects ?? []).slice(0, MAX_PROJECTS), [projects]);
  const requests = useMemo(
    () => Object.fromEntries(shown.map((p) => [p._id, { query: api.threads.list, args: { projectId: p._id, limit: PER_PROJECT } }])),
    [shown],
  );
  const results = useQueries(requests);
  return useMemo(() => {
    if (projects === undefined) return undefined;
    const rows: ThreadItem[] = [];
    for (const p of shown) {
      const list = results[p._id];
      if (!Array.isArray(list)) continue; // loading, or no access: skip that project
      for (const r of list as ListRow[]) rows.push({ ...r, id: String(r.id), projectId: p._id, projectName: p.name });
    }
    return rows;
  }, [projects, shown, results]);
}

function ThreadControls({
  groupBy,
  onGroupBy,
  filter,
  onFilter,
}: {
  groupBy: ThreadGroupBy;
  onGroupBy: (value: ThreadGroupBy) => void;
  filter: ThreadFilter;
  onFilter: (value: ThreadFilter) => void;
}) {
  const trigger = "h-7 min-w-0 flex-1 rounded-md border-line px-2 text-[12.5px] text-ink-2";
  return (
    <div className="mt-1 flex items-center gap-1.5 px-1">
      <Select value={groupBy} onValueChange={(v) => v && onGroupBy(v as ThreadGroupBy)}>
        <SelectTrigger size="sm" aria-label="Group threads by" className={trigger}>
          <SelectValue>{(v: string) => `By ${THREAD_GROUP_BY_OPTIONS.find((o) => o.value === v)?.label.toLowerCase() ?? v}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {THREAD_GROUP_BY_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filter} onValueChange={(v) => v && onFilter(v as ThreadFilter)}>
        <SelectTrigger size="sm" aria-label="Show threads" className={trigger}>
          <SelectValue>{(v: string) => THREAD_FILTER_OPTIONS.find((o) => o.value === v)?.label ?? v}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {THREAD_FILTER_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Sidebar Threads section (Paradev B2): tasks, direct threads and project
 * conversations from `threads.list`, grouped by project, kind or status
 * (saved per device), with an All / Needs you / Unread filter. The sidebar
 * search also matches titles and branches and opens every matching group.
 * Opening a row marks it seen.
 */
export default function ThreadList({
  filter: query,
  open,
  onToggle,
  onNavigate,
}: {
  filter: string;
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const bindings = useKeybindings();
  const markSeen = useMutation(api.threads.markSeen);
  const [groupBy, setGroupBy] = useUiPref("threadGroupBy");
  const [filter, setFilter] = useUiPref("threadFilter");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useAllThreads();
  const filtering = query.trim().length > 0;
  const groups = useMemo(() => buildThreadTree(rows ?? [], { groupBy, filter, query }), [rows, groupBy, filter, query]);
  const ids = useMemo(() => visibleThreadIds(groups, collapsed, filtering), [groups, collapsed, filtering]);
  const byId = useMemo(() => new Map(groups.flatMap((g) => g.rows.map((r) => [r.id, r] as const))), [groups]);

  const routeProject = pathname?.startsWith("/chats/") ? pathname.split("/")[2] : undefined;
  const routeTask = params?.get("task") ?? null;
  const currentRow = useMemo(
    () => (rows ?? []).find((r) => (routeTask ? r.taskId === routeTask : false)) ?? null,
    [rows, routeTask],
  );

  const seen = (row: Pick<ThreadItem, "taskId" | "conversationId">) => {
    const ref = row.taskId ? { taskId: row.taskId as never } : row.conversationId ? { conversationId: row.conversationId as never } : null;
    if (ref) void markSeen(ref).catch(() => undefined);
  };

  // A thread opened any other way (link, Needs you, Inbox) is seen too.
  // markSeen is idempotent, so a repeat while the first call is in flight is harmless.
  useEffect(() => {
    if (!currentRow?.unread) return;
    const ref = currentRow.taskId ? { taskId: currentRow.taskId as never } : null;
    if (ref) void markSeen(ref).catch(() => undefined);
  }, [currentRow, markSeen]);

  const openRow = (row: ThreadRowView) => {
    seen(row);
    onNavigate?.();
  };

  const go = (id: string | null, focus: boolean) => {
    const row = id ? byId.get(id) : undefined;
    if (!row) return;
    seen(row);
    router.push(threadHref(row));
    if (focus) listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(row.id)}"]`)?.focus();
  };

  // Next / previous thread from anywhere (not while typing).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const step = matchesChord(e, bindings.nextThread) ? 1 : matchesChord(e, bindings.prevThread) ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      go(adjacentThreadId(ids, currentRow?.id ?? null, step), false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Plain ↑/↓ move focus between rows while the list has focus.
  const onRowKeyDown = (e: KeyboardEvent<HTMLAnchorElement>, row: ThreadRowView) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = adjacentThreadId(ids, row.id, step);
    if (next) listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(next)}"]`)?.focus();
  };

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const total = rows?.length;
  return (
    <section aria-label="Threads">
      <SectionToggle title="Threads" count={total} open={open} onToggle={onToggle} chevron />
      {open && <ThreadControls groupBy={groupBy} onGroupBy={setGroupBy} filter={filter} onFilter={setFilter} />}
      {open && rows === undefined && <p className="px-2 pt-1.5 text-[13px] text-ink-3">Loading threads…</p>}
      {open && rows !== undefined && groups.length === 0 && (
        <p className="px-2 pt-1.5 text-[13px] text-ink-3">
          {filtering || filter !== "all" ? "No threads match." : "No threads yet."}
        </p>
      )}
      {open && groups.length > 0 && (
        <div ref={listRef} className="mt-1 space-y-1.5">
          {groups.map((g) => {
            const isOpen = filtering || !collapsed.has(g.key);
            const all = filtering || expanded.has(g.key);
            const shown = all ? g.rows : g.rows.slice(0, SHOWN);
            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={() => setCollapsed((s) => toggle(s, g.key))}
                  aria-expanded={isOpen}
                  className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <ChevronRight size={12} aria-hidden="true" className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  <span className="tabular-nums">{g.rows.length}</span>
                </button>
                {isOpen && (
                  <ul className="space-y-px">
                    {shown.map((r) => (
                      <ThreadRow
                        key={r.id}
                        row={r}
                        current={currentRow ? currentRow.id === r.id : !routeTask && r.kind === "conversation" && r.projectId === routeProject}
                        showProject={groupBy !== "project"}
                        onOpen={openRow}
                        onRowKeyDown={onRowKeyDown}
                      />
                    ))}
                  </ul>
                )}
                {isOpen && !filtering && g.rows.length > SHOWN && (
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => toggle(s, g.key))}
                    className="flex w-full items-center rounded-lg px-2 py-1 text-left text-[13px] text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    {all ? "Show less" : `${g.rows.length - SHOWN} more`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
