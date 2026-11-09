"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, Loader2, Plus, Square, Trash2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";
import { roleLabel } from "@/lib/agentRoles";
import { NEUTRAL_PILL, TASK_STATUSES, TASK_STATUS_PILL, isClosedStatus, subtaskStatusMeta, taskStatusLabel } from "@/lib/taskStatus";
import { SectionLoading, useWorkspace } from "@/app/WorkspaceContext";

type TaskRow = any;

// Agile phases: derived from subtask kind + task status, never from a stale
// stored phase. Order matches the sprint flow.
const PHASES = [
  { key: "planning", label: "Planning" },
  { key: "implementation", label: "Implementation" },
  { key: "review", label: "Review" },
  { key: "verification", label: "Verification" },
  { key: "done", label: "Closed" },
] as const;

function phaseOf(t: any, subtasks: any[]): string {
  // Done, failed and rejected tasks will not progress on their own: they
  // belong in the closed lane (the pill says which), not "Implementation".
  if (isClosedStatus(t.status)) return "done";
  // A subtask is actively running right now → its phase is current.
  const running = subtasks.find((s) => s.status === "running");
  if (running) return kindToPhase(running.kind);
  // Nothing running: the earliest pending kind marks the phase.
  const earliest = subtasks.find((s) => ["pending", "ready", "waiting_approval", "blocked"].includes(s.status));
  if (earliest) return kindToPhase(earliest.kind);
  const done = subtasks.filter((s) => s.status === "completed").length;
  if (done > 0) return "implementation";
  return "planning";
}

