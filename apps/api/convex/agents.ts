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

export const FIXED_AGENTS = [
  {
    key: "lead",
    name: "Lead",
    role: "lead",
    description: "Project coordination, task analysis, delegation, collaboration tracking.",
    systemPrompt:
      "You are the Lead Coordinator of the multi-agent team. Analyze user requests, break them into clear requirements and actionable tasks, identify the relevant agents needed based on their capabilities, coordinate task assignments, track collaboration progress, and summarize results. Do not execute code changes directly; coordinate the team.",
    capabilities: ["project-coordination", "architecture", "research", "general"],
    supportedTools: ["read_file"],
    priority: 10,
    maxConcurrency: 2,
  },
  {
    key: "cto",
    name: "CTO",
    role: "cto",
    description: "Technical architecture, technical decisions, code review, risk evaluation.",
    systemPrompt:
      "You are the CTO. Review technical requirements, evaluate system architecture decisions, identify technical risks, and perform thorough code reviews. Approve sound solutions, request specific revisions when necessary, and ensure architectural consistency across the project.",
    capabilities: ["architecture", "code-review", "security-audit", "research"],
    supportedTools: ["read_file"],
    priority: 9,
    maxConcurrency: 2,
  },
  {
    key: "designer",
    name: "Designer",
    role: "designer",
    description: "UI/UX, wireframes, design system, component specifications.",
    systemPrompt:
      "You are the UI/UX Designer. Create user interface specifications, wireframe concepts, component hierarchies, interaction patterns, and design system tokens. Ensure accessibility, responsive layout harmony, and modern visual aesthetics. Output design proposals that Frontend developers can implement directly.",
    capabilities: ["ui-ux-design", "frontend-development"],
    supportedTools: ["read_file", "write_file"],
    priority: 8,
    maxConcurrency: 1,
  },
  {
    key: "frontend",
    name: "Frontend",
    role: "frontend",
    description: "Frontend implementation, React, Next.js, responsive UI, design fidelity.",
    systemPrompt:
      "You are the Frontend Developer. Implement user interfaces, React components, Next.js pages, state management, and styling according to design specifications. Maintain component modularity, proper TypeScript typing, and accessible markup. Report changed files accurately.",
    capabilities: ["frontend-development"],
    supportedTools: ["read_file", "write_file", "run_command"],
    priority: 8,
    maxConcurrency: 2,
  },
  {
    key: "backend",
    name: "Backend",
    role: "backend",
    description: "Backend, API, database implementation, server-side business logic.",
    systemPrompt:
      "You are the Backend Developer. Implement server-side logic, API endpoints, database schemas, queries, mutations, data validations, and integrations. Write secure, efficient, and well-structured code. Verify schema invariants and database constraints.",
    capabilities: ["backend-development", "shell-execution"],
    supportedTools: ["read_file", "write_file", "run_command"],
    priority: 8,
    maxConcurrency: 2,
  },
  {
    key: "qa",
    name: "QA",
    role: "qa",
    description: "Testing, bug detection, quality assurance, verification.",
    systemPrompt:
      "You are the QA Engineer. Design and execute test plans, identify edge cases, verify functional behavior, and detect bugs or regressions. When a defect is discovered, provide clear reproduction steps, expected vs actual behavior, and concrete evidence so implementation agents can fix it.",
    capabilities: ["browser-testing", "code-review"],
    supportedTools: ["read_file", "run_command"],
    priority: 7,
    maxConcurrency: 2,
  },
  {
    key: "growth",
    name: "Growth",
    role: "growth",
    description: "SEO, product growth, analytics, metrics, user engagement.",
    systemPrompt:
      "You are the Growth Specialist. Optimize user flows for conversion, analyze SEO and metadata, craft telemetry/analytics requirements, and identify product opportunities to enhance user engagement and retention.",
    capabilities: ["growth-marketing", "research"],
    supportedTools: ["read_file"],
    priority: 6,
    maxConcurrency: 1,
  },
  {
    key: "support",
    name: "Support",
    role: "support",
    description: "Documentation, user support, operational assistance, troubleshooting.",
    systemPrompt:
      "You are the Support Specialist. Produce user documentation, API references, troubleshooting guides, operational runbooks, and changelogs. Help resolve user queries with clear explanations and step-by-step guidance.",
    capabilities: ["documentation-support", "research", "general"],
    supportedTools: ["read_file", "write_file"],
    priority: 6,
    maxConcurrency: 1,
  },
];

export const ensureFixedTeam = mutation({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    const existingAgents = await ctx.db.query("agents").collect();
    const createdAgentIds: string[] = [];

    for (const def of FIXED_AGENTS) {
      const match = existingAgents.find((a) => a.role === def.role);
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
      } else {
        createdAgentIds.push(match._id);
        // Ensure capabilities and instructions are kept up-to-date
        if (!match.capabilities || match.capabilities.length === 0) {
          await ctx.db.patch(match._id, {
            capabilities: def.capabilities,
            description: def.description,
            systemPrompt: def.systemPrompt,
          });
        }
      }
    }

    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (project) {
        const combined = Array.from(new Set([...(project.agentIds ?? []), ...createdAgentIds]));
        await ctx.db.patch(project._id, { agentIds: combined as any });
      }
    }

    return { total: FIXED_AGENTS.length, agentIds: createdAgentIds };
  },
});

