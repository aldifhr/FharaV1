/**
 * Context Snapshots: storage, reads and retention for what each LLM call saw.
 *
 *  - record (internal): one meta row + one body row. Re-applies redaction
 *    and caps (defense in depth: the worker already did) and honors the
 *    global kill switch CONTEXT_SNAPSHOTS=0 in the Convex env.
 *  - forTask / forMessage / get: read-side for the Context Inspector.
 *  - replay / compareSide: the Replay Session timeline and the run diff.
 *  - prune (cron): deletes rows older than the project's retention
 *    (contextSnapshotRetentionDays, default 14) in bounded batches.
 */
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getVisibleTask, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import {
  capSections,
  capText,
  contextSnapshotsEnabled,
  redactSecrets,
  retentionCutoff,
  retentionDays,
  SECTION_KEYS,
  SNAPSHOT_ERROR_CAP,
  SNAPSHOT_RESPONSE_CAP,
  type SectionKey,
} from "./lib/contextSnapshot";
import { buildReplaySteps, type RunSide } from "./lib/replay";

const sectionStat = v.object({
  key: v.string(),
  label: v.string(),
  chars: v.number(),
  tokens: v.number(),
  truncated: v.optional(v.boolean()),
});
const sectionBody = v.object({
  key: v.string(),
  label: v.string(),
  content: v.string(),
  truncatedChars: v.optional(v.number()),
});

/** Shared arg shape: the worker action and the chat path both send this. */
export const snapshotRecordArgs = {
  // Optional for worker calls: derived from the task when absent.
  projectId: v.optional(v.id("projects")),
  taskId: v.optional(v.id("tasks")),
  subtaskId: v.optional(v.id("subtasks")),
  subtaskKey: v.optional(v.string()),
  executionId: v.optional(v.id("executions")),
  messageId: v.optional(v.id("messages")),
  conversationId: v.optional(v.id("conversations")),
  agentId: v.optional(v.id("agents")),
  agentRole: v.optional(v.string()),
  source: v.union(v.literal("worker"), v.literal("chat")),
  meta: v.object({
    callRole: v.string(),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    temperature: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    usageEstimated: v.optional(v.boolean()),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
    sectionStats: v.array(sectionStat),
    promptTokens: v.number(),
    toolNames: v.array(v.string()),
    skillNames: v.array(v.string()),
    memoryIncluded: v.boolean(),
    historyMessages: v.number(),
    truncated: v.boolean(),
    bytes: v.number(),
  }),
  body: v.object({
    sections: v.array(sectionBody),
    response: v.string(),
    responseTruncatedChars: v.optional(v.number()),
  }),
};

const KNOWN_SECTIONS = new Set<string>(SECTION_KEYS);

export const record = internalMutation({
  args: snapshotRecordArgs,
  handler: async (ctx, args): Promise<Id<"contextSnapshots"> | null> => {
    if (!contextSnapshotsEnabled()) return null;
    const task = args.taskId ? await ctx.db.get(args.taskId) : null;
    const projectId = args.projectId ?? task?.projectId;
    if (!projectId) return null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    // Defense in depth: redact + cap again (idempotent).
    const sections = capSections(
      args.body.sections
        .filter((s) => KNOWN_SECTIONS.has(s.key))
        .map((s) => ({ ...s, key: s.key as SectionKey, content: redactSecrets(s.content) }))
    );
    const response = capText(redactSecrets(args.body.response), SNAPSHOT_RESPONSE_CAP);
    const error = args.meta.error ? capText(redactSecrets(args.meta.error), SNAPSHOT_ERROR_CAP).text : undefined;
    const bytes = sections.reduce((n, s) => n + s.content.length, 0) + response.text.length + (error?.length ?? 0);
    const { error: _ignored, ...meta } = args.meta;
    const snapshotId = await ctx.db.insert("contextSnapshots", {
      projectId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.subtaskId ? { subtaskId: args.subtaskId } : {}),
      ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
      ...(args.executionId ? { executionId: args.executionId } : {}),
      ...(args.messageId ? { messageId: args.messageId } : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.agentRole ? { agentRole: args.agentRole } : {}),
      source: args.source,
      ...meta,
      ...(error ? { error } : {}),
      toolNames: meta.toolNames.slice(0, 60),
      skillNames: meta.skillNames.slice(0, 40),
      truncated: meta.truncated || sections.some((s) => Boolean(s.truncatedChars)) || response.truncatedChars > 0,
      bytes,
      createdAt: Date.now(),
    });
    await ctx.db.insert("contextSnapshotBodies", {
      snapshotId,
      sections: sections.map((s) => ({
        key: s.key,
        label: s.label,
        content: s.content,
        ...(s.truncatedChars ? { truncatedChars: s.truncatedChars } : {}),
      })),
      response: response.text,
      ...(args.body.responseTruncatedChars || response.truncatedChars
        ? { responseTruncatedChars: (args.body.responseTruncatedChars ?? 0) + response.truncatedChars }
        : {}),
    });
    return snapshotId;
  },
});

