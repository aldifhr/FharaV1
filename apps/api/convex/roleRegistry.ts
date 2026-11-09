import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Org chart: Fixed 8-agent team (Lead, CTO, Designer, Frontend, Backend, QA, Growth, Support)
// plus legacy roles for backwards compatibility.
// Kept in sync with packages/worker/src/orchestrator/roles.ts ROLE_DEFINITIONS.
export const DEFAULT_ROLES = [
  { key: "lead", name: "Lead", category: "Leadership", description: "Project coordination, task analysis, delegation, collaboration tracking.", capabilities: ["project-coordination", "general"], defaultTools: ["read_file"], enabled: true },
  { key: "cto", name: "CTO", category: "Leadership", description: "Technical architecture, technical decisions, risk evaluation.", capabilities: ["architecture", "security-audit"], defaultTools: ["read_file"], enabled: true },
  { key: "designer", name: "Designer", category: "Product", description: "UI/UX, wireframes, design system, component specifications.", capabilities: ["ui-ux-design"], defaultTools: ["read_file", "write_file"], enabled: true },
  { key: "frontend", name: "Frontend Developer", category: "Engineering", description: "Frontend implementation, React, Next.js, responsive UI.", capabilities: ["frontend-development"], defaultTools: ["read_file", "write_file", "run_command"], enabled: true },
  { key: "backend", name: "Backend Developer", category: "Engineering", description: "Backend, API, database, server-side logic.", capabilities: ["backend-development"], defaultTools: ["read_file", "write_file", "run_command"], enabled: true },
  { key: "qa", name: "QA Engineer", category: "Quality", description: "Testing, bug detection, quality assurance, verification.", capabilities: ["browser-testing"], defaultTools: ["read_file", "run_command"], enabled: true },
  { key: "growth", name: "Growth Specialist", category: "Growth", description: "SEO, product growth, analytics, metrics, user engagement.", capabilities: ["growth-marketing"], defaultTools: ["read_file"], enabled: true },
  { key: "support", name: "Support Specialist", category: "Operations", description: "Documentation, user support, operational assistance, troubleshooting.", capabilities: ["documentation-support"], defaultTools: ["read_file", "write_file"], enabled: true },
  // Legacy role definitions
  { key: "devops", name: "DevOps Engineer", category: "Engineering", description: "Docker, CI/CD, deployment, infrastructure.", capabilities: ["github", "shell-execution"], defaultTools: ["read_file", "run_command"], enabled: true },
  { key: "reviewer", name: "Reviewer", category: "Quality", description: "Independent code review.", capabilities: ["code-review"], defaultTools: ["read_file"], enabled: true },
  { key: "researcher", name: "Researcher", category: "Research", description: "Technical research.", capabilities: ["research"], defaultTools: ["read_file"], enabled: true },
  { key: "product-analyst", name: "Product Analyst", category: "Product", description: "Requirement analysis.", capabilities: ["research"], defaultTools: ["read_file"], enabled: true },
  { key: "ui-ux", name: "UI/UX Designer", category: "Product", description: "User experience and interface design.", capabilities: ["ui-ux-design"], defaultTools: ["read_file"], enabled: true },
] as const;

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
    return { updated, created };
  },
});

export const update = mutation({
  args: { id: v.id("roleDefinitions"), capabilityPatch: v.optional(v.any()), description: v.optional(v.string()), enabled: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { id, ...rest } = args;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (rest.enabled !== undefined) patch.enabled = rest.enabled;
    if (rest.description !== undefined) patch.description = rest.description;
    await ctx.db.patch(id, patch as any);
  },
});

export const assignToProject = mutation({
  args: { projectId: v.id("projects"), agentId: v.id("agents"), customInstructions: v.optional(v.string()), allowedTools: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
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
    return id;
  },
});

export const removeFromProject = mutation({
  args: { projectId: v.id("projects"), agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("projectAgents").withIndex("by_project_and_agent", (q) => q.eq("projectId", args.projectId).eq("agentId", args.agentId)).take(1);
    // Removing an assignment must not delete the organization-level member.
    if (rows[0]) await ctx.db.delete(rows[0]._id);
    const project = await ctx.db.get(args.projectId);
    if (project?.agentIds?.includes(args.agentId)) {
      await ctx.db.patch(project._id, { agentIds: project.agentIds.filter((id) => id !== args.agentId) });
    }
    return { applied: rows.length > 0 as boolean };
  },
});

export const listProjectTeam = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("projectAgents").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect();
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
    const executions = await ctx.db.query("executions").withIndex("by_agent", (q) => q.eq("agentId", args.agentId)).collect();
    const active = executions.filter((e) => ["queued", "running"].includes(e.status));
    return {
      active: active.length,
      status: active.length === 0 ? ("idle" as const) : ("working" as const),
      executions: active.map((e) => ({ _id: e._id, taskId: e.taskId, status: e.status, startedAt: e.startedAt })),
    };
  },
});
