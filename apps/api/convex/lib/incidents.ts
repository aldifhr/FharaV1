import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Incident Room: open one incident record when a run fails or a subtask
 * escalates / blocks. Called from inside the mutation that records the
 * failure (orchestration.completeTask, orchestration.recoverStale,
 * contracts.recordSubtaskAcceptance), so the incident exists the moment
 * the failure does. Idempotent per (task, trigger, subtask): a second call
 * while an incident is still open refreshes it instead of adding another.
 *
 * Only reads the run (events, subtasks, audit) and writes the incidents
 * row plus one taskEvent — it never changes the task itself.
 */
export type IncidentTrigger = "task_failed" | "subtask_escalated" | "subtask_blocked";

export const INCIDENT_EVENT_COUNT = 12;
export const INCIDENT_AUDIT_COUNT = 20;

/** One short line from an event: message, error, reason, or a compact payload. */
export function eventText(event: Pick<Doc<"taskEvents">, "message" | "payload">): string | undefined {
  if (event.message) return event.message.slice(0, 300);
  const p = event.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  for (const key of ["error", "reason", "summary", "instruction", "question", "stage"]) {
    const value = p[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 300);
  }
  try {
    const json = JSON.stringify(p);
    return json === "{}" ? undefined : json.slice(0, 300);
  } catch {
    return undefined;
  }
}

export async function openIncident(
  ctx: MutationCtx,
  args: {
    taskId: Id<"tasks">;
    trigger: IncidentTrigger;
    subtaskKey?: string;
    error?: string;
    escalation?: Doc<"subtasks">["escalation"];
    stage?: string;
  }
): Promise<Id<"incidents"> | null> {
  const task = await ctx.db.get(args.taskId);
  if (!task) return null;
  const now = Date.now();

  const subtasks = await ctx.db
    .query("subtasks")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .collect();
  // Failure point: the named subtask, else the first failed / blocked one.
  const point =
    (args.subtaskKey ? subtasks.find((s) => s.key === args.subtaskKey) : undefined) ??
    subtasks
      .filter((s) => s.status === "failed" || s.status === "blocked" || s.acceptanceStatus === "escalated")
      .sort((a, b) => (a.completedAt ?? a.order) - (b.completedAt ?? b.order))[0];

  const events = await ctx.db
    .query("taskEvents")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .order("desc")
    .take(INCIDENT_EVENT_COUNT);
  const lastEvents = events.reverse().map((event) => ({
    type: event.type,
    ...(event.level ? { level: event.level } : {}),
    ...(event.subtaskKey ? { subtaskKey: event.subtaskKey } : {}),
    ...(eventText(event) ? { text: eventText(event) } : {}),
    at: event.createdAt ?? event._creationTime,
  }));

  const audits = await ctx.db
    .query("audit")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .order("desc")
    .take(INCIDENT_AUDIT_COUNT);

  const escalation = args.escalation ?? point?.escalation;
  const error = (args.error ?? point?.error ?? task.errorMessage ?? point?.acceptanceReason)?.slice(0, 2_000);
  const failurePoint = point
    ? {
        subtaskKey: point.key,
        title: point.title,
        ...(point.assignedAgentName ? { role: point.assignedAgentName } : {}),
        ...(args.stage ? { stage: args.stage } : {}),
      }
    : args.stage
      ? { stage: args.stage }
      : undefined;
  const title =
    args.trigger === "task_failed"
      ? `Task failed: ${task.title}`
      : args.trigger === "subtask_escalated"
        ? `Escalated: ${point?.title ?? args.subtaskKey ?? task.title}`
        : `Blocked: ${point?.title ?? args.subtaskKey ?? task.title}`;

  const open = await ctx.db
    .query("incidents")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .collect();
  const existing = open.find(
    (row) => row.status === "open" && row.trigger === args.trigger && (row.subtaskKey ?? null) === (args.subtaskKey ?? null)
  );
  const fields = {
    title: title.slice(0, 200),
    ...(failurePoint ? { failurePoint } : {}),
    ...(error ? { error } : {}),
    lastEvents,
    ...(escalation ? { escalation } : {}),
    auditIds: audits.map((row) => row._id),
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  const incidentId = await ctx.db.insert("incidents", {
    projectId: task.projectId,
    taskId: task._id,
    trigger: args.trigger,
    status: "open",
    ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
    createdAt: now,
    ...fields,
  });
  await ctx.db.insert("taskEvents", {
    taskId: task._id,
    projectId: task.projectId,
    type: "incident.opened",
    payload: { incidentId, trigger: args.trigger, ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}) },
    ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
    level: "warn",
  });
  await ctx.db.insert("audit", {
    actor: "system",
    tool: "incident",
    action: "incident.open",
    decision: "recorded",
    target: title.slice(0, 200),
    projectId: task.projectId,
    taskId: task._id,
    details: { trigger: args.trigger, ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}) },
    createdAt: now,
  });
  return incidentId;
}
