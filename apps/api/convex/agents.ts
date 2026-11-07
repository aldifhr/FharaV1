import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { assertAgentAccess, assertProjectAccess } from "./authz";

/**
 * Plan 007: browser-safe agent projection — the same shape `list` has always
 * returned. Credential fields never cross; the boolean flag does.
 */
export function projectAgentDoc(agent: Doc<"agents">) {
  const { llmApiKey, llmApiKeyEnv, ...rest } = agent;
  return { ...rest, llmApiKeyConfigured: Boolean(llmApiKey) };
}

function defaultAvatarParams(name: string) {
  const palettes = ["Black", "Brown", "Blonde", "Red", "PastelPink"];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hairColor = palettes[Math.abs(hash) % palettes.length];
  return {
    avatarStyle: "Circle",
    topType: "ShortHairShortFlat",
    accessoriesType: "Blank",
    hatColor: "Black",
    hairColor,
    facialHairType: "Blank",
    facialHairColor: "Brown",
    clotheType: "ShirtCrewNeck",
    clotheColor: "Blue03",
    eyeType: "Default",
    eyebrowType: "Default",
    mouthType: "Smile",
    skinColor: "Light",
  };
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
      v.union(v.literal("fixed"), v.literal("priority"), v.literal("weighted"))
    ),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const role = args.role.trim();
    const systemPrompt = args.systemPrompt?.trim();
    if (!name) throw new Error("Agent name is required");
    if (!role) throw new Error("Agent role is required");

    return await ctx.db.insert("agents", {
      name,
      role,
      ...(systemPrompt ? { systemPrompt } : {}),
      status: "idle",
      avatarParams: defaultAvatarParams(name),
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
      v.union(v.literal("fixed"), v.literal("priority"), v.literal("weighted"), v.null())
    ),
  },
  handler: async (ctx, args) => {
    // Same authz choke point as the other modules (authz.assertAgentAccess):
    // validates the target before any mutation. Agents are global (no
    // owner), so in local mode this changes nothing beyond a clear
    // "Agent not found" error (spec §9.2 consistency).
    await assertAgentAccess(ctx, args.agentId);
    const name = args.name.trim();
    const role = args.role.trim();
    if (!name) throw new Error("Agent name is required");
    if (!role) throw new Error("Agent role is required");
    await ctx.db.patch(args.agentId, {
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
    });
  },
});

export const remove = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    await assertAgentAccess(ctx, args.agentId);
    const projects = await ctx.db.query("projects").collect();
    for (const project of projects) {
      if (!project.agentIds?.includes(args.agentId)) continue;
      await ctx.db.patch(project._id, {
        agentIds: project.agentIds.filter((id) => id !== args.agentId),
      });
    }
    await ctx.db.delete(args.agentId);
  },
});
