"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { ChevronRight } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { matchesChord, useKeybindings } from "@/lib/keybindings";
import { adjacentThreadId, buildThreadTree, threadHref, visibleThreadIds, type ThreadItem, type ThreadRowView } from "@/lib/threadTree";
import { isRenameKey, renameRefOf } from "@/lib/threadRename";
import { RenameInput, useRenameThread } from "../ThreadRename";
import { useOptionalWorkspace } from "@/app/WorkspaceContext";
import { requestThread } from "@/lib/pendingThread";
import ConfirmDialog, { type ConfirmRequest } from "../ConfirmDialog";
import { useToast } from "../Toasts";
import { SectionToggle } from "./SectionToggle";
import ThreadRow from "./ThreadRow";
import { useAllThreads } from "./useAllThreads";

/** Rows shown per group before "N more" (all rows show while filtering). */
const SHOWN = 6;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Sidebar Threads section (Paradev B2): tasks and project
 * conversations from `threads.list`, grouped by project. The sidebar search
 * also matches titles and branches and opens every matching group.
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
  const workspace = useOptionalWorkspace();
  const bindings = useKeybindings();
  const markSeen = useMutation(api.threads.markSeen);
  const removeTask = useMutation(api.tasks.remove);
  const removeConversation = useMutation(api.conversations.remove);
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ request: ConfirmRequest; row: ThreadRowView } | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const rename = useRenameThread();
  const [renaming, setRenaming] = useState<string | null>(null);

  const rows = useAllThreads();
  const filtering = query.trim().length > 0;
  const groups = useMemo(() => buildThreadTree(rows ?? [], { groupBy: "project", filter: "all", query }), [rows, query]);
  const ids = useMemo(() => visibleThreadIds(groups, collapsed, filtering), [groups, collapsed, filtering]);
  const byId = useMemo(() => new Map(groups.flatMap((g) => g.rows.map((r) => [r.id, r] as const))), [groups]);

  const routeProject = workspace?.projectId ?? (pathname?.startsWith("/project/") ? pathname.split("/")[2] : undefined);
  const routeTask = workspace?.selectedTaskId ?? params?.get("task") ?? null;
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

  // In the thread's own project the shell selects it in place; from another
  // page the row hands the thread to the shell through `requestThread` and
  // the link navigates to `/project/:projectId`. Returns true when handled.
  const openThread = (row: ThreadRowView): boolean => {
    if (!row.taskId) return false;
    if (workspace?.projectId === row.projectId) {
      workspace.selectTask(row.taskId);
      return true;
    }
    requestThread(row.projectId, row.taskId);
    return false;
  };

  const openRow = (row: ThreadRowView): boolean => {
    seen(row);
    onNavigate?.();
    return openThread(row);
  };

  const go = (id: string | null, focus: boolean) => {
    const row = id ? byId.get(id) : undefined;
    if (!row) return;
    seen(row);
    if (!openThread(row)) router.push(threadHref(row));
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

  const focusRow = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`)?.focus();
  const isCurrent = (r: ThreadRowView) =>
    currentRow ? currentRow.id === r.id : !routeTask && r.kind === "conversation" && r.projectId === routeProject;
  const startRename = (row: ThreadRowView) => {
    if (renameRefOf(row)) setRenaming(row.id);
  };

  // Delete is confirmed first: a task takes its whole history with it, a
  // conversation its messages. Personal chats have their own page.
  const askDelete = (row: ThreadRowView) => {
    const what = row.kind === "conversation" ? "chat" : "task";
    const message =
      row.kind === "conversation"
        ? "This conversation and all of its messages are deleted permanently. Tasks it started stay on the project board."
        : "This thread and all of its history are deleted permanently.";
    setConfirm({
      row,
      request: {
        title: `Delete this ${what}?`,
        message,
        confirmLabel: `Delete ${what}`,
        icon: "trash",
      },
    });
  };

  const confirmDelete = async () => {
    if (!confirm) return;
    const { row } = confirm;
    setConfirmPending(true);
    try {
      if (row.conversationId) {
        await removeConversation({ conversationId: row.conversationId as never });
      } else if (row.taskId) {
        await removeTask({ taskId: row.taskId as never });
        if (workspace?.selectedTaskId === row.taskId) workspace.closeThread();
      }
      toast("success", "Thread deleted", row.title);
      setConfirm(null);
    } catch (err) {
      toast("error", "Couldn't delete the thread", err instanceof Error ? err.message : undefined);
    } finally {
      setConfirmPending(false);
    }
  };

  // Plain ↑/↓ move focus between rows while the list has focus. F2 (or Enter
  // on the open thread) renames the focused row in place.
  const onRowKeyDown = (e: KeyboardEvent<HTMLAnchorElement>, row: ThreadRowView) => {
    if (isRenameKey(e, isCurrent(row)) && renameRefOf(row)) {
      e.preventDefault();
      startRename(row);
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = adjacentThreadId(ids, row.id, step);
    if (next) focusRow(next);
  };

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const view = (row: ThreadRowView, branch: "├" | "└" | undefined, labelPrefix?: string) => (
    <ThreadRow
      key={row.id}
      row={row}
      current={isCurrent(row)}
      branch={branch}
      labelPrefix={labelPrefix}
      onOpen={openRow}
      onDelete={askDelete}
      onRowKeyDown={onRowKeyDown}
      onTitleDoubleClick={startRename}
      titleSlot={
        renaming === row.id && renameRefOf(row) ? (
          <RenameInput
            value={row.title}
            label="Rename thread"
            onSave={(title) => rename(renameRefOf(row)!, title)}
            onDone={() => {
              setRenaming(null);
              requestAnimationFrame(() => focusRow(row.id));
            }}
            className="h-6 text-[14px]"
          />
        ) : undefined
      }
    />
  );

  const total = rows?.length;
  return (
    <>
      <section aria-label="Threads">
        <SectionToggle title="Threads" count={total} open={open} onToggle={onToggle} chevron />
        {open && rows === undefined && <p className="px-2 pt-1.5 text-[13px] text-ink-3">Loading threads…</p>}
        {open && rows !== undefined && groups.length === 0 && (
          <p className="px-2 pt-1.5 text-[13px] text-ink-3">
            {filtering ? "No threads match." : "No threads yet."}
          </p>
        )}
        {open && groups.length > 0 && (
          <div ref={listRef} className="mt-1 space-y-1.5">
            {groups.map((g) => {
              const isOpen = filtering || !collapsed.has(g.key);
              const all = filtering || expanded.has(g.key);
              const shown = all ? g.rows : g.rows.slice(0, SHOWN);
              const projectGroup = g.key.startsWith("project:");
              return (
                <div key={g.key}>
                  <div className="group/head flex items-center">
                    <button
                      type="button"
                      onClick={() => setCollapsed((s) => toggle(s, g.key))}
                      aria-expanded={isOpen}
                      className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                    >
                      <ChevronRight size={12} aria-hidden="true" className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      <span className="min-w-0 flex-1 truncate">{projectGroup ? `Project: ${g.label}` : g.label}</span>
                      <span className="tabular-nums">{g.rows.length}</span>
                    </button>
                  </div>
                  {isOpen && (
                    // Project groups split the rows by kind: the project chat
                    // (conversation) and its task threads.
                    <div className="mt-0.5 space-y-1.5">
                      {projectGroup ? (
                        (["conversation", "task"] as const).map((kind) => {
                          const rows = shown.filter((r) => r.kind === kind);
                          if (rows.length === 0) return null;
                          const label = kind === "conversation" ? "Project chat" : "Tasks";
                          return (
                            <div key={kind}>
                              <p className="px-2 pt-0.5 text-[11.5px] font-medium text-ink-3">{label}</p>
                              <ul className="space-y-px">
                                {rows.map((r, index) => view(r, index === rows.length - 1 ? "└" : "├", kind !== "conversation" ? "Thread: " : undefined))}
                              </ul>
                            </div>
                          );
                        })
                      ) : (
                        <ul className="space-y-px">
                          {shown.map((r) => view(r, undefined, undefined))}
                        </ul>
                      )}
                    </div>
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
      <ConfirmDialog
        request={confirm?.request ?? null}
        pending={confirmPending}
        onCancel={() => (confirmPending ? undefined : setConfirm(null))}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
