"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { Square } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { TASK_STOP_CONFIRM, guardStop, isTaskStoppable, stopLabel } from "@/lib/stopControl";

/**
 * Stop for a running task (task inspector header, run page header): asks
 * in the app's ConfirmDialog (stopping loses work in progress), then
 * tasks.cancel. The worker sees the cancelled row within a couple of seconds
 * and aborts the run (planner, DAG, executors, LLM calls). Plain button with
 * a square icon; "Stopping…" and disabled while the stop is on its way, so a
 * second press does nothing. Renders nothing once the task cannot be stopped.
 */
export default function TaskStopButton({
  task,
  className = "",
}: {
  task: { _id: string; status?: string; mode?: string | null } | null | undefined;
  className?: string;
}) {
  const cancel = useMutation(api.tasks.cancel);
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stop = useMemo(() => guardStop((taskId: string) => cancel({ taskId: taskId as any }), setStopping), [cancel]);
  if (!task || !isTaskStoppable(task)) return null;
  const confirmStop = () => {
    void stop(String(task._id))
      .catch((err) => toast("error", "Couldn't stop the task", err instanceof Error ? err.message : undefined))
      .finally(() => setAsking(false));
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        disabled={stopping}
        aria-label={stopping ? "Stopping the task" : "Stop task"}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-field border border-line px-2.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        <Square size={12} className="fill-current" aria-hidden />
        {stopLabel(stopping)}
      </button>
      <ConfirmDialog
        request={asking ? TASK_STOP_CONFIRM : null}
        pending={stopping}
        onCancel={() => setAsking(false)}
        onConfirm={confirmStop}
      />
    </>
  );
}
