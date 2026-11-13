"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";
import { TASK_STATUSES, isClosedStatus, taskStatusLabel } from "@/lib/taskStatus";
import { SectionLoading, useWorkspace } from "@/app/WorkspaceContext";
import ConfirmDialog from "./ConfirmDialog";
import { PR_LANES } from "@/api/convex/lib/prFeedback";
import BoardTaskCard from "./board/BoardTaskCard";
import { PHASES, phaseOf, type PrLaneRow } from "./board/boardModel";

type TaskRow = any;

// Post-push lanes: derived from the PR facts stored with the push
// (prFeedback.lanesByProject). A pushed task with a PR lives here instead
// of in its sprint phase.
const BOARD_GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  ...PHASES.filter((p) => p.key !== "done"),
  ...PR_LANES.map((lane) => ({ key: `pr:${lane.key}`, label: lane.label })),
  PHASES[PHASES.length - 1],
];

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
  const pendingApprovals = useQuery(api.approvals.listPendingAll, {});
  const agents = useQuery(api.agents.list, {});
  const prLanes = useQuery(api.prFeedback.lanesByProject, { projectId: projectId as any });
  const { deleteTask } = useWorkspace();
  const createTask = useMutation(api.tasks.createFromCommand);
  const cancelTask = useMutation(api.tasks.cancel);
  // Stop asks in the app's own modal (window.confirm looked like a
  // browser error: "localhost:3000 says").
  const [stopReq, setStopReq] = useState<{ _id: string; title: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopTask = (t: { _id: string; title: string }) => setStopReq(t);
  const confirmStop = async () => {
    if (!stopReq) return;
    setStopping(true);
    try {
      await cancelTask({ taskId: stopReq._id as never });
      toast("success", "Task stopped");
    } catch (err) {
      toast("error", "Failed to stop task", err instanceof Error ? err.message : "Failed");
    } finally {
      setStopping(false);
      setStopReq(null);
    }
  };
  const toast = useToast();

  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState("");
  const [creating, setCreating] = useState(false);
  // ⌘K "New task" opens this tab with ?compose=1: focus the create field.
  const compose = useSearchParams().get("compose") === "1";

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

  const prOf = useMemo(() => {
    const map = new Map<string, PrLaneRow>();
    for (const row of (prLanes ?? []) as PrLaneRow[]) map.set(row.taskId, row);
    return map;
  }, [prLanes]);

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
    <>
    <ConfirmDialog
      request={stopReq ? { title: "Stop this task?", message: `"${stopReq.title}" stops now. You can delete it once it has stopped.`, confirmLabel: "Stop task", icon: "stop" } : null}
      pending={stopping}
      onCancel={() => setStopReq(null)}
      onConfirm={() => void confirmStop()}
    />
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks…"
          aria-label="Filter tasks"
          className="min-w-0 flex-1 rounded-field border border-line bg-panel px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ink/30 sm:text-sm"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter by status"
          className="rounded-field border border-line bg-panel px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ink/30 sm:text-sm"
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
          autoFocus={compose}
          className="min-w-0 flex-1 rounded-field border border-line bg-panel px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ink/30 sm:text-sm"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !manual.trim()}
          className="flex items-center gap-1 rounded-field bg-ink px-3 py-2 text-sm font-medium text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
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
      <div className={`bg-dots space-y-4 rounded-panel border border-line p-3 ${visible.length ? "" : "hidden"}`} data-testid="task-board-canvas">
        {BOARD_GROUPS.map((phase) => {
          // A task with a PR sits in its PR lane once its own run is over.
          const groupOf = (t: TaskRow, subtasks: any[]) => {
            const pr = prOf.get(t._id);
            return pr && isClosedStatus(t.status) ? `pr:${pr.lane}` : phaseOf(t, subtasks);
          };
          const inPhase = visible
            .map((t) => ({ t, subtasks: subtasksOf.get(t._id) ?? [] }))
            .filter(({ t, subtasks }) => groupOf(t, subtasks) === phase.key);
          if (inPhase.length === 0) return null;
          return (
            <section key={phase.key} className="space-y-2">
              <header className="flex items-center gap-2 px-0.5">
                <h3 className="text-caption">{phase.label}</h3>
                <span className="font-mono text-[11px] tabular-nums text-ink-3">{inPhase.length}</span>
              </header>
              {inPhase.map(({ t, subtasks }) => (
                <BoardTaskCard
                  key={t._id}
                  task={t}
                  subtasks={subtasks}
                  plan={planOf.get(t._id)}
                  pendingCount={(pendingApprovals ?? []).filter((a: any) => a.taskId === t._id && a.status === "pending").length}
                  pr={prOf.get(t._id)}
                  laneLabel={phase.label}
                  selected={selectedTaskId === t._id}
                  // The user's own toggle wins; with none, the selected task starts open.
                  isOpen={expanded[t._id] ?? selectedTaskId === t._id}
                  agentById={agentNameById}
                  onSelect={() => onSelectTask(t._id)}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [t._id]: !(prev[t._id] ?? selectedTaskId === t._id) }))}
                  onStop={() => stopTask({ _id: t._id, title: t.title })}
                  onDelete={() => deleteTask({ _id: t._id, title: t.title, status: t.status })}
                />
              ))}
            </section>
          );
        })}
      </div>

    </div>
    </>
  );
}
