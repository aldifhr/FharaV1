/**
 * Incident Room: list / detail / owner + status for the incident records
 * lib/incidents.openIncident writes when a run fails or a subtask
 * escalates / blocks.
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjectIds } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";

const LIST_LIMIT = 200;

function summary(row: Doc<"incidents">, taskTitle: string | null, projectName: string | null) {
  return {
    _id: row._id,
    projectId: row.projectId,
    projectName,
    taskId: row.taskId,
    taskTitle,
    trigger: row.trigger,
    status: row.status,
    title: row.title,
    subtaskKey: row.subtaskKey ?? null,
    failurePoint: row.failurePoint ?? null,
    error: row.error ?? null,
    owner: row.owner ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

async function names(ctx: QueryCtx, rows: Doc<"incidents">[]) {
  const tasks = new Map<string, string | null>();
  const projects = new Map<string, string | null>();
  for (const row of rows) {
    if (!tasks.has(row.taskId)) tasks.set(row.taskId, (await ctx.db.get(row.taskId))?.title ?? null);
    if (!projects.has(row.projectId)) projects.set(row.projectId, (await ctx.db.get(row.projectId))?.name ?? null);
  }
  return { tasks, projects };
}

/** Incidents, newest first. Optional project and status filters. */
export const list = query({
  args: {
    projectId: v.optional(v.id("projects")),
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"))),
  },
  handler: async (ctx, args) => {
    let rows: Doc<"incidents">[];
    if (args.projectId) {
      await assertProjectAccess(ctx, args.projectId);
      rows = args.status
        ? await ctx.db
            .query("incidents")
            .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId!).eq("status", args.status!))
            .order("desc")
            .take(LIST_LIMIT)
        : await ctx.db
            .query("incidents")
            .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId!))
            .order("desc")
            .take(LIST_LIMIT);
    } else {
      const visible = await visibleProjectIds(ctx);
      const raw = args.status
        ? await ctx.db
            .query("incidents")
            .withIndex("by_status", (q) => q.eq("status", args.status!))
            .order("desc")
            .take(LIST_LIMIT)
        : await ctx.db.query("incidents").order("desc").take(LIST_LIMIT);
      rows = raw.filter((row) => visible.has(row.projectId));
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const { tasks, projects } = await names(ctx, rows);
    return rows.map((row) => summary(row, tasks.get(row.taskId) ?? null, projects.get(row.projectId) ?? null));
  },
});

/** One incident with its events, escalation, related audit rows and fix suggestions. */
export const get = query({
  args: { incidentId: v.id("incidents") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.incidentId);
    if (!row) return null;
    await assertProjectAccess(ctx, row.projectId);
    const task = await ctx.db.get(row.taskId);
    const proj = await ctx.db.get(row.projectId);
    const audits: Array<Doc<"audit">> = [];
    for (const id of row.auditIds) {
      const audit = await ctx.db.get(id as Id<"audit">);
      if (audit) audits.push(audit);
    }
    const suggestions = await ctx.db
      .query("improvementSuggestions")
      .withIndex("by_incident", (q) => q.eq("incidentId", row._id))
      .collect();
    return {
      ...summary(row, task?.title ?? null, proj?.name ?? null),
      taskStatus: task?.status ?? null,
      taskCommand: task?.command ?? null,
      note: row.note ?? null,
      lastEvents: row.lastEvents,
      escalation: row.escalation ?? null,
      audit: audits
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((audit) => ({
          _id: audit._id,
          actor: audit.actor,
          tool: audit.tool,
          action: audit.action,
          decision: audit.decision,
          target: audit.target ?? null,
          createdAt: audit.createdAt,
        })),
      suggestionIds: suggestions.sort((a, b) => b.createdAt - a.createdAt).map((s) => s._id),
    };
  },
});

/** Owner, status (open / resolved) and note. Audited (field names only). */
export const update = mutation({
  args: {
    incidentId: v.id("incidents"),
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"))),
    owner: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.incidentId);
    if (!row) throw new Error("Incident not found");
    await assertProjectAccess(ctx, row.projectId);
    const now = Date.now();
    const patch: Partial<Doc<"incidents">> = { updatedAt: now };
    const changed: string[] = [];
    if (args.status !== undefined && args.status !== row.status) {
      patch.status = args.status;
      patch.resolvedAt = args.status === "resolved" ? now : undefined;
      changed.push("status");
    }
    if (args.owner !== undefined) {
      const owner = args.owner.trim().slice(0, 80);
      if (owner !== (row.owner ?? "")) {
        patch.owner = owner || undefined;
        changed.push("owner");
      }
    }
    if (args.note !== undefined) {
      const note = args.note.trim().slice(0, 4_000);
      if (note !== (row.note ?? "")) {
        patch.note = note || undefined;
        changed.push("note");
      }
    }
    if (changed.length === 0) return false;
    await ctx.db.patch(row._id, patch);
    await recordAudit(ctx, {
      tool: "incident",
      action: "incident.update",
      target: row.title,
      projectId: row.projectId,
      taskId: row.taskId,
      details: { changed, ...(patch.status ? { status: patch.status } : {}) },
    });
    return true;
  },
});
