/**
 * Scheduled tasks: the clock (GOAT G7, idea #3a).
 *
 * A scheduled task is the user's own standing command, so firing it is not
 * automation starting work on its own: at each occurrence it creates a task
 * (like the composer would) or sends its message into a bound conversation.
 * Chat itself still never starts a task; only this explicit schedule does.
 *
 * - `tick` runs from the 1-minute cron (cronJobs.runScheduledTasks) and fires
 *   every enabled row whose `nextRunAt` has passed, each in its own
 *   sub-transaction (`fire`), so one bad row never blocks the rest.
 * - One fire per occurrence: the fire key `sched:<id>:<dueAt>` is unique on
 *   `scheduledTaskRuns` and is the created task's `idempotencyKey` (or the
 *   message's clientId), and `fire` only acts while `nextRunAt === dueAt`.
 *   A double tick dispatches once.
 * - G3 hold: while automation is held an occurrence records "held" and is
 *   skipped (not queued for later).
 * - A fixed-time occurrence more than 10 minutes late records "missed" and is
 *   skipped; an interval fires once and moves on (no backlog).
 *
 * The Settings tab and the webhook trigger are G8.
 */
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getViewerId } from "./lib/authz";
import { loadAutomationHold } from "./lib/automationHold";
import { isPersonalConversation } from "./lib/conversationShape";
import { projectDefaultPermissionMode } from "./lib/permissionModes";
import { recordAudit } from "./lib/recordAudit";
import { insertChatUserMessage } from "./chatContext";
import {
  isMissedFixedTimeRun,
  isValidTimeZone,
  nextRunAt,
  parseTimeOfDay,
  scheduledFireKey,
  type ScheduledTaskSchedule,
} from "./lib/schedule";
import { scheduleValidator, scheduledTargetValidator } from "./lib/scheduledTaskSchema";

/** Rows fired per tick; the rest are still due on the next minute. */
export const SCHEDULED_TICK_BATCH = 25;

type RunStatus = "dispatched" | "held" | "missed" | "failed";
type FireResult = { status: RunStatus | "stale"; taskId?: Id<"tasks">; messageId?: Id<"messages">; error?: string };

function assertSchedule(schedule: ScheduledTaskSchedule): void {
  if (schedule.type === "interval") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) throw new Error("Interval must be a positive number of milliseconds");
    return;
  }
  if (parseTimeOfDay(schedule.timeOfDay) === null) throw new Error("Time of day must be HH:MM");
  if (schedule.weekdays?.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("Weekdays are 0 (Sunday) to 6");
  if (schedule.timeZone !== undefined && !isValidTimeZone(schedule.timeZone)) throw new Error(`Unknown time zone: ${schedule.timeZone}`);
}

async function assertTarget(ctx: MutationCtx, projectId: Id<"projects">, target: Doc<"scheduledTasks">["target"]): Promise<void> {
  if (target.kind === "task") {
    const command = target.command.trim();
    if (!command) throw new Error("Command is required");
    if (command.length > 4000) throw new Error("Command is too long (max 4000 characters)");
    return;
  }
  if (!target.content.trim()) throw new Error("Message is required");
  const conversation = await ctx.db.get(target.conversationId);
  if (!conversation || conversation.projectId !== projectId) throw new Error("Conversation does not belong to this project");
}

async function createScheduledTaskRow(ctx: MutationCtx, project: Doc<"projects">, task: Doc<"scheduledTasks">, fireKey: string) {
  if (task.target.kind !== "task") throw new Error("Not a task target");
  const existing = await ctx.db
    .query("tasks")
    .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", fireKey))
    .first();
  if (existing) return existing._id;
  const command = task.target.command.trim();
  const title = (task.target.title?.trim() || task.name.trim() || command).slice(0, 200);
  const taskId = await ctx.db.insert("tasks", {
    projectId: task.projectId,
    title,
    command,
    status: "queued",
    permissionMode: task.target.permissionMode ?? projectDefaultPermissionMode(project),
    ...(project.shadowAgentDefault ? { shadowAgent: true } : {}),
    idempotencyKey: fireKey,
    updatedAt: Date.now(),
  });
  await ctx.db.insert("messages", { projectId: task.projectId, taskId, authorType: "user", content: command });
  return taskId;
}

