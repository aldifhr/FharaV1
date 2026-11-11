import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertConversationAccess,
  assertProjectAccess,
  assertRegistryWriteAccess,
  getViewerId,
} from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { conversationKind, conversationShapeError, isPersonalConversation } from "./lib/conversationShape";
import { projectTeamIds } from "./lib/projectTeam";

/**
 * Plan 007 (addendum §2): conversation participation as a persisted concept,
 * independent of project membership (`projects.agentIds`) and task assignment
 * (`tasks.assignedAgentIds` / `subtasks.assignedAgentId`).
 *
 * A participant must be a project member and enabled — the same gate the chat
 * engine applied per-request before this table existed. Leaving is a soft
 * delete (`leftAt`) so participation history survives.
 */

type Ctx = QueryCtx | MutationCtx;
type WriteCtx = MutationCtx;
type AgentDoc = Doc<"agents">;

/**
 * Default chat selection, preserved verbatim from the pre-Plan-007
 * `chatContext.getContext` (and mirrored by
 * `packages/worker/tests/chatAndTasks.test.ts`): explicit selection first,
 * then CTO (the planning authority answers chat and drafts the plan).
 */
export function selectDefaultChatAgents(
  projectAgentIds: Id<"agents">[] | undefined,
  allAgents: AgentDoc[],
  preferredAgentIds?: Id<"agents">[]
): AgentDoc[] {
  const hasTeam = Boolean(projectAgentIds && projectAgentIds.length > 0);
  const inProject = hasTeam
    ? allAgents.filter((a) => projectAgentIds!.includes(a._id))
    : [];
  const enabled = inProject.filter((a) => a.isEnabled !== false);

  const preferred = preferredAgentIds?.length
    ? enabled.filter((a) => preferredAgentIds.includes(a._id))
    : [];

  if (preferred.length > 0) return preferred;
  if (enabled.length > 0) {
    return [pickConversationalAgent(enabled)];
  }
  return [];
}

/** One conversational agent (plan 016): CTO first — as decision-maker,
 * the CTO drafts chat replies and the execution plan. */
function pickConversationalAgent(agents: AgentDoc[]): AgentDoc {
  const cto = agents.find((a) => /^cto$/i.test(a.role));
  if (cto) return cto;
  const general = agents.find((a) => /^(general|assistant)/i.test(a.role));
  if (general) return general;
  const researcher = agents.find((a) => /^researcher/i.test(a.role));
  if (researcher) return researcher;
  const support = agents.find((a) => /^support/i.test(a.role));
  if (support) return support;
  return agents[0];
}

/** Active (not left) participant rows of a conversation, oldest join first. */
export async function activeParticipantRows(
  ctx: Ctx,
  conversationId: Id<"conversations">
): Promise<Doc<"conversationParticipants">[]> {
  const rows = await ctx.db
    .query("conversationParticipants")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  return rows.filter((row) => row.leftAt === undefined);
}

/** Point-read the project team; deleted agents drop out silently. */
async function loadTeamAgents(ctx: Ctx, project: Doc<"projects">): Promise<AgentDoc[]> {
  const docs = await Promise.all(
    (await projectTeamIds(ctx, project)).map((id) => ctx.db.get(id))
  );
  return docs.filter((a): a is AgentDoc => a !== null);
}

/** Membership + enabled gate. Throws for explicit add/remove; the sync path filters instead. */
function assertAssignable(agent: AgentDoc | null, teamIds: readonly Id<"agents">[]): void {
  if (!agent) throw new Error("Agent not found");
  if (agent.isEnabled === false) {
    throw new Error(`Agent ${agent.name} is disabled`);
  }
  if (!teamIds.includes(agent._id)) {
    throw new Error(`Agent ${agent.name} is not a member of this project's team`);
  }
}

/**
 * Make the participant set exactly `desiredAgentIds` (deduped, member + enabled
 * only): insert missing, rejoin left rows, and soft-leave rows not desired.
 * Idempotent — safe to call on every chat send.
 */
