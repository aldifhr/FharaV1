import { query, mutation, internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertAgentAccess, assertProjectAccess, assertRegistryWriteAccess } from "./lib/authz";
import {
  FIXED_TEAM_SEED_ORDER,
  REVOKED_DEFAULT_CAPABILITIES,
  ADDED_DEFAULT_TOOLS,
  REVOKED_DEFAULT_TOOLS,
  ROLES,
  isRetiredRole,
  normalizeRoleKey,
} from "./lib/roles";
import { defaultAvatarParams } from "./lib/avatar";
import { changedFields, recordAudit, setFields } from "./lib/recordAudit";
import { AGENT_SEED_PROMPTS, GENERIC_AGENT_PROMPT, LEGACY_UI_UX_PROMPT, PREVIOUS_SEED_PROMPTS } from "./lib/prompts/agents";
import { applyAgentSkills, applyBuiltinSkills, seedBuiltinSkills } from "./skills";

/**
 * Plan 007: browser-safe agent projection — the same shape `list` has always
 * returned. Credential fields never cross; the boolean flag does.
 */
export function projectAgentDoc(agent: Doc<"agents">) {
  const { llmApiKey, llmApiKeyEnv, ...rest } = agent;
  return { ...rest, llmApiKeyConfigured: Boolean(llmApiKey) };
}

function normalizeCapabilities(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0)
    )
  );
  return normalized.length > 0 ? normalized : undefined;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("agents").collect();
    return docs.map(projectAgentDoc);
  },
});

/**
 * Plan 007 (addendum §1): project membership as a registry read model.
 * Membership lives on `projects.agentIds`; point-read the members so a
 * deleted agent drops out instead of failing the whole list.
 */
export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const docs = await Promise.all(
      (project.agentIds ?? []).map((id) => ctx.db.get(id))
    );
    return docs
      .filter((agent): agent is Doc<"agents"> => agent !== null)
      .map(projectAgentDoc);
  },
});

const OPEN_SUBTASK_STATUSES = new Set([
  "pending",
  "ready",
  "running",
  "waiting_approval",
]);
const OPEN_TASK_STATUSES = new Set(["queued", "running", "needs_approval"]);
const OPEN_EXECUTION_STATUSES = new Set(["running", "queued", "waiting_approval"]);

/**
 * Plan 007 (addendum §1): the full registry view for a project's members —
 * identity, enabled state, runtime availability (`agents.status`, maintained
 * by the worker's execution lifecycle), current task/subtask/execution
 * assignments, and active conversation participation. Membership and
 * assignment stay where they are; this only reads them.
 */
export const getRegistryView = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const docs = await Promise.all(
      (project.agentIds ?? []).map((id) => ctx.db.get(id))
    );
    const members = docs.filter((agent): agent is Doc<"agents"> => agent !== null);

    const [subtasks, tasks] = await Promise.all([
      ctx.db
        .query("subtasks")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect(),
      ctx.db
        .query("tasks")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect(),
    ]);

    return Promise.all(
      members.map(async (agent) => {
        const [executions, participations] = await Promise.all([
          ctx.db
            .query("executions")
            .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
            .collect(),
          ctx.db
            .query("conversationParticipants")
            .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
            .collect(),
        ]);

        const activeConversations = (
          await Promise.all(
            participations.map(async (row) => {
              if (row.leftAt !== undefined) return null;
              const conversation = await ctx.db.get(row.conversationId);
              if (
                !conversation ||
                conversation.projectId !== project._id ||
                conversation.status !== "active"
              ) {
                return null;
              }
              return {
                conversationId: conversation._id,
                title: conversation.title ?? null,
                joinedAt: row.joinedAt,
              };
            })
          )
        ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          ...projectAgentDoc(agent),
          availability: agent.status,
          openExecutions: executions.filter((execution) =>
            OPEN_EXECUTION_STATUSES.has(execution.status)
          ).length,
          assignedSubtasks: subtasks
            .filter(
              (subtask) =>
                subtask.assignedAgentId === agent._id &&
                OPEN_SUBTASK_STATUSES.has(subtask.status)
            )
            .map((subtask) => ({
              subtaskId: subtask._id,
              key: subtask.key,
              title: subtask.title,
              status: subtask.status,
            })),
          assignedTasks: tasks
            .filter(
              (task) =>
                task.assignedAgentIds?.includes(agent._id) &&
                OPEN_TASK_STATUSES.has(task.status)
            )
            .map((task) => ({
              taskId: task._id,
              title: task.title,
              status: task.status,
            })),
          activeConversations,
        };
      })
    );
  },
});