async function sendScheduledMessage(ctx: MutationCtx, task: Doc<"scheduledTasks">, fireKey: string) {
  if (task.target.kind !== "conversation") throw new Error("Not a conversation target");
  const conversation = await ctx.db.get(task.target.conversationId);
  if (!conversation || conversation.projectId !== task.projectId) throw new Error("The bound conversation is gone");
  if (conversation.status !== "active") throw new Error("The bound conversation is closed");
  const existing = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_client_id", (q) => q.eq("conversationId", conversation._id).eq("clientId", fireKey))
    .first();
  if (existing) return existing._id;
  // A personal chat's messages carry no projectId (plan 039 D1).
  const personal = isPersonalConversation(conversation);
  const messageId = await insertChatUserMessage(ctx, {
    ...(personal ? {} : { projectId: task.projectId }),
    content: task.target.content,
    conversationId: conversation._id,
    clientId: fireKey,
  });
  const now = Date.now();
  await ctx.db.patch(conversation._id, { lastMessageAt: now, updatedAt: now });
  await ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
    ...(personal ? {} : { projectId: task.projectId }),
    conversationId: conversation._id,
    userMessageId: messageId,
  });
  return messageId;
}

async function recordRun(
  ctx: MutationCtx,
  task: Doc<"scheduledTasks">,
  dueAt: number,
  now: number,
  result: Omit<FireResult, "status"> & { status: RunStatus },
) {
  await ctx.db.insert("scheduledTaskRuns", {
    scheduledTaskId: task._id,
    projectId: task.projectId,
    fireKey: scheduledFireKey(task._id, dueAt),
    dueAt,
    firedAt: now,
    status: result.status,
    ...(result.taskId ? { taskId: result.taskId } : {}),
    ...(result.messageId ? { messageId: result.messageId } : {}),
    ...(result.error ? { error: result.error.slice(0, 500) } : {}),
  });
  const next = nextRunAt(task, Math.max(now, dueAt));
  await ctx.db.patch(task._id, { nextRunAt: next ?? undefined, lastRunAt: now, lastStatus: result.status, updatedAt: now });
}

/** Fire one occurrence. Acts only while the row still waits on `dueAt`. */
export async function fireScheduledTask(
  ctx: MutationCtx,
  scheduledTaskId: Id<"scheduledTasks">,
  dueAt: number,
  now: number,
): Promise<FireResult> {
  const task = await ctx.db.get(scheduledTaskId);
  if (!task || !task.enabled || task.nextRunAt !== dueAt) return { status: "stale" };
  const fireKey = scheduledFireKey(task._id, dueAt);
  const already = await ctx.db
    .query("scheduledTaskRuns")
    .withIndex("by_fire_key", (q) => q.eq("fireKey", fireKey))
    .first();
  if (already) {
    const next = nextRunAt(task, Math.max(now, dueAt));
    await ctx.db.patch(task._id, { nextRunAt: next ?? undefined, updatedAt: now });
    return { status: "stale" };
  }
  if ((await loadAutomationHold(ctx)) !== null) {
    await recordRun(ctx, task, dueAt, now, { status: "held" });
    return { status: "held" };
  }
  if (isMissedFixedTimeRun(task.schedule, dueAt, now)) {
    await recordRun(ctx, task, dueAt, now, { status: "missed" });
    return { status: "missed" };
  }
  const project = await ctx.db.get(task.projectId);
  if (!project) throw new Error("Project not found");
  const result: FireResult =
    task.target.kind === "task"
      ? { status: "dispatched", taskId: await createScheduledTaskRow(ctx, project, task, fireKey) }
      : { status: "dispatched", messageId: await sendScheduledMessage(ctx, task, fireKey) };
  await recordRun(ctx, task, dueAt, now, { ...result, status: "dispatched" });
  await recordAudit(ctx, {
    tool: "scheduler",
    action: "scheduled_task.fire",
    target: task.name,
    projectId: task.projectId,
    ...(result.taskId ? { taskId: result.taskId } : {}),
    details: { scheduledTaskId: task._id, dueAt, kind: task.target.kind },
  });
  return result;
}