async function syncParticipants(
  ctx: WriteCtx,
  conversationId: Id<"conversations">,
  project: Doc<"projects">,
  team: AgentDoc[],
  desiredAgentIds: Id<"agents">[]
): Promise<void> {
  const assignable = new Map(
    team.filter((a) => a.isEnabled !== false).map((a) => [a._id, a])
  );
  const desired = Array.from(new Set(desiredAgentIds)).filter((id) =>
    assignable.has(id)
  );

  const existing = await ctx.db
    .query("conversationParticipants")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  const now = Date.now();
  const desiredSet = new Set(desired);

  for (const row of existing) {
    if (desiredSet.has(row.agentId)) {
      if (row.leftAt !== undefined) {
        await ctx.db.patch(row._id, { leftAt: undefined });
      }
    } else if (row.leftAt === undefined) {
      await ctx.db.patch(row._id, { leftAt: now });
    }
  }

  const present = new Set(existing.map((row) => row.agentId));
  for (const agentId of desired) {
    if (present.has(agentId)) continue;
    await ctx.db.insert("conversationParticipants", {
      conversationId,
      projectId: project._id,
      agentId,
      joinedAt: now,
    });
  }
}

/** The project's active conversation with the most recent activity, if any. */
async function findActiveConversation(
  ctx: Ctx,
  projectId: Id<"projects">
): Promise<Doc<"conversations"> | null> {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_project_and_status", (q) =>
      q.eq("projectId", projectId).eq("status", "active")
    )
    .collect()
    // Plan 039: a personal conversation attached to this project is never
    // "the project's active conversation" (project chat must not post into it).
    .then((all) => all.filter((row) => !isPersonalConversation(row)));
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) =>
    (row.lastMessageAt ?? row.createdAt) >= (latest.lastMessageAt ?? latest.createdAt)
      ? row
      : latest
  );
}

/**
 * Chat-engine entry point: resolve (or create) the project's active
 * conversation and sync the caller's selection into it. An explicit selection
 * replaces the participant set; with no selection the existing participants
 * stand, and a conversation with none seeds the default selection.
 */
export const ensureForChat = internalMutation({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => ensureChatConversation(ctx, args),
});

/** ensureForChat's logic, callable inside another mutation (messages.send). */
export async function ensureChatConversation(
  ctx: MutationCtx,
  args: { projectId: Id<"projects">; conversationId?: Id<"conversations">; preferredAgentIds?: Id<"agents">[] }
): Promise<Id<"conversations">> {
  const project = await ctx.db.get(args.projectId);
  if (!project) throw new Error("Project not found");

  let conversation = args.conversationId
    ? await ctx.db.get(args.conversationId)
    : null;
  if (conversation && isPersonalConversation(conversation)) {
    throw new Error("Use the personal chat for this conversation");
  }
  if (conversation && conversation.projectId !== args.projectId) {
    throw new Error("Conversation does not belong to this project");
  }
  if (!conversation) {
    conversation = await findActiveConversation(ctx, args.projectId);
  }
  if (!conversation) {
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      projectId: args.projectId,
      kind: "project",
      status: "active",
      createdAt: now,
      lastMessageAt: now,
    });
    conversation = (await ctx.db.get(id))!;
  }

  const team = await loadTeamAgents(ctx, project);
  const active = await activeParticipantRows(ctx, conversation._id);

  if (args.preferredAgentIds?.length) {
    await syncParticipants(
      ctx,
      conversation._id,
      project,
      team,
      args.preferredAgentIds
    );
  } else if (active.length === 0) {
    const seeded = selectDefaultChatAgents(team.map((a) => a._id), team);
    await syncParticipants(
      ctx,
      conversation._id,
      project,
      team,
      seeded.map((a) => a._id)
    );
  } else {
    // Migrate legacy default (Researcher/Support) to CTO once.
    const teamById = new Map(team.map((a) => [String(a._id), a]));
    const activeAgents = active
      .map((row) => teamById.get(String(row.agentId)))
      .filter(Boolean) as AgentDoc[];
    const isLegacyDefault = activeAgents.every((a) =>
      /^(researcher|support|general|assistant)$/i.test(a.role)
    );
    const cto = team.find((a) => /^cto$/i.test(a.role));
    if (isLegacyDefault && cto && !activeAgents.some((a) => /^cto$/i.test(a.role))) {
      await syncParticipants(ctx, conversation._id, project, team, [cto._id]);
    }
  }
  return conversation._id;
}

/**
 * The project of a project/team conversation, after the access check.
 * Participant edits do not apply to a personal conversation: its one
 * participant is its agent, fixed at creation.
 */
async function projectConversationProject(
  ctx: Ctx,
  conversation: Doc<"conversations">
): Promise<Doc<"projects">> {
  if (isPersonalConversation(conversation)) {
    throw new Error("A personal conversation has exactly one agent");
  }
  const { project } = await assertConversationAccess(ctx, conversation);
  if (!project) throw new Error("Conversation has no project");
  return project;
}

/** Shape the browser may see: identity + live state, never credentials. */
function participantView(
  agent: AgentDoc,
  joinedAt: number
) {
  return {
    agentId: agent._id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    avatarParams: agent.avatarParams,
    isEnabled: agent.isEnabled !== false,
    joinedAt,
  };
}