/**
 * Every agent starts with the seed prompt of its role — the same persona
 * text the fixed team ships with (`FIXED_AGENTS`), extended to the legacy
 * roles the fixed team omits. Callers may pass their own systemPrompt to
 * agents.create (the UI prefills this default and lets the user edit it);
 * after creation it stays editable via agents.update.
 */
export function defaultSystemPromptForRole(role: string): string {
  const key = role.trim().toLowerCase();
  const seed = FIXED_AGENTS.find((agent) => agent.role === key);
  if (seed) return seed.systemPrompt;
  if (key === "ui-ux") return LEGACY_UI_UX_PROMPT;
  return GENERIC_AGENT_PROMPT;
}

export const create = mutation({
  args: {
    name: v.string(),
    role: v.string(),
    systemPrompt: v.optional(v.string()),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    supportedTools: v.optional(v.array(v.string())),
    skills: v.optional(v.array(v.string())),
    priority: v.optional(v.number()),
    maxConcurrency: v.optional(v.number()),
    // LLM assignment (Phase 2): optional resolver preference — see schema.
    llmProviderId: v.optional(v.id("llmProviders")),
    llmModelId: v.optional(v.id("llmModels")),
    llmFallbackProviderId: v.optional(v.id("llmProviders")),
    llmFallbackModelId: v.optional(v.id("llmModels")),
    llmSelectionPolicy: v.optional(
      v.union(
        v.literal("fixed"),
        v.literal("priority"),
        v.literal("weighted"),
        v.literal("round_robin")
      )
    ),
    // Avatar picked in the New agent modal (shuffle / template); unset =
    // derived from the name.
    avatarParams: v.optional(v.any()),
    // Library skills prefilled from a template (order = prompt order).
    skillIds: v.optional(v.array(v.id("skills"))),
    executionRuntime: v.optional(v.union(v.literal("api"), v.literal("opencode"))),
    opencodeModel: v.optional(v.string()),
    skillLoading: v.optional(v.union(v.literal("inline"), v.literal("on_demand"))),
  },
  handler: async (ctx, args) => {
    // Agents are a global registry: signed-in viewer or local mode only.
    await assertRegistryWriteAccess(ctx);
    const name = args.name.trim();
    const role = args.role.trim();
    // Every agent starts with a persona: the seed prompt for its role when
    // the caller does not supply one, editable later via agents.update.
    const systemPrompt = args.systemPrompt?.trim() || defaultSystemPromptForRole(role);
    if (!name) throw new Error("Agent name is required");
    if (!role) throw new Error("Agent role is required");
    const skillIds = Array.from(new Set(args.skillIds ?? []));
    for (const id of skillIds) {
      if (!(await ctx.db.get(id))) throw new Error("Skill not found");
    }
    const opencodeModel =
      args.opencodeModel !== undefined ? normalizeOpencodeModel(args.opencodeModel) : undefined;

    const agentId = await ctx.db.insert("agents", {
      name,
      role,
      ...(systemPrompt ? { systemPrompt } : {}),
      status: "idle",
      avatarParams: args.avatarParams ?? defaultAvatarParams(name),
      ...(args.skillLoading === "on_demand" ? { skillLoading: "on_demand" as const } : {}),
      ...(args.executionRuntime ? { executionRuntime: args.executionRuntime } : {}),
      ...(opencodeModel ? { opencodeModel } : {}),
      ...(args.description?.trim() ? { description: args.description.trim() } : {}),
      ...(normalizeCapabilities(args.capabilities)
        ? { capabilities: normalizeCapabilities(args.capabilities) }
        : {}),
      ...(normalizeCapabilities(args.supportedTools)
        ? { supportedTools: normalizeCapabilities(args.supportedTools) }
        : {}),
      ...(normalizeCapabilities(args.skills)
        ? { skills: normalizeCapabilities(args.skills) }
        : {}),
      isEnabled: true,
      priority: args.priority ?? 0,
      maxConcurrency: args.maxConcurrency ?? 1,
      ...(args.llmProviderId ? { llmProviderId: args.llmProviderId } : {}),
      ...(args.llmModelId ? { llmModelId: args.llmModelId } : {}),
      ...(args.llmFallbackProviderId
        ? { llmFallbackProviderId: args.llmFallbackProviderId }
        : {}),
      ...(args.llmFallbackModelId ? { llmFallbackModelId: args.llmFallbackModelId } : {}),
      ...(args.llmSelectionPolicy ? { llmSelectionPolicy: args.llmSelectionPolicy } : {}),
    });
    if (skillIds.length) {
      // Skill v2: required skills come along with the template's skills.
      const created = await ctx.db.get(agentId);
      if (created) await applyAgentSkills(ctx, created, skillIds.map(String));
    }
    await recordAudit(ctx, {
      action: "agent.create",
      target: `${name} (${role})`,
      details: { fields: setFields(args) },
    });
    return agentId;
  },
});