export const fire = internalMutation({
  args: { scheduledTaskId: v.id("scheduledTasks"), dueAt: v.number(), now: v.number() },
  handler: async (ctx, args): Promise<FireResult> => await fireScheduledTask(ctx, args.scheduledTaskId, args.dueAt, args.now),
});

/** Records a failed fire (its own transaction rolled back) and moves the row on. */
export const recordFailure = internalMutation({
  args: { scheduledTaskId: v.id("scheduledTasks"), dueAt: v.number(), now: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task || task.nextRunAt !== args.dueAt) return;
    await recordRun(ctx, task, args.dueAt, args.now, { status: "failed", error: args.error });
  },
});

/** The 1-minute tick: fire every due row once. `now` is for tests. */
export const tick = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Record<RunStatus | "stale", number>> => {
    const now = args.now ?? Date.now();
    const due = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_enabled_next", (q) => q.eq("enabled", true).lte("nextRunAt", now))
      .take(SCHEDULED_TICK_BATCH);
    const counts: Record<RunStatus | "stale", number> = { dispatched: 0, held: 0, missed: 0, failed: 0, stale: 0 };
    for (const row of due) {
      if (row.nextRunAt === undefined) continue;
      const fireArgs = { scheduledTaskId: row._id, dueAt: row.nextRunAt, now };
      try {
        const result: FireResult = await ctx.runMutation(internal.scheduledTasks.fire, fireArgs);
        counts[result.status] += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.runMutation(internal.scheduledTasks.recordFailure, { ...fireArgs, error: message });
        counts.failed += 1;
      }
    }
    return counts;
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    schedule: scheduleValidator,
    target: scheduledTargetValidator,
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"scheduledTasks">> => {
    await assertProjectAccess(ctx, args.projectId);
    const name = args.name.trim();
    if (!name) throw new Error("Name is required");
    assertSchedule(args.schedule);
    await assertTarget(ctx, args.projectId, args.target);
    const now = Date.now();
    const enabled = args.enabled ?? true;
    const next = nextRunAt({ enabled, schedule: args.schedule }, now);
    const viewerId = await getViewerId(ctx);
    const id = await ctx.db.insert("scheduledTasks", {
      projectId: args.projectId,
      name: name.slice(0, 120),
      enabled,
      schedule: args.schedule,
      target: args.target,
      ...(next !== null ? { nextRunAt: next } : {}),
      ...(viewerId ? { createdBy: viewerId } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, { tool: "scheduler", action: "scheduled_task.create", target: name, projectId: args.projectId });
    return id;
  },
});

export const setEnabled = mutation({
  args: { scheduledTaskId: v.id("scheduledTasks"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) throw new Error("Scheduled task not found");
    await assertProjectAccess(ctx, task.projectId);
    const now = Date.now();
    const next = nextRunAt({ enabled: args.enabled, schedule: task.schedule }, now);
    await ctx.db.patch(task._id, { enabled: args.enabled, nextRunAt: next ?? undefined, updatedAt: now });
    return { nextRunAt: next };
  },
});

export const remove = mutation({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) return false;
    await assertProjectAccess(ctx, task.projectId);
    const runs = await ctx.db
      .query("scheduledTaskRuns")
      .withIndex("by_scheduled_task", (q) => q.eq("scheduledTaskId", task._id))
      .take(500);
    for (const run of runs) await ctx.db.delete(run._id);
    await ctx.db.delete(task._id);
    await recordAudit(ctx, { tool: "scheduler", action: "scheduled_task.remove", target: task.name, projectId: task.projectId });
    return true;
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("scheduledTasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(100);
  },
});

export const listRuns = query({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) return [];
    await assertProjectAccess(ctx, task.projectId);
    return await ctx.db
      .query("scheduledTaskRuns")
      .withIndex("by_scheduled_task", (q) => q.eq("scheduledTaskId", task._id))
      .order("desc")
      .take(20);
  },
});