export const getActive = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const conversation = await findActiveConversation(ctx, project._id);
    if (!conversation) return null;

    const rows = await activeParticipantRows(ctx, conversation._id);
    const agents = await Promise.all(rows.map((row) => ctx.db.get(row.agentId)));
    const participants = rows.flatMap((row, index) => {
      const agent = agents[index];
      return agent ? [participantView(agent, row.joinedAt)] : [];
    });
    return { conversation, participants };
  },
});

export const getParticipants = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];
    await assertConversationAccess(ctx, conversation);
    const rows = await activeParticipantRows(ctx, conversation._id);
    const agents = await Promise.all(rows.map((row) => ctx.db.get(row.agentId)));
    return rows.flatMap((row, index) => {
      const agent = agents[index];
      return agent ? [participantView(agent, row.joinedAt)] : [];
    });
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(50);
    return Promise.all(
      rows.filter((row) => !isPersonalConversation(row)).map(async (conversation) => {
        const active = await activeParticipantRows(ctx, conversation._id);
        return { ...conversation, activeParticipantCount: active.length };
      })
    );
  },
});

export const setParticipants = mutation({
  args: {
    conversationId: v.id("conversations"),
    agentIds: v.array(v.id("agents")),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const project = await projectConversationProject(ctx, conversation);
    const team = await loadTeamAgents(ctx, project);
    await syncParticipants(ctx, conversation._id, project, team, args.agentIds);
    return conversation._id;
  },
});

export const addParticipant = mutation({
  args: {
    conversationId: v.id("conversations"),
    agentId: v.id("agents"),
  },
  handler: async (ctx, args): Promise<Id<"conversationParticipants">> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const project = await projectConversationProject(ctx, conversation);
    const agent = await ctx.db.get(args.agentId);
    assertAssignable(agent, await projectTeamIds(ctx, project));

    const rows = await ctx.db
      .query("conversationParticipants")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    const existing = rows.find((row) => row.agentId === args.agentId);
    if (existing) {
      if (existing.leftAt !== undefined) {
        await ctx.db.patch(existing._id, { leftAt: undefined });
      }
      return existing._id;
    }
    return await ctx.db.insert("conversationParticipants", {
      conversationId: conversation._id,
      projectId: project._id,
      agentId: args.agentId,
      joinedAt: Date.now(),
    });
  },
});

export const removeParticipant = mutation({
  args: {
    conversationId: v.id("conversations"),
    agentId: v.id("agents"),
  },
  handler: async (ctx, args): Promise<Id<"conversationParticipants"> | null> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    await projectConversationProject(ctx, conversation);
    const rows = await ctx.db
      .query("conversationParticipants")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    const row = rows.find(
      (candidate) => candidate.agentId === args.agentId && candidate.leftAt === undefined
    );
    if (!row) return null;
    await ctx.db.patch(row._id, { leftAt: Date.now() });
    return row._id;
  },
});

export const closeConversation = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    await assertConversationAccess(ctx, conversation);
    await ctx.db.patch(conversation._id, {
      status: "closed",
      updatedAt: Date.now(),
    });
    return conversation._id;
  },
});

/**
 * Clear the project's chat: delete every message in the project — the
 * conversation messages (the same set `chatContext.getContext` feeds the
 * LLM, so this also resets the model's memory of the chat) and the
 * task-linked report messages, so the timeline is empty. Pinned messages
 * are kept. Task rows and their non-message history (subtasks, approvals,
 * file changes, …) are kept. The active conversation is closed and its
 * participants soft-left, so the next send starts a fresh thread. Returns
 * how many messages were deleted.
 */
export const clearChat = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deletedMessages: number }> => {
    const project = await assertProjectAccess(ctx, args.projectId);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    let deleted = 0;
    for (const message of messages) {
      if (message.pinned === true) continue;
      await ctx.db.delete(message._id);
      deleted += 1;
    }

    const now = Date.now();
    const activeConversations = await ctx.db
      .query("conversations")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", project._id).eq("status", "active")
      )
      .collect();
    for (const conversation of activeConversations) {
      // Plan 039: an attached personal chat is not the project's chat.
      if (isPersonalConversation(conversation)) continue;
      await ctx.db.patch(conversation._id, {
        status: "closed",
        updatedAt: now,
      });
      const rows = await ctx.db
        .query("conversationParticipants")
        .withIndex("by_conversation", (q) =>
          q.eq("conversationId", conversation._id)
        )
        .collect();
      for (const row of rows) {
        if (row.leftAt === undefined) {
          await ctx.db.patch(row._id, { leftAt: now });
        }
      }
    }

    return { deletedMessages: deleted };
  },
});

