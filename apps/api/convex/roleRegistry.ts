import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const DEFAULT_ROLES = [
  { key: "cto", name: "CTO — Orchestrator", category: "Leadership", description: "Central task controller.", capabilities: ["architecture", "research", "general"], defaultTools: ["read_file"], enabled: true },
  { key: "developer", name: "Developer", category: "Engineering", description: "Software implementation and code modification.", capabilities: ["frontend-development", "backend-development"], defaultTools: ["read_file", "write_file", "run_command"], enabled: true },
  { key: "qa", name: "QA Engineer", category: "Quality", description: "Testing and quality verification.", capabilities: ["browser-testing"], defaultTools: ["read_file", "run_command"], enabled: true },
  { key: "reviewer", name: "Reviewer", category: "Quality", description: "Independent code and implementation review.", capabilities: ["code-review"], defaultTools: ["read_file"], enabled: true },
  { key: "researcher", name: "Researcher", category: "Research", description: "Technical research and information gathering.", capabilities: ["research"], defaultTools: ["read_file"], enabled: true },
  { key: "technical-writer", name: "Technical Writer", category: "Product", description: "Technical documentation and reporting.", capabilities: ["documentation"], defaultTools: ["read_file"], enabled: true },
  { key: "architect", name: "Architect", category: "Specialist", description: "System architecture design (specialist, not a second Orchestrator).", capabilities: ["architecture"], defaultTools: ["read_file"], enabled: true },
  { key: "devops", name: "DevOps Engineer", category: "Engineering", description: "CI/CD, Docker, deployment, infrastructure.", capabilities: ["shell-execution", "backend-development"], defaultTools: ["read_file", "run_command"], enabled: true },
  { key: "security", name: "Security Engineer", category: "Specialist", description: "Threat analysis, vulnerability assessment.", capabilities: ["security-audit", "code-review"], defaultTools: ["read_file"], enabled: true },
  { key: "database", name: "Database Engineer", category: "Specialist", description: "Schema design, query optimization, migrations.", capabilities: ["backend-development"], defaultTools: ["read_file"], enabled: true },
  { key: "ui-ux", name: "UI/UX Designer", category: "Product", description: "User experience and interface design.", capabilities: ["frontend-development"], defaultTools: ["read_file"], enabled: true },
  { key: "product-analyst", name: "Product Analyst", category: "Product", description: "Requirement analysis and acceptance criteria.", capabilities: ["research"], defaultTools: ["read_file"], enabled: true },
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
    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, { enabled: true, customInstructions: args.customInstructions, allowedTools: args.allowedTools, updatedAt: Date.now() });
      return existing[0]._id;
    }
    return await ctx.db.insert("projectAgents", {
      projectId: args.projectId,
      agentId: args.agentId,
      enabled: true,
      customInstructions: args.customInstructions,
      allowedTools: args.allowedTools,
      createdAt: Date.now(),
    });
  },
});

export const removeFromProject = mutation({
  args: { projectId: v.id("projects"), agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("projectAgents").withIndex("by_project_and_agent", (q) => q.eq("projectId", args.projectId).eq("agentId", args.agentId)).take(1);
    if (!rows[0]) return { applied: false as const };
    // Removing an assignment must not delete the organization-level member.
    await ctx.db.delete(rows[0]._id);
    return { applied: true as const };
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
