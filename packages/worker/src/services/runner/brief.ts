import { briefAfterNode, type TaskBrief } from "@/api/convex/lib/brief";
import { roleLabel } from "@/api/convex/lib/roles";
import type { PlanSubtask } from "@/types";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { NodeOutcome } from "@/scheduler/dagScheduler";
import type { RunnerDeps } from "./types";

/**
 * Plan L3: the task brief on the worker side. Both calls are best-effort and
 * capability-checked (legacy test harnesses may not model the brief API):
 * a failed read or write never touches the run. No LLM call anywhere here.
 */

/** Refresh the brief on the shared context before a node's prompt is built. */
export async function pullTaskBrief(
  deps: RunnerDeps,
  taskId: string,
  sharedContext: SharedTaskContext
): Promise<void> {
  if (typeof deps.api.getTaskBrief !== "function") return;
  const brief = await deps.api.getTaskBrief({ taskId: taskId as never }).catch(() => undefined);
  if (brief === undefined) return;
  sharedContext.brief = (brief ?? undefined) as TaskBrief | undefined;
}

/** The next node the plan will run: lowest order, not this one, not done. */
export function nextPendingSubtask(
  subtasks: readonly PlanSubtask[],
  doneKeys: ReadonlySet<string>,
  currentKey: string
): PlanSubtask | null {
  return (
    [...subtasks]
      .filter((subtask) => subtask.key !== currentKey && !doneKeys.has(subtask.key))
      .sort((a, b) => a.order - b.order)[0] ?? null
  );
}

/**
 * Write the deterministic "latest result / next step / owner" after a node
 * settles. Never throws.
 */
export async function recordBriefAfterNode(input: {
  deps: RunnerDeps;
  taskId: string;
  subtask: PlanSubtask | undefined;
  nodeKey: string;
  role?: string;
  outcome: NodeOutcome;
  next: PlanSubtask | null;
  nextRole?: string;
  sharedContext?: SharedTaskContext;
}): Promise<void> {
  const { deps } = input;
  if (typeof deps.api.updateTaskBrief !== "function") return;
  const summary =
    input.outcome.status === "failed"
      ? input.outcome.error
      : input.outcome.status === "waiting_approval"
        ? "waiting for approval"
        : input.outcome.output;
  const patch = briefAfterNode({
    nodeKey: input.nodeKey,
    title: input.subtask?.title,
    role: input.role ? roleLabel(input.role) : undefined,
    status: input.outcome.status,
    summary: summary ? firstLine(summary) : undefined,
    next: input.next
      ? {
          key: input.next.key,
          title: input.next.title,
          ...(input.nextRole ? { role: roleLabel(input.nextRole), owner: input.nextRole } : {}),
        }
      : null,
  });
  const written = await deps.api
    .updateTaskBrief({ taskId: input.taskId as never, ...patch })
    .catch(() => undefined);
  if (written && input.sharedContext) input.sharedContext.brief = written as TaskBrief;
}

function firstLine(text: string): string {
  const line = text.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim()) ?? "";
  return line.trim();
}