// ---------------------------------------------------------------------------
// Personal chat (plan 039, PC2): one conversation per agent, no project.
// ---------------------------------------------------------------------------

/** An agent that can hold a personal chat: exists, enabled, not retired. */
async function loadPersonalAgent(ctx: Ctx, agentId: Id<"agents">): Promise<AgentDoc> {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error("Agent not found");
  if (agent.isEnabled === false) throw new Error(`Agent ${agent.name} is disabled`);
  if (agent.retiredAt !== undefined) throw new Error(`Agent ${agent.name} is retired`);
  return agent;
}

/** The caller may use personal chat at all (local mode or signed in). */
async function assertPersonalChatAccess(ctx: Ctx): Promise<string | null> {
  const viewerId = await getViewerId(ctx);
  if (!viewerId) await assertRegistryWriteAccess(ctx);
  return viewerId;
}

/** The active personal conversation of (agent, owner), newest first. */
async function findActivePersonal(
  ctx: Ctx,
  agentId: Id<"agents">,
  ownerId: string | null
): Promise<Doc<"conversations"> | null> {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_agent_kind_status", (q) =>
      q.eq("agentId", agentId).eq("kind", "personal").eq("status", "active")
    )
    .collect();
  const mine = rows.filter((row) => (row.ownerId ?? null) === ownerId);
  if (mine.length === 0) return null;
  return mine.reduce((latest, row) => (row.createdAt >= latest.createdAt ? row : latest));
}

async function insertPersonal(
  ctx: WriteCtx,
  agent: AgentDoc,
  ownerId: string | null
): Promise<Id<"conversations">> {
  const now = Date.now();
  const row = {
    kind: "personal" as const,
    agentId: agent._id,
    ...(ownerId ? { ownerId } : {}),
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const shapeError = conversationShapeError(row);
  if (shapeError) throw new Error(shapeError);
  const id = await ctx.db.insert("conversations", row);
  // Exactly one participant: the agent (getParticipants keeps working).
  await ctx.db.insert("conversationParticipants", {
    conversationId: id,
    agentId: agent._id,
    joinedAt: now,
  });
  return id;
}

/**
 * Get or create the active personal conversation with one agent.
 * Idempotent: a refresh or a double call returns the same row (Convex
 * mutations are serializable, so two racing creates resolve to one).
 */
export const getOrCreatePersonal = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    const ownerId = await assertPersonalChatAccess(ctx);
    const agent = await loadPersonalAgent(ctx, args.agentId);
    const existing = await findActivePersonal(ctx, agent._id, ownerId);
    if (existing) return existing._id;
    return await insertPersonal(ctx, agent, ownerId);
  },
});

/** "New chat": close the active personal conversation and open a fresh one. */
export const startNewPersonal = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    const ownerId = await assertPersonalChatAccess(ctx);
    const agent = await loadPersonalAgent(ctx, args.agentId);
    const existing = await findActivePersonal(ctx, agent._id, ownerId);
    if (existing) {
      await ctx.db.patch(existing._id, { status: "closed", updatedAt: Date.now() });
    }
    return await insertPersonal(ctx, agent, ownerId);
  },
});

/**
 * Personal chat list: every enabled, non-retired agent with its active
 * personal conversation (if any), last activity and a short preview.
 */
export const listPersonal = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await assertPersonalChatAccess(ctx);
    const agents = (await ctx.db.query("agents").collect()).filter(
      (a) => a.isEnabled !== false && a.retiredAt === undefined
    );
    const rows = await Promise.all(
      agents.map(async (agent) => {
        const conversation = await findActivePersonal(ctx, agent._id, ownerId);
        let preview: string | null = null;
        if (conversation) {
          const last = await ctx.db
            .query("messages")
            .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
            .order("desc")
            .first();
          preview = last ? last.content.replace(/\s+/g, " ").trim().slice(0, 120) || null : null;
        }
        const project = conversation?.projectId ? await ctx.db.get(conversation.projectId) : null;
        return {
          agent: {
            _id: agent._id,
            name: agent.name,
            role: agent.role,
            status: agent.status,
            avatarParams: agent.avatarParams,
          },
          conversationId: conversation?._id ?? null,
          lastMessageAt: conversation ? (conversation.lastMessageAt ?? null) : null,
          preview,
          projectName: project?.name ?? null,
        };
      })
    );
    // Recent conversations first, then agents with no chat yet by name.
    return rows.sort((a, b) => {
      const at = a.lastMessageAt ?? 0;
      const bt = b.lastMessageAt ?? 0;
      if (at !== bt) return bt - at;
      return a.agent.name.localeCompare(b.agent.name);
    });
  },
});

