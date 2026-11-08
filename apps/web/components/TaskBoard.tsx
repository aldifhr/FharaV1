"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, Plus, RotateCcw, Trash2, XCircle } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";
import { roleLabel } from "@/lib/agentRoles";

type TaskRow = any;

const STATUS_PILL: Record<string, string> = {
  queued: "bg-amber-100 text-amber-700",
  running: "bg-sky-100 text-sky-700",
  needs_approval: "bg-rose-100 text-rose-700",
  done: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

const SUBTASK_STATUS: Record<string, { label: string; cls: string; icon: typeof Clock }> = {
  pending: { label: "pending", cls: "text-gray-400", icon: Clock },
  running: { label: "running", cls: "text-sky-600", icon: Loader2 },
  completed: { label: "done", cls: "text-emerald-600", icon: CheckCircle2 },
  failed: { label: "failed", cls: "text-red-600", icon: XCircle },
  blocked: { label: "blocked", cls: "text-amber-600", icon: Clock },
};

export default function TaskBoard({
  projectId,
  selectedTaskId,
  onSelectTask,
}: {
  projectId: string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  const subtasksByTask = useQuery(api.workspace.listSubtasksByProject, { projectId: projectId as any });
  const plansByTask = useQuery(api.workspace.listPlansByProject, { projectId: projectId as any });
  const projectFiles = useQuery(api.fileChanges.listByProject, { projectId: projectId as any });
  const pendingApprovals = useQuery(api.approvals.listPendingAll, {});
  const agents = useQuery(api.agents.list, {});
  const removeTask = useMutation(api.tasks.remove);
  const retryTask = useMutation(api.tasks.retry);
  const createTask = useMutation(api.tasks.createFromCommand);
  const toast = useToast();

  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const subtasksOf = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const row of subtasksByTask ?? []) map.set(row.taskId, row.subtasks);
    return map;
  }, [subtasksByTask]);

  const planOf = useMemo(() => {
    const map = new Map<string, any>();
    for (const row of plansByTask ?? []) map.set(row.taskId, row);
    return map;
  }, [plansByTask]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, any>();
    for (const a of agents ?? []) map.set(a._id, a);
    return map;
  }, [agents]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks ?? []).filter((t: TaskRow) => {
      if (filter !== "all" && t.status !== filter) return false;
      if (!q) return true;
      const plan = planOf.get(t._id);
      const subtasks = subtasksOf.get(t._id) ?? [];
      const haystack = [
        t.title,
        t.status,
        plan?.strategy ?? "",
        ...subtasks.map((s) => `${s.title} ${s.capability} ${s.assignedAgentId ? (agentNameById.get(s.assignedAgentId)?.role ?? "") : ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [tasks, filter, query, subtasksOf, planOf]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: (tasks ?? []).length };
    for (const t of tasks ?? []) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);

  const handleDelete = async (task: TaskRow) => {
    setDeletingId(task._id);
    try {
      await removeTask({ taskId: task._id });
      toast("success", "Task deleted", task.title);
    } catch (err) {
      toast("error", "Failed to delete task", err instanceof Error ? err.message : "Failed");
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreate = async () => {
    const text = manual.trim();
    if (!text) return;
    setCreating(true);
    try {
      const taskId = await createTask({ projectId: projectId as any, command: text });
      setManual("");
      onSelectTask(taskId as any);
    } catch (err) {
      toast("error", "Failed to create task", err instanceof Error ? err.message : "Failed");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks…"
          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
        >
          {["all", "queued", "running", "needs_approval", "done", "failed"].map((s) => (
            <option key={s} value={s}>
              {s === "all" ? `All (${counts.all ?? 0})` : `${s} (${counts[s] ?? 0})`}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
          placeholder="Create a task manually…"
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !manual.trim()}
          className="flex items-center gap-1 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
        >
          {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Create
        </button>
      </div>

      {visible.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-400">No tasks match.</p>
      )}

      {visible.map((t: TaskRow) => {
        const subtasks = subtasksOf.get(t._id) ?? [];
        const done = subtasks.filter((s) => s.status === "completed").length;
        const plan = planOf.get(t._id);
        const pending = (pendingApprovals ?? []).filter((a: any) => a.taskId === t._id && a.status === "pending");
        const isOpen = !!expanded[t._id] || selectedTaskId === t._id;
        const assigned = new Map<string, string>();
        for (const s of subtasks) {
          const role = agentNameById.get(s.assignedAgentId ?? "")?.role;
          if (role) assigned.set(roleLabel(role), s.assignedAgentId ?? "");
        }

        return (
          <motion.div
            key={t._id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`rounded-xl border bg-white p-3 dark:bg-gray-900 ${
              selectedTaskId === t._id ? "border-[#6252d8]/60" : "border-gray-200 dark:border-gray-800"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => onSelectTask(t._id)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium dark:text-white">{t.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_PILL[t.status] ?? "bg-gray-100 text-gray-600"}`}>{t.status}</span>
                  {subtasks.length > 0 && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 font-medium dark:bg-gray-800">
                      {done}/{subtasks.length} subtasks
                    </span>
                  )}
                  {pending.length > 0 && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700 dark:bg-rose-950">
                      {pending.length} approval
                    </span>
                  )}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex gap-1">
                  {[...assigned.entries()].slice(0, 4).map(([name, id]) => (
                    <span key={name} title={name} className="flex h-5 w-5 items-center justify-center rounded-full bg-[#eeecfb] text-[9px] font-semibold text-[#4c42a3] dark:bg-gray-800 dark:text-gray-300">
                      {name.slice(0, 2).toUpperCase()}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  // Toggle against the *current* openness (including the
                  // selection default) — toggling expanded[id] alone could
                  // never close a selected task, making the chevron dead.
                  onClick={() => setExpanded((prev) => ({ ...prev, [t._id]: !isOpen }))}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(t)}
                  disabled={t.status === "running" || deletingId === t._id}
                  title={t.status === "running" ? "Running tasks cannot be deleted" : "Delete task"}
                  className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {isOpen && (
              <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3 dark:border-gray-800">
                {plan && (
                  <p className="text-[11px] text-gray-500">
                    <span className="font-semibold text-gray-600 dark:text-gray-300">Goal:</span> {plan.goal}
                    <span className="ml-2 text-gray-400">v{plan.version} · {plan.createdBy}</span>
                  </p>
                )}
                {subtasks.length === 0 && (
                  <p className="text-xs text-gray-400">No subtasks yet.</p>
                )}
                {subtasks.map((s: any) => {
                  const meta = SUBTASK_STATUS[s.status] ?? SUBTASK_STATUS.pending;
                  const Icon = meta.icon;
                  const agent = s.assignedAgentName ? agentNameById.get(s.assignedAgentId) : null;
                  return (
                    <div key={s._id} className="flex items-center gap-2 text-xs">
                      <Icon size={13} className={meta.cls} />
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
                        {s.title}
                      </span>
                      <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800">
                        {s.capability}
                      </span>
                      {s.assignedAgentName && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-gray-500">
                          {roleLabel(agent?.role)}
                        </span>
                      )}
                      <span className={`shrink-0 text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                    </div>
                  );
                })}
                {t.errorMessage && (
                  <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-600 dark:bg-red-950/40">{t.errorMessage}</p>
                )}
              </div>
            )}
          </motion.div>
        );
      })}

    </div>
  );
}