/** Chat: attach a snapshot recorded before its bubble was kept/removed. */
export const attachMessage = internalMutation({
  args: { snapshotId: v.id("contextSnapshots"), messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.snapshotId);
    if (row) await ctx.db.patch(args.snapshotId, { messageId: args.messageId });
  },
});

type SnapshotRow = Doc<"contextSnapshots">;

async function agentRoles(ctx: QueryCtx, rows: SnapshotRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.agentId).filter((id): id is Id<"agents"> => Boolean(id)))];
  const out = new Map<string, string>();
  for (const id of ids) {
    const agent = await ctx.db.get(id);
    if (agent) out.set(String(id), agent.role);
  }
  return out;
}

function lightRow(row: SnapshotRow, roles: Map<string, string>) {
  return {
    _id: row._id,
    createdAt: row.createdAt,
    callRole: row.callRole,
    source: row.source,
    taskId: row.taskId,
    subtaskKey: row.subtaskKey,
    executionId: row.executionId,
    messageId: row.messageId,
    agentRole: row.agentRole ?? (row.agentId ? roles.get(String(row.agentId)) : undefined),
    model: row.model,
    provider: row.provider,
    temperature: row.temperature,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usageEstimated: row.usageEstimated,
    durationMs: row.durationMs,
    error: row.error,
    sectionStats: row.sectionStats,
    promptTokens: row.promptTokens,
    toolNames: row.toolNames,
    skillNames: row.skillNames,
    memoryIncluded: row.memoryIncluded,
    historyMessages: row.historyMessages,
    truncated: row.truncated,
  };
}

export type SnapshotListRow = ReturnType<typeof lightRow>;

const TASK_SNAPSHOT_CAP = 400;

async function taskSnapshots(ctx: QueryCtx, taskId: Id<"tasks">, cap = TASK_SNAPSHOT_CAP) {
  return await ctx.db
    .query("contextSnapshots")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("asc")
    .take(cap);
}

/** Every snapshot of a task (meta only), oldest first. */
export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    const rows = await taskSnapshots(ctx, task._id);
    const roles = await agentRoles(ctx, rows);
    return rows.map((r) => lightRow(r, roles));
  },
});

/** Snapshots behind one chat bubble (a grounded reply has several steps). */
export const forMessage = query({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return [];
    if (message.projectId) await assertProjectAccess(ctx, message.projectId);
    const rows = await ctx.db
      .query("contextSnapshots")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .take(50);
    rows.sort((a, b) => a.createdAt - b.createdAt);
    const roles = await agentRoles(ctx, rows);
    return rows.map((r) => lightRow(r, roles));
  },
});