function kindToPhase(kind: string): string {
  if (kind === "review") return "review";
  if (kind === "qa") return "verification";
  if (kind === "analysis" || kind === "research") return "planning";
  return "implementation";
}

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
  const { deleteTask } = useWorkspace();
  const createTask = useMutation(api.tasks.createFromCommand);
  const cancelTask = useMutation(api.tasks.cancel);
  const stopTask = async (t: { _id: string; title: string }) => {
    if (!window.confirm(`Stop "${t.title}"? You can delete it once it has stopped.`)) return;
    try {
      await cancelTask({ taskId: t._id as never });
      toast("success", "Task stopped");
    } catch (err) {
      toast("error", "Failed to stop task", err instanceof Error ? err.message : "Failed");
    }
  };
  const toast = useToast();

  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState("");
  const [creating, setCreating] = useState(false);

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
  }, [tasks, filter, query, subtasksOf, planOf, agentNameById]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: (tasks ?? []).length };
    for (const t of tasks ?? []) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);

  const handleCreate = async () => {
    const text = manual.trim();
    if (!text || creating) return;
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
          aria-label="Filter tasks"
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-sm"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter by status"
          className="rounded-lg border border-line bg-panel px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-sm"
        >
          {["all", ...TASK_STATUSES].map((s) => (
            <option key={s} value={s}>
              {s === "all" ? `All (${counts.all ?? 0})` : `${taskStatusLabel(s)} (${counts[s] ?? 0})`}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleCreate();
            }
          }}
          placeholder="Create a task manually…"
          aria-label="New task"
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-sm"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !manual.trim()}
          className="flex items-center gap-1 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white outline-none hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50"
        >
          {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Create
        </button>
      </div>

      {tasks === undefined ? (
        <SectionLoading />
      ) : tasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">No tasks yet. Ask the team in Chat, or create one above.</p>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">No tasks match this filter.</p>
      ) : null}

      {/* Sprint board: agile phases as swimlanes. Each task is indivisible —
          it lives in exactly one phase, derived from its subtasks. */}
      <div className="space-y-4">
        {PHASES.map((phase) => {
          const inPhase = visible
            .map((t) => ({ t, subtasks: subtasksOf.get(t._id) ?? [] }))
            .filter(({ t, subtasks }) => phaseOf(t, subtasks) === phase.key);
          if (inPhase.length === 0) return null;
          return (
            <section key={phase.key} className="space-y-2">
              <header className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
                  {phase.label}
                </h3>
                <span className="text-[11px] text-ink-3">{inPhase.length}</span>
              </header>
              {inPhase.map(({ t, subtasks }) => {
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
            layout="position"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`rounded-xl border bg-panel p-3 ${
              selectedTaskId === t._id ? "border-brand/60" : "border-line"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => onSelectTask(t._id)} className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${TASK_STATUS_PILL[t.status] ?? NEUTRAL_PILL}`}>{taskStatusLabel(t.status)}</span>
                  {subtasks.length > 0 && (
                    <span className="rounded-full bg-hover px-2 py-0.5 font-medium">
                      {done}/{subtasks.length} subtasks
                    </span>
                  )}
                  {pending.length > 0 && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                      {pending.length} approval{pending.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex gap-1">
                  {[...assigned.entries()].slice(0, 4).map(([name, id]) => (
                    <span key={name} title={name} className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-soft text-[9px] font-semibold text-brand-ink">
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
                  aria-label={isOpen ? `Collapse ${t.title}` : `Expand ${t.title}`}
                  aria-expanded={isOpen}
                  className="rounded-md p-1.5 text-ink-3 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                {t.status === "running" ? (
                <button
                  type="button"
                  onClick={() => stopTask({ _id: t._id, title: t.title })}
                  title="Stop task (delete it after it stops)"
                  aria-label={`Stop task ${t.title}`}
                  className="rounded-md p-1.5 text-ink-3 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-400/50 dark:hover:bg-red-950/50"
                >
                  <Square size={13} />
                </button>
                ) : (
                <button
                  type="button"
                  onClick={() => deleteTask({ _id: t._id, title: t.title, status: t.status })}
                  title="Delete task"
                  aria-label={`Delete task ${t.title}`}
                  className="rounded-md p-1.5 text-ink-3 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-400/50 disabled:opacity-30 dark:hover:bg-red-950/50"
                >
                  <Trash2 size={14} />
                </button>
                )}
              </div>
            </div>

            {isOpen && (
              <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                {plan && (
                  <p className="text-[11px] text-ink-3">
                    <span className="font-semibold text-ink-2">Goal:</span> {plan.goal}
                    <span className="ml-2 text-ink-3">v{plan.version} · {plan.createdBy}</span>
                  </p>
                )}
                {subtasks.length === 0 && (
                  <p className="text-xs text-ink-3">No subtasks yet.</p>
                )}
                {subtasks.map((s: any) => {
                  const meta = subtaskStatusMeta(s.status);
                  const Icon = meta.icon;
                  const agent = s.assignedAgentName ? agentNameById.get(s.assignedAgentId) : null;
                  return (
                    <div key={s._id} className="flex items-center gap-2 text-xs">
                      <Icon size={13} className={`${meta.cls}${s.status === "running" ? " animate-spin" : ""}`} />
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">
                        {s.title}
                        {s.reviewRound && s.reviewRound > 1 ? (
                          <span className="ml-1 font-normal text-ink-3">(round {s.reviewRound})</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
                        {s.capability}
                      </span>
                      {s.assignedAgentName && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-3">
                          {roleLabel(agent?.role)}
                        </span>
                      )}
                      <span className={`shrink-0 text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                    </div>
                  );
                })}
                {t.errorMessage && (
                  <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-600 dark:bg-red-950/40 dark:text-red-300">{t.errorMessage}</p>
                )}
                {/* Agile phase flow */}
                <div className="flex flex-wrap items-center gap-1 pt-2">
                  {PHASES.map((phase, i) => {
                    const current = phaseOf(t, subtasks);
                    const active = phase.key === current;
                    const passed = PHASES.findIndex((p) => p.key === current) > i;
                    return (
                      <span key={phase.key} className="flex items-center gap-1">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            active
                              ? "bg-brand text-white"
                              : passed
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                                : "bg-hover text-ink-3"
                          }`}
                        >
                          {phase.label}
                        </span>
                        {i < PHASES.length - 1 && <span aria-hidden="true" className="text-ink-2">→</span>}
                      </span>
                    );
                  })}
                  {t.sprint && <span className="ml-auto text-[10px] text-ink-3">Sprint {t.sprint}</span>}
                </div>
              </div>
            )}
          </motion.div>
        );
      })}
            </section>
          );
        })}
      </div>

    </div>
  );
}