export const update = mutation({
  args: {
    agentId: v.id("agents"),
    name: v.string(),
    role: v.string(),
    systemPrompt: v.string(),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    supportedTools: v.optional(v.array(v.string())),
    skills: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    maxConcurrency: v.optional(v.number()),
    avatarParams: v.optional(v.any()),
    // LLM assignment: pass an id to set, null to clear, omit to leave as-is.
    llmProviderId: v.optional(v.union(v.id("llmProviders"), v.null())),
    llmModelId: v.optional(v.union(v.id("llmModels"), v.null())),
    llmFallbackProviderId: v.optional(v.union(v.id("llmProviders"), v.null())),
    llmFallbackModelId: v.optional(v.union(v.id("llmModels"), v.null())),
    llmSelectionPolicy: v.optional(
      v.union(
        v.literal("fixed"),
        v.literal("priority"),
        v.literal("weighted"),
        v.literal("round_robin"),
        v.null()
      )
    ),
    // Execution runtime: a value sets it, null clears it (global default),
    // omit leaves it as-is. Same contract for the OpenCode model.
    executionRuntime: v.optional(v.union(v.literal("api"), v.literal("opencode"), v.null())),
    opencodeModel: v.optional(v.union(v.string(), v.null())),
    // Skill v2: "inline" (default) | "on_demand"; null resets to inline.
    skillLoading: v.optional(v.union(v.literal("inline"), v.literal("on_demand"), v.null())),
  },
  handler: async (ctx, args) => {
    // Same authz choke point as the other modules (authz.assertAgentAccess):
    // validates the target before any mutation. Agents are global (no
    // owner), so in local mode this changes nothing beyond a clear
    // "Agent not found" error (spec §9.2 consistency).
    const before = await assertAgentAccess(ctx, args.agentId);
    const name = args.name.trim();
    const role = args.role.trim();
    if (!name) throw new Error("Agent name is required");
    if (!role) throw new Error("Agent role is required");
    const patch = {
      name,
      role,
      systemPrompt: args.systemPrompt.trim() || undefined,
      ...(args.avatarParams ? { avatarParams: args.avatarParams } : {}),
      ...(args.description !== undefined
        ? { description: args.description.trim() || undefined }
        : {}),
      ...(args.capabilities !== undefined
        ? { capabilities: normalizeCapabilities(args.capabilities) }
        : {}),
      ...(args.supportedTools !== undefined
        ? { supportedTools: normalizeCapabilities(args.supportedTools) }
        : {}),
      ...(args.skills !== undefined
        ? { skills: normalizeCapabilities(args.skills) }
        : {}),
      ...(args.isEnabled !== undefined ? { isEnabled: args.isEnabled } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.maxConcurrency !== undefined
        ? { maxConcurrency: Math.max(1, Math.floor(args.maxConcurrency)) }
        : {}),
      ...(args.llmProviderId !== undefined
        ? { llmProviderId: args.llmProviderId ?? undefined }
        : {}),
      ...(args.llmModelId !== undefined ? { llmModelId: args.llmModelId ?? undefined } : {}),
      ...(args.llmFallbackProviderId !== undefined
        ? { llmFallbackProviderId: args.llmFallbackProviderId ?? undefined }
        : {}),
      ...(args.llmFallbackModelId !== undefined
        ? { llmFallbackModelId: args.llmFallbackModelId ?? undefined }
        : {}),
      ...(args.llmSelectionPolicy !== undefined
        ? { llmSelectionPolicy: args.llmSelectionPolicy ?? undefined }
        : {}),
      ...(args.executionRuntime !== undefined
        ? { executionRuntime: args.executionRuntime ?? undefined }
        : {}),
      ...(args.opencodeModel !== undefined
        ? { opencodeModel: normalizeOpencodeModel(args.opencodeModel) }
        : {}),
      ...(args.skillLoading !== undefined
        ? { skillLoading: args.skillLoading === "on_demand" ? ("on_demand" as const) : undefined }
        : {}),
    };
    await ctx.db.patch(args.agentId, patch);
    const changed = changedFields(before as Record<string, unknown>, patch);
    if (changed.length) {
      await recordAudit(ctx, {
        action: "agent.update",
        target: `${name} (${role})`,
        details: { changed },
      });
    }
  },
});

