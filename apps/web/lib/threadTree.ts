/**
 * Sidebar Threads section (Paradev B2): pure grouping, filtering and
 * sorting over `threads.list` rows. No React, no Convex, so it is unit
 * tested in tests/unit/threadTree.test.mjs.
 *
 * The rules follow Paradev's dashboard sidebar (pattern, not copied):
 *   - Sort: newest activity first; ties by title, then id; a row without
 *     a timestamp sinks to the bottom.
 *   - Text filter: case-insensitive substring. A group whose label matches
 *     is kept whole; otherwise it is pruned to the matching rows, and a
 *     group left empty is dropped. Unlike Paradev, branch names match too,
 *     because Fhara shows them.
 *   - Fix and review-round tasks (`ownerTaskId`) sit right under their
 *     owner when the owner is in the same group, so a PR's history reads as
 *     one block.
 */

export type ThreadKind = "task" | "direct" | "conversation";
export type ThreadGroupBy = "project" | "kind" | "status";
export type ThreadFilter = "all" | "needsYou" | "unread";
export type ThreadStatusBucket = "needsYou" | "active" | "idle" | "done";

export const THREAD_GROUP_BY_OPTIONS: readonly { value: ThreadGroupBy; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "kind", label: "Kind" },
  { value: "status", label: "Status" },
];

export const THREAD_FILTER_OPTIONS: readonly { value: ThreadFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needsYou", label: "Needs you" },
  { value: "unread", label: "Unread" },
];

/** One `threads.list` row plus the project it came from. */
export type ThreadItem = {
  id: string;
  kind: ThreadKind;
  taskId: string | null;
  conversationId: string | null;
  ownerTaskId: string | null;
  title: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
  branchName: string | null;
  lastActivityAt: number;
  projectId: string;
  projectName: string;
};

/** A row as shown: `nested` when it sits under its owner task. */
export type ThreadRowView = ThreadItem & { nested: boolean };

export type ThreadGroup = {
  key: string;
  label: string;
  rows: ThreadRowView[];
  lastActivityAt: number;
};

const KIND_ORDER: readonly { key: ThreadKind; label: string }[] = [
  { key: "task", label: "Tasks" },
  { key: "direct", label: "Direct" },
  { key: "conversation", label: "Conversations" },
];

const STATUS_ORDER: readonly { key: ThreadStatusBucket; label: string }[] = [
  { key: "needsYou", label: "Needs you" },
  { key: "active", label: "Active" },
  { key: "idle", label: "Idle" },
  { key: "done", label: "Done" },
];

const ACTIVE = new Set(["running", "queued", "paused", "held"]);
const DONE = new Set(["done", "rejected", "failed", "cancelled", "closed"]);

/** Which status group a row falls in. needsYou wins over its status word. */
export function statusBucket(row: Pick<ThreadItem, "status" | "needsYou">): ThreadStatusBucket {
  if (row.needsYou) return "needsYou";
  if (ACTIVE.has(row.status)) return "active";
  if (DONE.has(row.status)) return "done";
  return "idle";
}

export function matchesThreadFilter(row: Pick<ThreadItem, "needsYou" | "unread">, filter: ThreadFilter): boolean {
  if (filter === "needsYou") return row.needsYou;
  if (filter === "unread") return row.unread;
  return true;
}

const norm = (text: string) => text.trim().toLowerCase();

/** Title or branch contains the query (case-insensitive). An empty query matches. */
export function matchesThreadQuery(row: Pick<ThreadItem, "title" | "branchName">, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return row.title.toLowerCase().includes(q) || (row.branchName ?? "").toLowerCase().includes(q);
}

const activity = (row: { lastActivityAt: number }) =>
  Number.isFinite(row.lastActivityAt) && row.lastActivityAt > 0 ? row.lastActivityAt : null;

