import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertProjectAccess, canViewProject, getViewerId } from "./lib/authz";
import { changedFields, recordAudit } from "./lib/recordAudit";
import { permissionModeValidator, type PermissionMode } from "./lib/permissionModes";
import { normalizeMainBranch } from "./lib/taskBranch";

function validateWorkspacePath(raw: string): string {
  const workspacePath = raw.trim();
  if (!workspacePath) throw new Error("Project path is required");
  if (workspacePath.length > 1024) throw new Error("Project path is too long");
  if (/[\u0000-\u001f]/.test(workspacePath)) {
    throw new Error("Project path contains control characters");
  }
  if (/^[a-z]+:\/\//i.test(workspacePath) && !/^file:\/\//i.test(workspacePath)) {
    throw new Error("Project path must be a local filesystem path");
  }
  if (workspacePath.split(/[\\/]+/).includes("..")) {
    throw new Error("Project path must not contain '..' segments");
  }
  // "." / "./" resolve to the worker's own workspace root, never a project.
  if (/^\.[\\/]*$/.test(workspacePath)) {
    throw new Error("Project path must name a project folder, not '.'");
  }
  return workspacePath;
}

export const create = mutation({
  args: {
    name: v.string(),
    workspacePath: v.string(),
    agentIds: v.optional(v.array(v.id("agents"))),
    qaUrl: v.optional(v.string()),
    devUrl: v.optional(v.string()),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"))),
    defaultPermissionMode: v.optional(permissionModeValidator),
    /** Base branch for task worktrees; omitted/empty = auto-detect. */
    mainBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const mainBranch = normalizeMainBranch(args.mainBranch);
    if (!name) throw new Error("Project name is required");
    const workspacePath = validateWorkspacePath(args.workspacePath);

    for (const agentId of args.agentIds ?? []) {
      const agent = await ctx.db.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
    }

    const viewerId = await getViewerId(ctx);
    const projectId = await ctx.db.insert("projects", {
      name,
      workspacePath,
      ...(args.agentIds ? { agentIds: args.agentIds } : {}),
      ...(args.qaUrl ? { qaUrl: args.qaUrl.trim() } : {}),
      ...(args.devUrl ? { devUrl: args.devUrl.trim() } : {}),
      ...(viewerId ? { ownerId: viewerId } : {}),
      ...(args.approvalMode ? { approvalMode: args.approvalMode } : {}),
      ...(args.defaultPermissionMode ? { defaultPermissionMode: args.defaultPermissionMode } : {}),
      ...(mainBranch ? { mainBranch } : {}),
      createdAt: Date.now(),
    });
    await recordAudit(ctx, { action: "project.create", target: name, projectId });
    return projectId;
  },
});

export const updateTeam = mutation({
  args: {
    projectId: v.id("projects"),
    agentIds: v.array(v.id("agents")),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const uniqueAgentIds = Array.from(new Set(args.agentIds));
    for (const agentId of uniqueAgentIds) {
      const agent = await ctx.db.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
    }
    await ctx.db.patch(args.projectId, { agentIds: uniqueAgentIds });
    const before = new Set(project.agentIds ?? []);
    const added = uniqueAgentIds.filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !uniqueAgentIds.includes(id)).length;
    if (added || removed) {
      await recordAudit(ctx, {
        action: "project.team",
        target: project.name,
        projectId: args.projectId,
        details: { changed: ["agentIds"], added, removed },
      });
    }
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    workspacePath: v.optional(v.string()),
    qaUrl: v.optional(v.string()),
    devUrl: v.optional(v.string()),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"))),
    instructions: v.optional(v.string()),
    defaultPermissionMode: v.optional(permissionModeValidator),
    /** Base branch for task worktrees; "" clears it (auto-detect). */
    mainBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const patch: {
      mainBranch?: string | undefined;
      defaultPermissionMode?: PermissionMode;
      name?: string;
      workspacePath?: string;
      qaUrl?: string;
      devUrl?: string;
      approvalMode?: "ask" | "auto";
      instructions?: string;
    } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Project name is required");
      patch.name = name;
    }
    if (args.workspacePath !== undefined) {
      patch.workspacePath = validateWorkspacePath(args.workspacePath);
    }
    if (args.qaUrl !== undefined) {
      patch.qaUrl = args.qaUrl.trim();
    }
    if (args.devUrl !== undefined) {
      patch.devUrl = args.devUrl.trim();
    }
    if (args.approvalMode !== undefined) {
      patch.approvalMode = args.approvalMode;
    }
    if (args.instructions !== undefined) {
      patch.instructions = args.instructions;
    }
    if (args.defaultPermissionMode !== undefined) {
      patch.defaultPermissionMode = args.defaultPermissionMode;
    }
    if (args.mainBranch !== undefined) {
      patch.mainBranch = normalizeMainBranch(args.mainBranch) ?? undefined;
    }
    await ctx.db.patch(args.projectId, patch);
    const changed = changedFields(project as Record<string, unknown>, patch);
    if (changed.length) {
      await recordAudit(ctx, {
        action: "project.update",
        target: patch.name ?? project.name,
        projectId: args.projectId,
        details: { changed },
      });
    }
  },
});

