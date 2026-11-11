/**
 * Schema pieces for scheduled tasks (GOAT G7), kept out of schema.ts so that
 * file stays within its line budget. A scheduled task is the user's own
 * standing command: at each occurrence the 1-minute tick (scheduledTasks.ts)
 * creates a task or sends a message into a bound conversation, once per
 * occurrence (fire key), unless automation is held (G3).
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { permissionModeValidator } from "./permissionModes";

export const scheduleValidator = v.union(
  v.object({ type: v.literal("interval"), everyMs: v.number() }),
  v.object({
    type: v.literal("fixed_time"),
    timeOfDay: v.string(), // "HH:MM" on the zone's wall clock
    weekdays: v.optional(v.array(v.number())), // 0 = Sunday; unset/empty = every day
    timeZone: v.optional(v.string()), // IANA; unset = Asia/Jakarta
  }),
);

export const scheduledTargetValidator = v.union(
  v.object({
    kind: v.literal("task"),
    command: v.string(),
    title: v.optional(v.string()),
    permissionMode: v.optional(permissionModeValidator),
  }),
  v.object({ kind: v.literal("conversation"), conversationId: v.id("conversations"), content: v.string() }),
);

export const scheduledRunStatus = v.union(
  v.literal("dispatched"),
  v.literal("held"), // G3 automation hold: the occurrence is skipped
  v.literal("missed"), // fixed time more than 10 min late: skipped
  v.literal("failed"),
);

export const scheduledTasksTable = defineTable({
  projectId: v.id("projects"),
  name: v.string(),
  enabled: v.boolean(),
  schedule: scheduleValidator,
  target: scheduledTargetValidator,
  nextRunAt: v.optional(v.number()), // unset when disabled or no next occurrence
  lastRunAt: v.optional(v.number()),
  lastStatus: v.optional(scheduledRunStatus),
  createdBy: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_project", ["projectId"])
  .index("by_enabled_next", ["enabled", "nextRunAt"]);

/** One row per occurrence, keyed by `sched:<scheduledTaskId>:<dueAt>`. */
export const scheduledTaskRunsTable = defineTable({
  scheduledTaskId: v.id("scheduledTasks"),
  projectId: v.id("projects"),
  fireKey: v.string(),
  dueAt: v.number(),
  firedAt: v.number(),
  status: scheduledRunStatus,
  taskId: v.optional(v.id("tasks")),
  messageId: v.optional(v.id("messages")),
  error: v.optional(v.string()),
})
  .index("by_fire_key", ["fireKey"])
  .index("by_scheduled_task", ["scheduledTaskId", "dueAt"])
  .index("by_project", ["projectId"]);

export const scheduledTaskTables = {
  scheduledTasks: scheduledTasksTable,
  scheduledTaskRuns: scheduledTaskRunsTable,
};