/** One conversation's header data, after the access check. */
export const get = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;
    const { project } = await assertConversationAccess(ctx, conversation);
    const agent = conversation.agentId ? await ctx.db.get(conversation.agentId) : null;
    const rows = await activeParticipantRows(ctx, conversation._id);
    const agents = await Promise.all(rows.map((row) => ctx.db.get(row.agentId)));
    const participants = rows.flatMap((row, index) => {
      const a = agents[index];
      return a ? [participantView(a, row.joinedAt)] : [];
    });
    return {
      _id: conversation._id,
      kind: conversationKind(conversation),
      status: conversation.status,
      agent: agent ? participantView(agent, conversation.createdAt) : null,
      project: project ? { _id: project._id, name: project.name } : null,
      projectAttachedAt: conversation.projectAttachedAt ?? null,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt ?? null,
      participants,
    };
  },
});

/**
 * Attach a project to a personal chat (plan 039 PC4). Once, to a project
 * the caller can access whose team includes the conversation's agent (D2);
 * no detach or switch in v1 (D3). Ids and messages are unchanged and no
 * reply is scheduled: old messages are never re-run. From the next turn on
 * the reply reads project memory, the repo snapshot and read-only repo
 * tools through the conversation row. The client's projectId is only a
 * request: every check runs here.
 */
export const attachProject = mutation({
  args: { conversationId: v.id("conversations"), projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ attached: boolean; projectId: Id<"projects"> }> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    await assertConversationAccess(ctx, conversation);
    if (!isPersonalConversation(conversation)) {
      throw new Error("Only a personal chat can be attached to a project");
    }
    if (conversation.status !== "active") throw new Error("This chat is closed. Start a new chat.");
    if (conversation.projectId === args.projectId) return { attached: false, projectId: args.projectId };
    if (conversation.projectId) {
      const current = await ctx.db.get(conversation.projectId);
      throw new Error(
        `This chat is already attached to ${current?.name ?? "a project"}. Start a new chat to use another project.`
      );
    }
    const project = await assertProjectAccess(ctx, args.projectId);
    const agent = conversation.agentId ? await ctx.db.get(conversation.agentId) : null;
    if (!agent) throw new Error("Agent not found");
    if (agent.isEnabled === false) throw new Error(`Agent ${agent.name} is disabled`);
    if (!(await projectTeamIds(ctx, project)).includes(agent._id)) {
      throw new Error(`Add ${agent.name} to this project's team first`);
    }
    const now = Date.now();
    await ctx.db.patch(conversation._id, { projectId: project._id, projectAttachedAt: now, updatedAt: now });
    const rows = await ctx.db
      .query("conversationParticipants")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    for (const row of rows) await ctx.db.patch(row._id, { projectId: project._id });
    await recordAudit(ctx, {
      action: "conversation.attach_project",
      target: agent.name,
      projectId: project._id,
      details: { conversationId: conversation._id },
    });
    return { attached: true, projectId: project._id };
  },
});

/**
 * Delete a personal chat (plan 039): the conversation row, its messages,
 * participant rows and context summaries. Project chats are refused — this
 * is the personal chat's delete, not a project's. Tasks the chat started
 * keep living on their project board; their `conversationId` dangles, which
 * `taskCardConversationId` treats as "no chat". Messages go first so a
 * reply scheduled before the delete claims nothing and no-ops.
 */
export const removePersonal = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    await assertPersonalChatAccess(ctx);
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return { deleted: false };
    await assertConversationAccess(ctx, conversation);
    if (!isPersonalConversation(conversation)) {
      throw new Error("Only a personal chat can be deleted here");
    }
    const agent = conversation.agentId ? await ctx.db.get(conversation.agentId) : null;
    // One mutation = one transaction: either the whole chat goes or none of it.
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);
    const participants = await ctx.db
      .query("conversationParticipants")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    for (const row of participants) await ctx.db.delete(row._id);
    const summaries = await ctx.db
      .query("contextSummaries")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    for (const row of summaries) await ctx.db.delete(row._id);
    await ctx.db.delete(conversation._id);
    await recordAudit(ctx, {
      action: "conversation.remove_personal",
      target: agent?.name ?? "personal chat",
      details: { conversationId: conversation._id, messages: messages.length },
    });
    return { deleted: true };
  },
});