export const updateApprovalMode = mutation({
  args: {
    projectId: v.id("projects"),
    approvalMode: v.union(v.literal("ask"), v.literal("auto")),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    await ctx.db.patch(args.projectId, { approvalMode: args.approvalMode });
    if (project.approvalMode !== args.approvalMode) {
      await recordAudit(ctx, {
        action: "project.update",
        target: project.name,
        projectId: args.projectId,
        details: { changed: ["approvalMode"] },
      });
    }
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await getViewerId(ctx);
    if (!viewerId) {
      return await ctx.db.query("projects").order("desc").collect();
    }
    const all = await ctx.db.query("projects").order("desc").collect();
    return all.filter((project) => canViewProject(viewerId, project));
  },
});

/**
 * One project, or `null` when the id is malformed or the project no longer
 * exists (stale/deleted URL) so the UI can redirect instead of crashing.
 * Access to an existing project owned by someone else still throws.
 */
export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    return await assertProjectAccess(ctx, projectId);
  },
});

/**
 * Every table holding a `projectId`, in the order the cascade empties them,
 * each with an index whose FIRST field is `projectId` (so `eq("projectId")`
 * selects exactly the project's rows). Children go before their parents
 * (task-scoped rows before `tasks`, snapshots with their bodies) so a
 * half-finished cascade never leaves a row pointing at a deleted parent it
 * still needs. `projectCascade.test.ts` checks this list against
 * schema.ts, so a new table with a projectId fails the suite until it is
 * listed here or in PROJECT_CASCADE_EXEMPT.
 *
 * `audit` is deliberately not deleted: the trail outlives the project, so
 * its rows are detached (projectId cleared) instead.
 */
export const PROJECT_CASCADE = [
  { table: "subtaskLive", index: "by_project" },
  { table: "executionObservations", index: "by_project" },
  { table: "executions", index: "by_project" },
  { table: "evaluations", index: "by_project" },
  { table: "fileChanges", index: "by_project" },
  { table: "taskInputs", index: "by_project" },
  { table: "taskContexts", index: "by_project" },
  { table: "delegations", index: "by_project" },
  { table: "lifecycleHistory", index: "by_project" },
  { table: "taskPushes", index: "by_project" },
  { table: "prReactions", index: "by_project" },
  { table: "notifications", index: "by_project" },
  { table: "repoToolCalls", index: "by_project" },
  { table: "improvementSuggestions", index: "by_project" },
  { table: "incidents", index: "by_project_and_status" },
  { table: "reviewOpinions", index: "by_project_and_target" },
  { table: "decisions", index: "by_project" },
  { table: "contextSnapshots", index: "by_project_created" },
  { table: "contextSummaries", index: "by_project" },
  { table: "tokenUsage", index: "by_project" },
  { table: "agentEvents", index: "by_project" },
  { table: "taskEvents", index: "by_project" },
  { table: "taskSignals", index: "by_project" },
  { table: "approvals", index: "by_project" },
  { table: "messages", index: "by_project" },
  { table: "conversationParticipants", index: "by_project" },
  { table: "conversations", index: "by_project" },
  { table: "subtasks", index: "by_project" },
  { table: "plans", index: "by_project" },
  { table: "tasks", index: "by_project" },
  { table: "integrationEvents", index: "by_project" },
  { table: "integrations", index: "by_project" },
  { table: "projectAgents", index: "by_project" },
  { table: "mcpServers", index: "by_project" },
  { table: "memories", index: "by_project" },
  { table: "calibrationActions", index: "by_project" },
  { table: "audit", index: "by_project" },
] as const;