/**
 * Library skills attached to an agent, in prompt order. Replaces the whole
 * list; unknown ids are rejected, duplicates dropped, empty clears it.
 */
export const setSkills = mutation({
  args: { agentId: v.id("agents"), skillIds: v.array(v.id("skills")) },
  handler: async (ctx, args): Promise<{ skillIds: Id<"skills">[]; warnings: string[] }> => {
    const agent = await assertAgentAccess(ctx, args.agentId);
    const ids = Array.from(new Set(args.skillIds));
    for (const id of ids) {
      if (!(await ctx.db.get(id))) throw new Error("Skill not found");
    }
    // Skill v2: required skills come along (warned), removing one another
    // attached skill requires warns, permission gaps warn. Nothing grants tools.
    return await applyAgentSkills(ctx, agent, ids.map(String));
  },
});

/**
 * OpenCode model ids are `provider/model` (the model part may itself hold
 * slashes, e.g. `openrouter/anthropic/claude`). Empty/null clears it.
 * Exported for tests.
 */
export function normalizeOpencodeModel(value: string | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200 || !/^[A-Za-z0-9._-]+\/[^\s]+$/.test(trimmed)) {
    throw new Error('OpenCode model must look like "provider/model"');
  }
  return trimmed;
}

export const remove = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const agent = await assertAgentAccess(ctx, args.agentId);
    const projects = await ctx.db.query("projects").collect();
    for (const project of projects) {
      if (!project.agentIds?.includes(args.agentId)) continue;
      await ctx.db.patch(project._id, {
        agentIds: project.agentIds.filter((id) => id !== args.agentId),
      });
    }
    await ctx.db.delete(args.agentId);
    await recordAudit(ctx, { action: "agent.remove", target: `${agent.name} (${agent.role})` });
  },
});

/**
 * Team panel detail: one agent joined with its role definition, assigned
 * projects (via `projects.agentIds`), project assignments (`projectAgents`
 * incl. allowed tools), open assigned tasks, and effective capabilities.
 * Status/assigned-task display still comes from `executionView.activeByAgent`
 * on the client — this query is the registry side of the panel.
 */
