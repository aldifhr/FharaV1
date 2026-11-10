import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, assertRegistryWriteAccess } from "./lib/authz";
import { validateMemoryInput } from "./lib/memory";
import { recordAudit } from "./lib/recordAudit";

/**
 * Plan L5: memory suggestions. After a task finishes, the worker proposes at
 * most MAX_SUGGESTIONS_PER_TASK add / update / forget operations
 * (services/runner/memoryReconcile.ts). They are proposals only: nothing is
 * written to `memories` and nothing reaches a prompt until the user accepts
 * one on /memory. An accepted "add" becomes an UNPINNED memory with source
 * "agent" (recalled by search, plan L4, never always-on until pinned).
 */

export const MAX_SUGGESTIONS_PER_TASK = 5;
/** Memories shown to the reconciler so it can update/forget instead of duplicating. */
const CONTEXT_MEMORIES = 40;
const CONTEXT_CONTENT_CHARS = 300;

const opArg = v.union(v.literal("add"), v.literal("update"), v.literal("forget"));
const scopeArg = v.union(v.literal("shared"), v.literal("project"));

export const suggestionInput = v.object({
  op: opArg,
  memoryId: v.optional(v.string()),
  scope: scopeArg,
  title: v.string(),
  content: v.string(),
  reason: v.optional(v.string()),
});

/** Worker read: whether this task was reconciled, plus compact current memories. */
export const reconcileContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const done = await ctx.db
      .query("memoryReconciliations")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();
    const shared = await ctx.db
      .query("memories")
      .withIndex("by_scope", (q) => q.eq("scope", "shared"))
      .take(CONTEXT_MEMORIES);
    const project = await ctx.db
      .query("memories")
      .withIndex("by_project", (q) => q.eq("projectId", task.projectId).eq("scope", "project"))
      .take(CONTEXT_MEMORIES);
    return {
      reconciled: Boolean(done),
      memories: [...project, ...shared].slice(0, CONTEXT_MEMORIES).map((row) => ({
        id: row._id as string,
        scope: row.scope,
        title: row.title,
        content: row.content.slice(0, CONTEXT_CONTENT_CHARS),
        pinned: row.pinned,
      })),
    };
  },
});

/**
 * Worker write: the proposals for one task plus its reconciliation marker.
 * Idempotent per task: a second call for the same task writes nothing.
 * Invalid rows (bad title/content, an update/forget aimed at a memory
 * outside this project or the shared scope) are dropped, not thrown.
 */
export const record = internalMutation({
  args: {
    taskId: v.id("tasks"),
    tag: v.string(),
    reason: v.optional(v.string()),
    suggestions: v.array(suggestionInput),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { applied: false as const, reason: "task_not_found" as const, inserted: 0 };
    const done = await ctx.db
      .query("memoryReconciliations")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();
    if (done) return { applied: false as const, reason: "already_reconciled" as const, inserted: 0 };
    const now = Date.now();
    let inserted = 0;
    for (const raw of args.suggestions.slice(0, MAX_SUGGESTIONS_PER_TASK)) {
      const clean = cleanSuggestion(raw);
      if (!clean) continue;
      let memoryId: Id<"memories"> | undefined;
      if (raw.op !== "add") {
        const target = raw.memoryId ? await getMemory(ctx, raw.memoryId) : null;
        if (!target) continue;
        if (target.scope === "agent") continue;
        if (target.scope === "project" && target.projectId !== task.projectId) continue;
        memoryId = target._id;
      }
      await ctx.db.insert("memorySuggestions", {
        projectId: task.projectId,
        taskId: task._id,
        op: raw.op,
        ...(memoryId ? { memoryId } : {}),
        scope: raw.scope,
        title: clean.title,
        content: clean.content,
        ...(raw.reason?.trim() ? { reason: raw.reason.trim().slice(0, 300) } : {}),
        status: "proposed",
        createdAt: now,
      });
      inserted += 1;
    }
    await ctx.db.insert("memoryReconciliations", {
      projectId: task.projectId,
      taskId: task._id,
      tag: args.tag.slice(0, 64),
      ...(args.reason ? { reason: args.reason.slice(0, 300) } : {}),
      suggestions: inserted,
      createdAt: now,
    });
    return { applied: true as const, inserted };
  },
});

