/**
 * GOAT G12a: the read side of the Fhara MCP server (audit/goat-plan-2026-11-11.md, idea #9).
 *
 * The worker's localhost MCP server (packages/worker/src/mcpServer/) answers
 * `task.status`, `task.list` and `memory.search` through these queries. Each
 * one is worker-facing, so each takes `workerToken` and checks it first
 * (AGENTS.md non-negotiable #2). Results are typed and small: compact rows,
 * bounded lists, memory content capped, never a provider key or worktree
 * secret.
 *
 * The idea (agents call back into the orchestrator over MCP through one
 * registry of `resource.verb` tools) is a pattern from GOAT
 * `apps/server/src/mcp/` (https://github.com/goat-si/goat, commit 718f5b11),
 * MIT License, Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si
 * contributors. No code is copied. See THIRD_PARTY_NOTICES.md (## GOAT).
 */
import { query } from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertServiceToken } from "./lib/authz";
import { taskStatus as taskStatusValidator, subtaskStatus } from "./schema";
import { searchScope } from "./memories";
import { RECALL_MAX, recallSearchText } from "./lib/memoryRecall";

export const MCP_TASK_LIST_MAX = 50;
export const MCP_TASK_LIST_DEFAULT = 20;
export const MCP_MEMORY_CONTENT_MAX = 2000;

const taskRow = v.object({
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  status: taskStatusValidator,
  mode: v.union(v.literal("orchestrated"), v.literal("direct")),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  pendingQuestion: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  branchName: v.optional(v.string()),
});
export type McpTaskRow = Infer<typeof taskRow>;

const subtaskCount = v.object({ status: subtaskStatus, count: v.number() });

const memoryRow = v.object({
  id: v.string(),
  scope: v.union(v.literal("shared"), v.literal("project"), v.literal("agent")),
  projectId: v.optional(v.string()),
  title: v.string(),
  content: v.string(),
  truncated: v.boolean(),
  tags: v.array(v.string()),
  pinned: v.boolean(),
  updatedAt: v.number(),
});

function toTaskRow(task: Doc<"tasks">): McpTaskRow {
  return {
    id: task._id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    mode: task.mode ?? "orchestrated",
    createdAt: task._creationTime,
    ...(task.updatedAt !== undefined ? { updatedAt: task.updatedAt } : {}),
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(task.pendingQuestion ? { pendingQuestion: task.pendingQuestion } : {}),
    ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
    ...(task.branchName ? { branchName: task.branchName } : {}),
  };
}

/** `task.status`: one task plus its subtask counts by status; null for an unknown or malformed id. */
export const taskStatus = query({
  args: { workerToken: v.string(), taskId: v.string() },
  returns: v.union(v.null(), v.object({ task: taskRow, subtasks: v.array(subtaskCount) })),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const id = ctx.db.normalizeId("tasks", args.taskId);
    const task = id ? await ctx.db.get(id) : null;
    if (!task) return null;
    const subtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    const counts = new Map<Doc<"subtasks">["status"], number>();
    for (const s of subtasks) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
    return {
      task: toTaskRow(task),
      subtasks: [...counts].map(([status, count]) => ({ status, count })).sort((a, b) => a.status.localeCompare(b.status)),
    };
  },
});

/** `task.list`: newest tasks first, optionally one project and/or one status; at most 50. */
export const taskList = query({
  args: {
    workerToken: v.string(),
    projectId: v.optional(v.string()),
    status: v.optional(taskStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.object({ tasks: v.array(taskRow) }),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const limit = clampLimit(args.limit, MCP_TASK_LIST_DEFAULT, MCP_TASK_LIST_MAX);
    let projectId: Id<"projects"> | null = null;
    if (args.projectId !== undefined) {
      projectId = ctx.db.normalizeId("projects", args.projectId);
      if (!projectId) return { tasks: [] };
    }
    const status = args.status;
    let rows: Doc<"tasks">[];
    if (projectId) {
      const pid = projectId;
      const base = ctx.db.query("tasks").withIndex("by_project", (q) => q.eq("projectId", pid)).order("desc");
      rows = status ? (await base.filter((q) => q.eq(q.field("status"), status)).take(limit)) : await base.take(limit);
    } else if (status) {
      rows = await ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", status)).order("desc").take(limit);
    } else {
      rows = await ctx.db.query("tasks").order("desc").take(limit);
    }
    return { tasks: rows.map(toTaskRow) };
  },
});

/** `memory.search`: full-text search over shared memories, plus one project's when given; at most 10. */
export const memorySearch = query({
  args: {
    workerToken: v.string(),
    text: v.string(),
    projectId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({ memories: v.array(memoryRow) }),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const text = recallSearchText(args.text);
    if (!text) return { memories: [] };
    const limit = clampLimit(args.limit, RECALL_MAX, RECALL_MAX);
    const projectId = args.projectId !== undefined ? ctx.db.normalizeId("projects", args.projectId) : null;
    if (args.projectId !== undefined && !projectId) return { memories: [] };
    const [shared, project] = await Promise.all([
      searchScope(ctx, "shared", {}, text, limit),
      projectId ? searchScope(ctx, "project", { projectId }, text, limit) : Promise.resolve([]),
    ]);
    // Interleave by rank so neither scope crowds the other out.
    const merged: Doc<"memories">[] = [];
    for (let i = 0; merged.length < limit && (i < shared.length || i < project.length); i++) {
      if (project[i]) merged.push(project[i]);
      if (shared[i] && merged.length < limit) merged.push(shared[i]);
    }
    return {
      memories: merged.map((m) => ({
        id: m._id,
        scope: m.scope,
        ...(m.projectId ? { projectId: m.projectId } : {}),
        title: m.title,
        content: m.content.slice(0, MCP_MEMORY_CONTENT_MAX),
        truncated: m.content.length > MCP_MEMORY_CONTENT_MAX,
        tags: m.tags ?? [],
        pinned: m.pinned,
        updatedAt: m.updatedAt,
      })),
    };
  },
});

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(1, Math.floor(raw)), max);
}
