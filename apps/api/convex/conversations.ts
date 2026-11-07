import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./authz";

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

const LEAD_ROLE = /orchestrator|planner|manager|cto|lead|architect/i;

/**
 * Default chat selection, preserved verbatim from the pre-Plan-007
 * `chatContext.getContext` (and mirrored by
 * `packages/worker/tests/chatAndTasks.test.ts`): explicit selection first,
 * then the lead by role, then the first enabled member. An empty team never
 * falls back to global agents.
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
    const lead = enabled.find((a) => LEAD_ROLE.test(a.role));
    return [lead ?? enabled[0]];
  }
  return [];
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
    (project.agentIds ?? []).map((id) => ctx.db.get(id))
  );
  return docs.filter((a): a is AgentDoc => a !== null);
}

/** Membership + enabled gate. Throws for explicit add/remove; the sync path filters instead. */
function assertAssignable(agent: AgentDoc | null, project: Doc<"projects">): void {
  if (!agent) throw new Error("Agent not found");
  if (agent.isEnabled === false) {
    throw new Error(`Agent ${agent.name} is disabled`);
  }
  if (!(project.agentIds ?? []).includes(agent._id)) {
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
    .collect();
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
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");

    let conversation = args.conversationId
      ? await ctx.db.get(args.conversationId)
      : null;
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
      const seeded = selectDefaultChatAgents(project.agentIds, team);
      await syncParticipants(
        ctx,
        conversation._id,
        project,
        team,
        seeded.map((a) => a._id)
      );
    }
    return conversation._id;
  },
});

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
    await assertProjectAccess(ctx, conversation.projectId);
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
      rows.map(async (conversation) => {
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
    const project = await assertProjectAccess(ctx, conversation.projectId);
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
    const project = await assertProjectAccess(ctx, conversation.projectId);
    const agent = await ctx.db.get(args.agentId);
    assertAssignable(agent, project);

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
    await assertProjectAccess(ctx, conversation.projectId);
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
    await assertProjectAccess(ctx, conversation.projectId);
    await ctx.db.patch(conversation._id, {
      status: "closed",
      updatedAt: Date.now(),
    });
    return conversation._id;
  },
});