/** One snapshot with its full (redacted, capped) text. */
export const get = query({
  args: { snapshotId: v.id("contextSnapshots") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.snapshotId);
    if (!row) return null;
    await assertProjectAccess(ctx, row.projectId);
    const body = await ctx.db
      .query("contextSnapshotBodies")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", row._id))
      .unique();
    const roles = await agentRoles(ctx, [row]);
    const project = await ctx.db.get(row.projectId);
    return {
      ...lightRow(row, roles),
      projectId: row.projectId,
      projectName: project?.name ?? "",
      sections: body?.sections ?? [],
      response: body?.response ?? "",
      responseTruncatedChars: body?.responseTruncatedChars,
    };
  },
});

/** Recent snapshots across visible projects (the Context Inspector's picker). */
export const recent = query({
  args: { projectId: v.optional(v.id("projects")), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 40)), 100);
    let rows: SnapshotRow[];
    if (args.projectId) {
      await assertProjectAccess(ctx, args.projectId);
      rows = await ctx.db
        .query("contextSnapshots")
        .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId!))
        .order("desc")
        .take(limit);
    } else {
      const visible = new Set((await visibleProjects(ctx)).map((p) => String(p._id)));
      rows = (await ctx.db.query("contextSnapshots").withIndex("by_created").order("desc").take(limit * 3))
        .filter((r) => visible.has(String(r.projectId)))
        .slice(0, limit);
    }
    const roles = await agentRoles(ctx, rows);
    return rows.map((r) => lightRow(r, roles));
  },
});

/** Replay Session: the run's ordered steps, built from events + snapshots. */
export const replay = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const [events, rows] = await Promise.all([
      ctx.db
        .query("taskEvents")
        .withIndex("by_task_and_sequence", (q) => q.eq("taskId", task._id))
        .order("asc")
        .take(1500),
      taskSnapshots(ctx, task._id),
    ]);
    const roles = await agentRoles(ctx, rows);
    const built = buildReplaySteps({
      task: {
        command: task.command,
        createdAt: task.startedAt ?? task._creationTime,
        status: task.status,
        errorMessage: task.errorMessage,
        endedAt: task.completedAt ?? null,
      },
      events: events.map((e) => ({
        _id: String(e._id),
        type: e.type,
        at: e.createdAt ?? e._creationTime,
        sequence: e.sequence,
        subtaskKey: e.subtaskKey,
        level: e.level,
        message: e.message,
        payload: e.payload,
      })),
      snapshots: rows.map((r) => ({
        _id: String(r._id),
        at: r.createdAt,
        callRole: r.callRole,
        subtaskKey: r.subtaskKey,
        agentRole: r.agentRole ?? (r.agentId ? roles.get(String(r.agentId)) : undefined),
        model: r.model,
        error: r.error,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        durationMs: r.durationMs,
      })),
    });
    return { ...built, snapshotCount: rows.length, truncatedEvents: events.length >= 1500 };
  },
});

const COMPARE_CALL_CAP = 60;
const COMPARE_TEXT_CAP = 6_000;

/** One side of a run comparison: plan, routing, prompts by section, outputs. */
export const compareSide = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<(RunSide & { taskId: Id<"tasks">; createdAt: number }) | null> => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const subtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(300);
    subtasks.sort((a, b) => a.order - b.order);
    const rows = await taskSnapshots(ctx, task._id, COMPARE_CALL_CAP);
    const roles = await agentRoles(ctx, rows);
    const calls = [];
    for (const row of rows) {
      const body = await ctx.db
        .query("contextSnapshotBodies")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", row._id))
        .unique();
      calls.push({
        snapshotId: String(row._id),
        callRole: row.callRole,
        subtaskKey: row.subtaskKey,
        agentRole: row.agentRole ?? (row.agentId ? roles.get(String(row.agentId)) : undefined),
        model: row.model,
        error: row.error,
        sections: row.sectionStats.map((stat) => ({
          key: stat.key,
          tokens: stat.tokens,
          content: body?.sections.find((s) => s.key === stat.key)?.content.slice(0, COMPARE_TEXT_CAP),
        })),
        response: body?.response.slice(0, COMPARE_TEXT_CAP),
      });
    }
    return {
      taskId: task._id,
      createdAt: task._creationTime,
      label: task.title,
      status: task.status,
      errorMessage: task.errorMessage,
      plan: subtasks.map((s) => ({ key: s.key, title: s.title, capability: s.capability })),
      routed: subtasks.map((s) => ({
        subtaskKey: s.key,
        agentRole: s.assignedAgentName ?? undefined,
      })),
      calls,
    };
  },
});

