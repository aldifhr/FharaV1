"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { holdNoticeText } from "@/api/convex/lib/providerHold";
import { roleLabel } from "@/lib/agentRoles";
import { taskStatusLabel } from "@/lib/taskStatus";
import { taskRef, type DockTaskRow } from "@/lib/taskDock";

type DockTask = DockTaskRow & {
  pausedBy?: string;
  assignedAgentIds?: string[];
  hold?: { kind: "offline" | "rate_limit" | "quota" | "auth" | "repo"; reason: string; resumeAt: number };
};

/**
 * This chat's open tasks as a compact list docked on top of the composer:
 * ref, title, and on the right who has it (or the provider hold it waits
 * on). A row opens its task; the chevron folds the list to one line.
 * ChatComposer frames it together with the input. Theme tokens only.
 */
export default function TaskDock({
  tasks,
  agents,
  onOpenTask,
}: {
  /** Already filtered and ordered (lib/taskDock `dockTasks`). */
  tasks: DockTask[];
  agents: Array<{ _id: string; role: string }>;
  onOpenTask: (taskId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anyHeld = tasks.some((t) => t.hold);
  useEffect(() => {
    if (!anyHeld) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [anyHeld]);
  if (tasks.length === 0) return null;

  const owner = (task: DockTask) => {
    const roles = (task.assignedAgentIds ?? [])
      .map((id) => agents.find((a) => a._id === id)?.role)
      .filter((role): role is string => Boolean(role))
      .map((role) => roleLabel(role));
    if (roles.length === 0) return taskStatusLabel(task.status, task as never);
    return roles.length > 2 ? `${roles.slice(0, 2).join(", ")} +${roles.length - 2}` : roles.join(", ");
  };
  const toggle = (
    <button
      type="button"
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Show tasks" : "Hide tasks"}
      className="flex h-6 w-full items-center justify-center gap-1.5 rounded-lg text-[12.5px] text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      {collapsed ? (
        <>
          {tasks.length} open task{tasks.length === 1 ? "" : "s"}
          <ChevronUp size={14} aria-hidden="true" />
        </>
      ) : (
        <ChevronDown size={14} aria-hidden="true" />
      )}
    </button>
  );

  return (
    <section aria-label="Open tasks" className="pb-1" data-testid="chat-task-dock">
      {!collapsed && (
        <ul className="max-h-[11.5rem] overflow-y-auto">
          {tasks.map((task) => (
            <li key={task._id}>
              <button
                type="button"
                onClick={() => onOpenTask(task._id)}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13.5px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <GripVertical size={13} aria-hidden="true" className="shrink-0 text-ink-3" />
                <span className="shrink-0 font-mono text-[12.5px] font-medium text-ink">{taskRef(task._id)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{task.title}</span>
                {task.hold && task.status === "paused" && task.pausedBy === "held" ? (
                  <span className="max-w-[45%] shrink-0 truncate text-[12.5px] text-ink-3" data-testid="chat-hold-line">
                    {holdNoticeText(task.hold, now)}
                  </span>
                ) : (
                  <span className="max-w-[40%] shrink-0 truncate text-[12.5px] text-ink-3">{owner(task)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {toggle}
    </section>
  );
}
