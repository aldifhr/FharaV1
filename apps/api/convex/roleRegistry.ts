import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {
  assertProjectAccess,
  assertRegistryWriteAccess,
  canViewProject,
  getViewerId,
} from "./lib/authz";
import { RETIRED_ROLE_KEYS, ROLE_KEYS, ROLES } from "./lib/roles";
import { recordAudit } from "./lib/recordAudit";

// Org chart: the fixed team — see lib/roles.ts (shared with the web app and
// agents.ts FIXED_AGENTS). The retired roles (Lead, Growth, Product
// Analyst, UI/UX) are no longer seeded; their existing registry rows are
// disabled by syncDefaults.
export const DEFAULT_ROLES = ROLE_KEYS.map((key) => {
  const role = ROLES[key];
  return {
    key: role.key,
    name: role.title,
    category: role.category,
    description: role.registryDescription,
    capabilities: role.registryCapabilities,
    defaultTools: role.defaultTools,
    enabled: true,
  };
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("roleDefinitions").collect();
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  },
});

export const getByKey = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("roleDefinitions").withIndex("by_key", (q) => q.eq("key", args.key)).take(1);
    return rows[0] ?? null;
  },
});

export const seedDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    let created = 0;
    for (const role of DEFAULT_ROLES) {
      const existing = await ctx.db.query("roleDefinitions").withIndex("by_key", (q) => q.eq("key", role.key)).take(1);
      if (existing.length === 0) {
        await ctx.db.insert("roleDefinitions", {
          key: role.key,
          name: role.name,
          category: role.category,
          description: role.description,
          capabilities: [...role.capabilities],
          defaultTools: [...role.defaultTools],
          enabled: role.enabled,
          createdAt: Date.now(),
        });
        created++;
      }
    }
    return { created };
  },
});

/**
 * Upserts DEFAULT_ROLES capabilities/tools into existing roleDefinitions
 * rows (idempotent). Run once after matrix changes so the DB registry
 * never diverges from source.
 */
export const syncDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    let updated = 0;
    let created = 0;
    for (const role of DEFAULT_ROLES) {
      const existing = await ctx.db.query("roleDefinitions").withIndex("by_key", (q) => q.eq("key", role.key)).take(1);
      if (existing.length === 0) {
        await ctx.db.insert("roleDefinitions", {
          key: role.key,
          name: role.name,
          category: role.category,
          description: role.description,
          capabilities: [...role.capabilities],
          defaultTools: [...role.defaultTools],
          enabled: role.enabled,
          createdAt: Date.now(),
        });
        created++;
      } else {
        const current = existing[0];
        const sameCaps = JSON.stringify([...(current.capabilities ?? [])]) === JSON.stringify([...role.capabilities]);
        const sameTools = JSON.stringify([...(current.defaultTools ?? [])]) === JSON.stringify([...role.defaultTools]);
        if (!sameCaps || !sameTools) {
          await ctx.db.patch(current._id, {
            capabilities: [...role.capabilities],
            defaultTools: [...role.defaultTools],
            updatedAt: Date.now(),
          } as never);
          updated++;
        }
      }
    }
    // Retired roles: disable their registry rows (kept for history).
    let disabled = 0;
    for (const key of RETIRED_ROLE_KEYS) {
      const rows = await ctx.db.query("roleDefinitions").withIndex("by_key", (q) => q.eq("key", key)).take(5);
      for (const row of rows) {
        if (row.enabled === false) continue;
        await ctx.db.patch(row._id, { enabled: false, updatedAt: Date.now() } as never);
        disabled++;
      }
    }
    return { updated, created, disabled };
  },
});

export const update = mutation({
  args: { id: v.id("roleDefinitions"), capabilityPatch: v.optional(v.any()), description: v.optional(v.string()), enabled: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const { id, ...rest } = args;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (rest.enabled !== undefined) patch.enabled = rest.enabled;
    if (rest.description !== undefined) patch.description = rest.description;
    const before = await ctx.db.get(id);
    await ctx.db.patch(id, patch as any);
    const changed = Object.keys(patch).filter((k) => k !== "updatedAt");
    if (changed.length) {
      await recordAudit(ctx, { action: "role.update", target: before?.name, details: { changed } });
    }
  },
});