export const getDetail = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const agent = await assertAgentAccess(ctx, args.agentId);

    const roleDefinition = agent.roleId
      ? await ctx.db.get(agent.roleId)
      : (
          await ctx.db
            .query("roleDefinitions")
            .withIndex("by_key", (q) => q.eq("key", agent.role.trim().toLowerCase()))
            .take(1)
        )[0] ?? null;

    const projects = await ctx.db.query("projects").collect();
    const assignedProjects = projects
      .filter((project) => project.agentIds?.includes(agent._id))
      .map((project) => ({ projectId: project._id, name: project.name }));

    const assignments = await ctx.db
      .query("projectAgents")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .collect();
    const projectAssignments = assignments.map((row) => ({
      projectId: row.projectId,
      enabled: row.enabled,
      allowedTools: row.allowedTools ?? null,
      customInstructions: row.customInstructions ?? null,
    }));

    const allOpenTasks = (
      await Promise.all(
        (["queued", "running", "needs_approval"] as const).map((status) =>
          ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", status)).collect()
        )
      )
    ).flat();
    const assignedTasks = allOpenTasks
      .filter((task) => task.assignedAgentIds?.includes(agent._id))
      .map((task) => ({ taskId: task._id, title: task.title, status: task.status, projectId: task.projectId }));

    const effectiveCapabilities = Array.from(
      new Set([...(agent.capabilities ?? []), ...(roleDefinition?.capabilities ?? [])])
    );
    const effectiveTools = agent.supportedTools ?? roleDefinition?.defaultTools ?? [];
    const toolsAreCustom = agent.supportedTools !== undefined;

    return {
      agent: projectAgentDoc(agent),
      roleDefinition,
      assignedProjects,
      projectAssignments,
      assignedTasks,
      effectiveCapabilities,
      effectiveTools,
      toolsAreCustom,
    };
  },
});

/**
 * Recent executions for one agent, newest first, with the task title
 * resolved. Used by the team detail panel's history section.
 */
export const getExecutionHistory = query({
  args: { agentId: v.id("agents"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertAgentAccess(ctx, args.agentId);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 20), 1), 100);
    const rows = await ctx.db
      .query("executions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(limit);
    return Promise.all(
      rows.map(async (row) => {
        const task = await ctx.db.get(row.taskId);
        return {
          executionId: row._id,
          taskId: row.taskId,
          taskTitle: task?.title ?? null,
          subtaskKey: row.subtaskKey ?? null,
          capability: row.capability,
          status: row.status,
          attempt: row.attempt,
          startedAt: row.startedAt ?? null,
          completedAt: row.completedAt ?? null,
          createdAt: row.createdAt,
          error: row.error ?? null,
        };
      })
    );
  },
});

/** The fixed team seed, derived from the shared role definitions. */
export const FIXED_AGENTS = FIXED_TEAM_SEED_ORDER.map((key) => {
  const role = ROLES[key];
  return {
    key: role.key,
    name: role.label,
    role: role.key,
    description: role.description,
    systemPrompt: AGENT_SEED_PROMPTS[role.defaultPromptKey],
    capabilities: [...role.capabilities],
    supportedTools: [...role.defaultTools],
    priority: role.priority,
    maxConcurrency: role.maxConcurrency,
  };
});

/**
 * Plan 040: the row's tools after adding this role's newly added defaults
 * and removing its revoked ones, or null when nothing changes. A row with
 * no stored tools list keeps relying on the role defaults.
 */
export function syncedTools(current: readonly string[] | undefined, role: string): string[] | null {
  if (!current) return null;
  const revoked = new Set(REVOKED_DEFAULT_TOOLS[role] ?? []);
  const next = Array.from(new Set([...current, ...(ADDED_DEFAULT_TOOLS[role] ?? [])])).filter(
    (tool) => !revoked.has(tool)
  );
  const same = next.length === current.length && next.every((tool, index) => tool === current[index]);
  return same ? null : next;
}

/**
 * Sync the fixed team: seed missing roles, union new default capabilities
 * into existing rows, and retire removed roles exactly once.
 *
 * - Prompts/descriptions are only filled when empty, so edits made in the
 *   UI are never overwritten.
 * - Retired agents are disabled once and stamped with `retiredAt`; a later
 *   manual re-enable sticks.
 */