/** Newest first; ties by title then id; rows without a timestamp last. */
export function compareThreads(a: ThreadItem, b: ThreadItem): number {
  const ta = activity(a);
  const tb = activity(b);
  if (ta === null && tb !== null) return 1;
  if (tb === null && ta !== null) return -1;
  if (ta !== null && tb !== null && ta !== tb) return tb - ta;
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sorted rows with fix tasks placed right after their owner (when the owner
 * is in the same list). Children keep their own order; an orphan stays a
 * top-level row in its sorted place.
 */
export function sortThreads(rows: readonly ThreadItem[]): ThreadRowView[] {
  const sorted = [...rows].sort(compareThreads);
  const ownerIds = new Set(sorted.map((r) => r.taskId).filter((id): id is string => !!id));
  const children = new Map<string, ThreadItem[]>();
  const top: ThreadItem[] = [];
  for (const row of sorted) {
    const owner = row.ownerTaskId;
    if (owner && owner !== row.taskId && ownerIds.has(owner)) {
      const list = children.get(owner) ?? [];
      list.push(row);
      children.set(owner, list);
    } else top.push(row);
  }
  const out: ThreadRowView[] = [];
  for (const row of top) {
    out.push({ ...row, nested: false });
    for (const child of (row.taskId && children.get(row.taskId)) || []) out.push({ ...child, nested: true });
  }
  return out;
}

const newest = (rows: readonly ThreadItem[]) => rows.reduce((max, r) => Math.max(max, activity(r) ?? 0), 0);

/** Groups for the chosen axis. Empty groups are left out. */
export function groupThreads(rows: readonly ThreadItem[], groupBy: ThreadGroupBy): ThreadGroup[] {
  if (groupBy === "kind" || groupBy === "status") {
    const order = groupBy === "kind" ? KIND_ORDER : STATUS_ORDER;
    const keyOf = (r: ThreadItem): string => (groupBy === "kind" ? r.kind : statusBucket(r));
    return order
      .map(({ key, label }) => {
        const members = rows.filter((r) => keyOf(r) === key);
        return { key: `${groupBy}:${key}`, label, rows: sortThreads(members), lastActivityAt: newest(members) };
      })
      .filter((g) => g.rows.length > 0);
  }
  const byProject = new Map<string, ThreadItem[]>();
  for (const row of rows) {
    const list = byProject.get(row.projectId) ?? [];
    list.push(row);
    byProject.set(row.projectId, list);
  }
  return [...byProject.entries()]
    .map(([projectId, members]) => ({
      key: `project:${projectId}`,
      label: members[0].projectName,
      rows: sortThreads(members),
      lastActivityAt: newest(members),
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1));
}

/**
 * Text filter over groups: a group whose label matches stays whole, other
 * groups keep only matching rows, and empty groups are dropped. A nested
 * fix task that matches keeps its row; its owner is not pulled back in.
 */
export function filterThreadGroups(groups: readonly ThreadGroup[], query: string): ThreadGroup[] {
  const q = norm(query);
  if (!q) return [...groups];
  const out: ThreadGroup[] = [];
  for (const group of groups) {
    if (group.label.toLowerCase().includes(q)) {
      out.push(group);
      continue;
    }
    const rows = group.rows.filter((r) => matchesThreadQuery(r, q));
    if (rows.length) out.push({ ...group, rows });
  }
  return out;
}

/** Status filter, then grouping and sorting, then the text filter. */
export function buildThreadTree(
  rows: readonly ThreadItem[],
  opts: { groupBy: ThreadGroupBy; filter: ThreadFilter; query: string },
): ThreadGroup[] {
  const kept = rows.filter((r) => matchesThreadFilter(r, opts.filter));
  return filterThreadGroups(groupThreads(kept, opts.groupBy), opts.query);
}

/** Row ids in screen order, skipping collapsed groups (none are collapsed while filtering). */
export function visibleThreadIds(
  groups: readonly ThreadGroup[],
  collapsed: ReadonlySet<string>,
  forceExpanded = false,
): string[] {
  return groups.flatMap((g) => (!forceExpanded && collapsed.has(g.key) ? [] : g.rows.map((r) => r.id)));
}

/**
 * The next (+1) or previous (-1) id. With no current row (or one no longer
 * shown) it starts at the first or the last; it stops at the ends.
 */
export function adjacentThreadId(ids: readonly string[], currentId: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = currentId ? ids.indexOf(currentId) : -1;
  if (at === -1) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))];
}

/** Where a row opens: tasks through `?task=`, conversations in the project chat. */
export function threadHref(row: Pick<ThreadItem, "projectId" | "taskId">): string {
  return `/chats/${row.projectId}${row.taskId ? `?task=${row.taskId}` : ""}`;
}