/**
 * Tables with a `projectId` field the cascade leaves alone, and why.
 * `llmProviders.projectId` is a legacy free-form string that nothing writes
 * any more; providers are global and own models other projects use.
 */
export const PROJECT_CASCADE_EXEMPT: Record<string, string> = {
  llmProviders: "legacy string projectId, never written; providers are global",
};

/** Rows touched per cascade mutation; keeps each run well under Convex limits. */
export const PROJECT_CASCADE_BATCH = 200;

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    // The project row goes now (the UI drops it at once); every row that
    // points at it is removed in batches by the scheduled cascade, which
    // reschedules itself until all PROJECT_CASCADE tables are empty.
    await ctx.db.delete(args.projectId);
    await ctx.scheduler.runAfter(0, internal.projects.cascadeDelete, {
      projectId: args.projectId,
      step: 0,
      deleted: 0,
    });
    // Global row (no projectId): the project is gone, the trail stays.
    await recordAudit(ctx, {
      action: "project.remove",
      target: project.name,
      details: { deletedTasks: tasks.length },
    });
    return { deletedTasks: tasks.length };
  },
});

/** True when a participant row belongs to a personal conversation (plan 039). */
async function isPersonalParticipant(
  ctx: MutationCtx,
  row: { conversationId: Id<"conversations"> }
): Promise<boolean> {
  const conversation = await ctx.db.get(row.conversationId);
  return conversation?.kind === "personal";
}

/**
 * One batch of the project delete cascade. Works through PROJECT_CASCADE
 * from `step`, touching at most PROJECT_CASCADE_BATCH rows, then schedules
 * itself to continue. Idempotent: rerunning a step only finds what is left.
 */
export const cascadeDelete = internalMutation({
  args: { projectId: v.id("projects"), step: v.number(), deleted: v.number() },
  handler: async (ctx, args): Promise<{ done: boolean; step: number; deleted: number }> => {
    let budget = PROJECT_CASCADE_BATCH;
    let deleted = args.deleted;
    let step = args.step;
    while (step < PROJECT_CASCADE.length && budget > 0) {
      const { table, index } = PROJECT_CASCADE[step];
      const rows = await (ctx.db.query(table) as any)
        .withIndex(index, (q: any) => q.eq("projectId", args.projectId))
        .take(budget);
      for (const row of rows) {
        if (table === "audit") {
          await ctx.db.patch(row._id, { projectId: undefined });
        } else if (table === "conversations" && row.kind === "personal") {
          // Plan 039: an attached personal chat is the user's, not the
          // project's: detach it instead of deleting it. Its messages carry
          // no projectId (D1), so they survive the messages step too.
          await ctx.db.patch(row._id, { projectId: undefined, projectAttachedAt: undefined });
        } else if (table === "conversationParticipants" && (await isPersonalParticipant(ctx, row))) {
          await ctx.db.patch(row._id, { projectId: undefined });
        } else {
          if (table === "contextSnapshots") {
            const bodies = await ctx.db
              .query("contextSnapshotBodies")
              .withIndex("by_snapshot", (q) => q.eq("snapshotId", row._id))
              .collect();
            for (const body of bodies) await ctx.db.delete(body._id);
          }
          await ctx.db.delete(row._id);
        }
        deleted += 1;
      }
      budget -= rows.length;
      // A full batch may mean more rows remain in this table: stay on it.
      if (budget <= 0) break;
      step += 1;
    }
    const done = step >= PROJECT_CASCADE.length;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.projects.cascadeDelete, {
        projectId: args.projectId,
        step,
        deleted,
      });
    }
    return { done, step, deleted };
  },
});