async function getMemory(ctx: MutationCtx, id: string): Promise<Doc<"memories"> | null> {
  const normalized = ctx.db.normalizeId("memories", id);
  return normalized ? await ctx.db.get(normalized) : null;
}

function cleanSuggestion(raw: { op: string; title: string; content: string }): { title: string; content: string } | null {
  try {
    const title = raw.title.trim().slice(0, 120);
    // A forget needs no new content; keep the reason/title readable.
    const content = raw.op === "forget" ? raw.content.trim() || title : raw.content.trim();
    const clean = validateMemoryInput({ title, content });
    return { title: clean.title!, content: clean.content! };
  } catch {
    return null;
  }
}

/** /memory: open suggestions for one scope (shared, or one project's). */
export const list = query({
  args: { scope: v.union(v.literal("shared"), v.literal("project"), v.literal("agent")), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    if (args.scope === "agent") return [];
    if (args.scope === "project") {
      if (!args.projectId) return [];
      await assertProjectAccess(ctx, args.projectId);
      const rows = await ctx.db
        .query("memorySuggestions")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId!).eq("status", "proposed"))
        .take(100);
      return rows.filter((row) => row.scope === "project").sort((a, b) => b.createdAt - a.createdAt);
    }
    const rows = await ctx.db
      .query("memorySuggestions")
      .withIndex("by_status", (q) => q.eq("status", "proposed"))
      .order("desc")
      .take(100);
    return rows.filter((row) => row.scope === "shared");
  },
});

async function getOpen(ctx: MutationCtx, suggestionId: Id<"memorySuggestions">) {
  const row = await ctx.db.get(suggestionId);
  if (!row) throw new Error("Suggestion not found");
  if (row.status !== "proposed") throw new Error("This suggestion was already decided");
  if (row.scope === "project") await assertProjectAccess(ctx, row.projectId);
  else await assertRegistryWriteAccess(ctx);
  return row;
}

/**
 * Accept: apply the suggestion (optionally edited). add → a new UNPINNED
 * memory, source "agent"; update → the target's title/content (its pin is
 * kept); forget → the target is deleted.
 */
export const accept = mutation({
  args: { suggestionId: v.id("memorySuggestions"), title: v.optional(v.string()), content: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await getOpen(ctx, args.suggestionId);
    const now = Date.now();
    let resultMemoryId: Id<"memories"> | undefined;
    if (row.op === "add") {
      const clean = validateMemoryInput({ title: args.title ?? row.title, content: args.content ?? row.content });
      resultMemoryId = await ctx.db.insert("memories", {
        scope: row.scope,
        ...(row.scope === "project" ? { projectId: row.projectId } : {}),
        title: clean.title!,
        content: clean.content!,
        pinned: false,
        source: "agent",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const target = row.memoryId ? await ctx.db.get(row.memoryId) : null;
      if (!target) throw new Error("The memory this suggestion changes no longer exists");
      if (row.op === "update") {
        const clean = validateMemoryInput({ title: args.title ?? row.title, content: args.content ?? row.content });
        await ctx.db.patch(target._id, { title: clean.title!, content: clean.content!, updatedAt: now });
        resultMemoryId = target._id;
      } else {
        await ctx.db.delete(target._id);
      }
    }
    await ctx.db.patch(row._id, {
      status: "accepted",
      decidedAt: now,
      ...(resultMemoryId ? { resultMemoryId } : {}),
    });
    await recordAudit(ctx, {
      action: `memory.suggestion.accept`,
      target: `${row.scope}: ${row.op} ${row.title}`,
      ...(row.scope === "project" ? { projectId: row.projectId } : {}),
    });
    return { memoryId: resultMemoryId ?? null };
  },
});

export const reject = mutation({
  args: { suggestionId: v.id("memorySuggestions") },
  handler: async (ctx, args) => {
    const row = await getOpen(ctx, args.suggestionId);
    await ctx.db.patch(row._id, { status: "rejected", decidedAt: Date.now() });
  },
});