export const assignToProject = mutation({
  args: { projectId: v.id("projects"), agentId: v.id("agents"), customInstructions: v.optional(v.string()), allowedTools: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");
    const existing = await ctx.db.query("projectAgents").withIndex("by_project_and_agent", (q) => q.eq("projectId", args.projectId).eq("agentId", args.agentId)).take(1);
    const id = existing[0]
      ? (await ctx.db.patch(existing[0]._id, { enabled: true, customInstructions: args.customInstructions, allowedTools: args.allowedTools, updatedAt: Date.now() }), existing[0]._id)
      : await ctx.db.insert("projectAgents", {
          projectId: args.projectId,
          agentId: args.agentId,
          enabled: true,
          customInstructions: args.customInstructions,
          allowedTools: args.allowedTools,
          createdAt: Date.now(),
        });
    // Dual-write to projects.agentIds — task validation + agents.listByProject
    // read that column, so the two sources stay one membership set.
    const project = await ctx.db.get(args.projectId);
    if (project && !(project.agentIds ?? []).includes(args.agentId)) {
      await ctx.db.patch(project._id, { agentIds: [...(project.agentIds ?? []), args.agentId] });
    }
    await recordAudit(ctx, {
      action: "project.assignAgent",
      target: `${agent.name} → ${project?.name ?? "project"}`,
      projectId: args.projectId,
      details: {
        fields: [
          ...(args.customInstructions !== undefined ? ["customInstructions"] : []),
          ...(args.allowedTools !== undefined ? ["allowedTools"] : []),
        ],
      },
    });
    return id;
  },
});

export const removeFromProject = mutation({
  args: { projectId: v.id("projects"), agentId: v.id("agents") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db.query("projectAgents").withIndex("by_project_and_agent", (q) => q.eq("projectId", args.projectId).eq("agentId", args.agentId)).take(1);
    // Removing an assignment must not delete the organization-level member.
    if (rows[0]) await ctx.db.delete(rows[0]._id);
    const project = await ctx.db.get(args.projectId);
    if (project?.agentIds?.includes(args.agentId)) {
      await ctx.db.patch(project._id, { agentIds: project.agentIds.filter((id) => id !== args.agentId) });
    }
    if (rows[0]) {
      const agent = await ctx.db.get(args.agentId);
      await recordAudit(ctx, {
        action: "project.unassignAgent",
        target: `${agent?.name ?? "agent"} → ${project?.name ?? "project"}`,
        projectId: args.projectId,
      });
    }
    return { applied: rows.length > 0 as boolean };
  },
});

export const listProjectTeam = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db.query("projectAgents").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).take(200);
    const members = await Promise.all(rows.map(async (r) => {
      const agent = await ctx.db.get(r.agentId);
      const role = agent?.roleId ? await ctx.db.get(agent.roleId) : null;
      return { assignment: r, agent, role };
    }));
    return members;
  },
});

export const getExecutionStatus = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    // Indexed + bounded (no scan of the agent's whole history), and only
    // executions in projects the caller may see.
    const viewerId = await getViewerId(ctx);
    const active = [];
    for (const status of ["queued", "running"] as const) {
      const rows = await ctx.db
        .query("executions")
        .withIndex("by_agent_and_status", (q) => q.eq("agentId", args.agentId).eq("status", status))
        .take(50);
      for (const row of rows) {
        const project = await ctx.db.get(row.projectId);
        if (canViewProject(viewerId, project)) active.push(row);
      }
    }
    return {
      active: active.length,
      status: active.length === 0 ? ("idle" as const) : ("working" as const),
      executions: active.map((e) => ({ _id: e._id, taskId: e.taskId, status: e.status, startedAt: e.startedAt })),
    };
  },
});