export async function syncFixedTeam(ctx: MutationCtx, projectId?: Id<"projects">) {
  const existingAgents = await ctx.db.query("agents").collect();

  const retiredIds = new Set<string>();
  for (const agent of existingAgents) {
    if (!isRetiredRole(agent.role)) continue;
    if (agent.retiredAt) continue;
    retiredIds.add(String(agent._id));
    await ctx.db.patch(agent._id, { isEnabled: false, status: "idle", retiredAt: Date.now() });
  }

  const createdAgentIds: Id<"agents">[] = [];
  for (const def of FIXED_AGENTS) {
    const match = existingAgents.find(
      (a) => normalizeRoleKey(a.role) === def.role && !isRetiredRole(a.role)
    );
    if (!match) {
      const id = await ctx.db.insert("agents", {
        name: def.name,
        role: def.role,
        description: def.description,
        systemPrompt: def.systemPrompt,
        capabilities: def.capabilities,
        supportedTools: def.supportedTools,
        status: "idle",
        avatarParams: defaultAvatarParams(def.name),
        isEnabled: true,
        priority: def.priority,
        maxConcurrency: def.maxConcurrency,
      });
      createdAgentIds.push(id);
      continue;
    }
    createdAgentIds.push(match._id);
    const current = match.capabilities ?? [];
    const revoked = new Set(REVOKED_DEFAULT_CAPABILITIES[def.role] ?? []);
    const merged = Array.from(new Set([...current, ...def.capabilities])).filter(
      (capability) => !revoked.has(capability)
    );
    const patch: Partial<Doc<"agents">> = {};
    const sameCaps =
      merged.length === current.length && merged.every((capability, index) => capability === current[index]);
    if (!sameCaps) patch.capabilities = merged;
    if (!match.description?.trim()) patch.description = def.description;
    if (!match.systemPrompt?.trim()) patch.systemPrompt = def.systemPrompt;
    // Plan 040 (D10): a prompt still EXACTLY equal to an earlier seed was
    // never edited, so it follows the new seed. Edited prompts never change.
    else if (
      match.systemPrompt !== def.systemPrompt &&
      (PREVIOUS_SEED_PROMPTS[def.role] ?? []).includes(match.systemPrompt)
    ) {
      patch.systemPrompt = def.systemPrompt;
    }
    // Plan 040: tools. Only the listed new defaults are added and only the
    // listed revoked ones removed; a user's own tool choices stay.
    const tools = syncedTools(match.supportedTools, def.role);
    if (tools) patch.supportedTools = tools;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(match._id, patch);
      await recordAudit(ctx, {
        action: "agent.sync",
        actor: "system",
        target: match.name,
        details: { changed: Object.keys(patch).sort(), reason: "fixed-team sync" },
      });
    }
  }

  // Built-in skills: seed the Library once, then attach each role's
  // defaults once per enabled fixed-team agent.
  const seeded = await seedBuiltinSkills(ctx);
  for (const agentId of createdAgentIds) {
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.isEnabled === false) continue;
    if (await applyBuiltinSkills(ctx, agent, seeded)) {
      await recordAudit(ctx, {
        action: "agent.builtin_skills",
        actor: "system",
        target: agent.name,
        details: { changed: ["skillIds"], reason: "built-in skills" },
      });
    }
  }

  if (projectId) {
    const project = await ctx.db.get(projectId);
    if (project) {
      const retiredAll = new Set(
        existingAgents.filter((a) => isRetiredRole(a.role)).map((a) => String(a._id))
      );
      const kept = (project.agentIds ?? []).filter((id) => !retiredAll.has(String(id)));
      const combined = Array.from(new Set([...kept, ...createdAgentIds]));
      await ctx.db.patch(project._id, { agentIds: combined });
    }
  }

  return { total: FIXED_AGENTS.length, agentIds: createdAgentIds, retired: retiredIds.size };
}

export const ensureFixedTeam = mutation({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    // The sync seeds, patches and retires rows in the GLOBAL agent table,
    // so it needs registry write access even when a project is given.
    await assertRegistryWriteAccess(ctx);
    if (args.projectId) await assertProjectAccess(ctx, args.projectId);
    return await syncFixedTeam(ctx, args.projectId);
  },
});


/** Worker startup hook: apply the fixed-team sync to existing data once per boot. */
export const syncFixedTeamInternal = internalMutation({
  args: {},
  handler: async (ctx) => await syncFixedTeam(ctx),
});