/** Other runs to compare with: same command first, then recent in the project. */
export const compareCandidates = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    const recentTasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", task.projectId))
      .order("desc")
      .take(60);
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    return recentTasks
      .filter((t) => t._id !== task._id)
      .map((t) => ({
        _id: t._id,
        title: t.title,
        status: t.status,
        createdAt: t._creationTime,
        sameCommand: norm(t.command) === norm(task.command),
      }))
      .sort((a, b) => Number(b.sameCommand) - Number(a.sameCommand) || b.createdAt - a.createdAt)
      .slice(0, 30);
  },
});

// ── Retention ───────────────────────────────────────────────────────────

export const getRetention = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    return {
      days: retentionDays(project.contextSnapshotRetentionDays),
      enabled: contextSnapshotsEnabled(),
    };
  },
});

export const setRetention = mutation({
  args: { projectId: v.id("projects"), days: v.number() },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const days = retentionDays(args.days);
    await ctx.db.patch(project._id, { contextSnapshotRetentionDays: days });
    await recordAudit(ctx, {
      action: "project.context_snapshot_retention",
      target: project.name,
      details: { changed: ["contextSnapshotRetentionDays"] },
      projectId: project._id,
    });
    return days;
  },
});

const PRUNE_BATCH = 200;

/**
 * Delete snapshots older than each project's retention. Bounded per run;
 * schedules itself again when a batch filled up.
 */
export const prune = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ deleted: number; more: boolean }> => {
    const now = args.now ?? Date.now();
    const projects = await ctx.db.query("projects").take(500);
    let deleted = 0;
    let more = false;
    for (const project of projects) {
      if (deleted >= PRUNE_BATCH) {
        more = true;
        break;
      }
      const cutoff = retentionCutoff(now, project.contextSnapshotRetentionDays);
      const old = await ctx.db
        .query("contextSnapshots")
        .withIndex("by_project_created", (q) => q.eq("projectId", project._id).lt("createdAt", cutoff))
        .take(PRUNE_BATCH - deleted + 1);
      if (old.length > PRUNE_BATCH - deleted) more = true;
      for (const row of old.slice(0, PRUNE_BATCH - deleted)) {
        const bodies = await ctx.db
          .query("contextSnapshotBodies")
          .withIndex("by_snapshot", (q) => q.eq("snapshotId", row._id))
          .take(5);
        for (const body of bodies) await ctx.db.delete(body._id);
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    // Rows of deleted projects: gone after the default retention.
    if (deleted < PRUNE_BATCH) {
      const stale = await ctx.db
        .query("contextSnapshots")
        .withIndex("by_created", (q) => q.lt("createdAt", retentionCutoff(now, undefined)))
        .take(100);
      const known = new Set(projects.map((p) => String(p._id)));
      for (const row of stale) {
        if (known.has(String(row.projectId)) || (await ctx.db.get(row.projectId))) continue;
        const bodies = await ctx.db
          .query("contextSnapshotBodies")
          .withIndex("by_snapshot", (q) => q.eq("snapshotId", row._id))
          .take(5);
        for (const body of bodies) await ctx.db.delete(body._id);
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    if (more && args.now === undefined) {
      await ctx.scheduler.runAfter(1_000, internal.contextSnapshots.prune, {});
    }
    return { deleted, more };
  },
});
