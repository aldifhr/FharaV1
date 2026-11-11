"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Minimize2, Square } from "lucide-react";
import { InspectorHeader } from "@/components/ui/inspector";
import { StatusTag } from "@/components/ui/status-tag";
import { EditableTitle } from "./ThreadRename";
import PauseResumeButton from "./PauseResumeButton";
import { taskStatusLabel } from "@/lib/taskStatus";
import { taskStatusTone } from "@/lib/taskStatusTone";
import { isWidePanel, toggledPanelWidth } from "@/lib/useResizablePanel";
import { PERMISSION_MODE_LABELS, normalizePermissionMode } from "@/api/convex/lib/permissionModes";
import { goalStatusLine, type DirectGoal } from "@/api/convex/lib/directGoalSchema";

const HEADER_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-field text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30";

/** The thread's status label (the tone comes from taskStatusTone). */
function statusLabel(status: string, needsYou: boolean): string {
  if (needsYou && !["done", "failed", "rejected", "cancelled"].includes(status)) return "Needs you";
  if (status === "running") return "In progress";
  if (status === "paused") return "Paused";
  if (status === "done") return "Done";
  return taskStatusLabel(status);
}

/**
 * Task thread header on the Inspector shell (dashboard F7, split out of
 * TaskThreadPanel): editable title, a meta line (project, permission mode,
 * trace link; a direct thread's goal line, D8), the status as a StatusTag, Pause/Resume + Stop while the task
 * runs, widen/narrow and close on desktop, Back on the phone sheet.
 * `task` undefined is loading, null is gone.
 */
export default function TaskThreadHeader({
  task,
  projectName,
  needsYou = false,
  fullScreen,
  width,
  onWidthChange,
  onClose,
  onStop,
}: {
  task: any;
  projectName?: string;
  needsYou?: boolean;
  fullScreen: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onStop?: () => void;
}) {
  const back = fullScreen ? (
    <button type="button" onClick={onClose} aria-label="Back to chat" className={`-ml-1 ${HEADER_BUTTON}`}>
      <ArrowLeft size={18} />
    </button>
  ) : undefined;
  const wide = isWidePanel(width);
  const widen = fullScreen ? null : (
    <button
      type="button"
      onClick={() => onWidthChange(toggledPanelWidth(width))}
      title={wide ? "Narrow the thread" : "Widen the thread"}
      aria-label={wide ? "Narrow the thread" : "Widen the thread"}
      className={HEADER_BUTTON}
    >
      {wide ? <Minimize2 size={15} /> : <ArrowUpRight size={16} />}
    </button>
  );
  const close = fullScreen ? undefined : onClose;

  if (!task) {
    return (
      <InspectorHeader
        divider
        icon={back}
        title={task === null ? "Task not found" : "Loading task…"}
        actions={widen}
        onClose={close}
        closeLabel="Close task thread"
      />
    );
  }

  const status = task.status as string;
  const running = status === "running" || status === "queued" || status === "paused";
  const goal: DirectGoal | undefined = task.mode === "direct" ? task.direct?.goal : undefined;
  return (
    <InspectorHeader
      icon={back}
      title={<EditableTitle title={task.title} renameRef={{ taskId: String(task._id) }} label="task" />}
      subtitle={
        <>
          {task.mode === "direct" ? `Direct thread${task.direct?.role ? ` (${task.direct.role})` : ""}` : "Task thread"} · {projectName ?? "Workspace"}
          {" · "}
          <span title="Permission mode">{PERMISSION_MODE_LABELS[normalizePermissionMode(task.permissionMode)]}</span>
          {" · "}
          <Link href={`/runs/${task._id}`} className="underline-offset-2 hover:text-ink hover:underline">
            View trace
          </Link>
          {goal && (
            <>
              {" · "}
              <span title={goal.objective} className={goal.phase === "blocked" ? "text-danger" : "text-ink-2"}>
                {goalStatusLine(goal)}
              </span>
            </>
          )}
        </>
      }
      status={<StatusTag tone={taskStatusTone(status, needsYou)}>{statusLabel(status, needsYou)}</StatusTag>}
      actions={
        <>
          {/* Plan 022: Pause / Resume beside Stop. Only Stop confirms. */}
          {running && (
            <>
              {task.mode !== "direct" && <PauseResumeButton task={{ _id: task._id, title: task.title, status }} size={15} />}
              <button type="button" onClick={onStop} title="Stop task" aria-label="Stop task" className={`${HEADER_BUTTON} hover:text-danger`}>
                <Square size={14} />
              </button>
            </>
          )}
          {widen}
        </>
      }
      onClose={close}
      closeLabel="Close task thread"
    />
  );
}
