import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { loadProviderPool } from "./lib/llmResolver";
import { activeParticipantRows, selectDefaultChatAgents } from "./conversations";
import { formatSkillsSection } from "./lib/skills";
import { loadPromptSkills } from "./skills";
import { loadMemorySection } from "./memories";
import { extractAgentMentions } from "./lib/chat/team";

/** Drop the `--- File: <path> ---` blocks `attachMentionedFiles` appends so
 *  repeated file context does not accumulate in the chat prompt. */
function stripFileAttachments(content: string): string {
  return content.replace(/\n\n--- File: [^\n]+ ---\n[\s\S]*?(?=\n\n--- File: |\s*$)/g, "").trim();
}

export const insertUserMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
    quotedMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) throw new Error("Message is required");
    if (content.length > 8000) throw new Error("Message is too long");
    if (args.quotedMessageId) {
      const quoted = await ctx.db.get(args.quotedMessageId);
      if (!quoted || quoted.projectId !== args.projectId) throw new Error("Quoted message not found");
    }
    // Durable FIFO queue (plan 016 P0): the row is claimed by the worker with
    // the task lease pattern. Task-linked agent messages never enter the
    // queue (queueStatus undefined) — only conversation user messages do.
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      authorType: "user",
      content,
      conversationId: args.conversationId,
      ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId } : {}),
      queueStatus: "pending",
      attempts: 0,
    });
  },
});

export const insertAgentMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentId: v.optional(v.id("agents")),
    content: v.string(),
    replyToMessageId: v.optional(v.id("messages")),
    taskId: v.optional(v.id("tasks")),
    conversationId: v.optional(v.id("conversations")),
    card: v.optional(
      v.object({
        kind: v.union(v.literal("assignment"), v.literal("push"), v.literal("qa"), v.literal("verification"), v.literal("changes")),
        data: v.any(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content && !args.card) return null;
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      agentId: args.agentId,
      authorType: "agent",
      content,
      replyToMessageId: args.replyToMessageId,
      taskId: args.taskId,
      conversationId: args.conversationId,
      ...(args.card ? { card: args.card } : {}),
    });
  },
});

/**
 * The message a user message quotes (chat "Reply"), with what routing needs:
 * the author's role, whether it is still an enabled team member, and how
 * many teammates the user @mentioned in the reply text.
 */
export const getQuoteForReply = internalQuery({
  args: { userMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.userMessageId);
    if (!message?.quotedMessageId) return null;
    const quoted = await ctx.db.get(message.quotedMessageId);
    if (!quoted || quoted.projectId !== message.projectId) return null;
    const project = await ctx.db.get(message.projectId);
    const teamIds = project?.agentIds ?? [];
    const team = (await Promise.all(teamIds.map((id) => ctx.db.get(id)))).filter(
      (a): a is Doc<"agents"> => a !== null && a.isEnabled !== false
    );
    const agent = quoted.agentId ? team.find((a) => a._id === quoted.agentId) ?? (await ctx.db.get(quoted.agentId)) : null;
    const mentions = extractAgentMentions(
      message.content,
      team.map((a) => ({ _id: String(a._id), name: a.name, role: a.role }))
    );
    return {
      quote: {
        authorType: quoted.authorType,
        agentId: quoted.agentId ? String(quoted.agentId) : undefined,
        role: agent?.role,
        content: quoted.content,
        inTeam: quoted.agentId ? team.some((a) => a._id === quoted.agentId) : undefined,
      },
      userMentionCount: mentions.length,
    };
  },
});

export const checkAlreadyReplied = internalQuery({
  args: { userMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", args.userMessageId))
      .first();
    return existing !== null;
  },
});

/**
 * Streaming reply rows: the chat action creates the agent message first,
 * then patches content/reasoning as SSE chunks arrive so the UI shows the
 * bubble and its reasoning trace live. The reply guard
 * (checkAlreadyReplied) reads by replyToMessageId, so an early row still
 * blocks duplicate replies.
 */
export const createStreamingAgentMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentId: v.optional(v.id("agents")),
    conversationId: v.optional(v.id("conversations")),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      agentId: args.agentId,
      authorType: "agent",
      content: "",
      replyToMessageId: args.replyToMessageId,
      conversationId: args.conversationId,
      streaming: true,
    });
  },
});

export const updateStreamingAgentMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    content: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    reasoningDurationMs: v.optional(v.number()),
    streaming: v.optional(v.boolean()),
    checkedFiles: v.optional(v.array(v.string())),
    unverifiedRefs: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { messageId, ...patch } = args;
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) cleaned[key] = value;
    }
    await ctx.db.patch(messageId, cleaned);
    return null;
  },
});

/** Drop a streamed agent message that ended with no content and no card. */
export const removeEmptyAgentMessage = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (message && message.authorType === "agent" && !message.content.trim() && !message.card) {
      await ctx.db.delete(args.messageId);
    }
    return null;
  },
});

export const getProjectPath = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    return project ? { workspacePath: project.workspacePath } : null;
  },
});

export const getContext = internalQuery({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    /** The user message being answered: history stops there, so a reply
     *  never answers a newer message sent while it was queued. */
    userMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { agents: [], projectName: "", history: [] };
    const anchor = args.userMessageId ? await ctx.db.get(args.userMessageId) : null;

    // Plan 007: when a conversation is given, participation is read from the
    // persisted participant rows (still gated on membership + enabled, since a
    // participant may have been disabled or removed from the team since it
    // joined). Without one, the historical selection runs as fallback.
    // Mentions always win: an explicit @mention supersedes the persisted
    // participant set, otherwise the conversational agent answers.
    let selected: Doc<"agents">[];
    const mentioned = args.preferredAgentIds?.length
      ? (await Promise.all(args.preferredAgentIds.map((id) => ctx.db.get(id))))
          .filter((a): a is Doc<"agents"> => a !== null && a.isEnabled !== false)
      : [];
    if (args.conversationId) {
      const rows = await activeParticipantRows(ctx, args.conversationId);
      const agents = await Promise.all(rows.map((row) => ctx.db.get(row.agentId)));
      const team = project.agentIds ?? [];
      selected = agents.filter((agent): agent is Doc<"agents"> => {
        if (!agent) return false;
        if (agent.isEnabled === false) return false;
        return team.includes(agent._id);
      });
      if (mentioned.length > 0) {
        selected = mentioned.filter((a) => team.includes(a._id));
      }
    } else {
      const all = await ctx.db.query("agents").collect();
      selected =
        mentioned.length > 0
          ? mentioned
          : selectDefaultChatAgents(project.agentIds, all, args.preferredAgentIds);
    }

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);
    // Context isolation: when a conversation is given, history must come
    // ONLY from that conversation (never other conversations in the same
    // project). Messages without conversationId are legacy pre-007 and
    // are only included when no conversation is scoped.
    const scoped = (args.conversationId
      ? rows.filter((m) => m.conversationId === args.conversationId)
      : rows
    ).filter((m) => !anchor || m._creationTime <= anchor._creationTime);
    const history = scoped
      .filter((m) => !m.taskId)
      .slice(0, 12)
      .reverse()
      .map((m) => ({
        authorType: m.authorType,
        // Lets a reply find the speaker's own previous message ("koreksi").
        agentId: m.agentId,
        // The file attachment appends context the agents do not need to see
        // again; the compacted summary already carries it.
        content: stripFileAttachments(m.content),
      }));

    // Plan 016: the active task for router context (title + status).
    let activeTask: { title: string; status: string } | null = null;
    const activeRows = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    const queuedRows = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();
    for (const row of [...activeRows, ...queuedRows]) {
      if (row.projectId === args.projectId) {
        activeTask = { title: row.title, status: row.status };
        break;
      }
    }

    // Plan 006 Phase 3: conversation summary + last 12 replaces raw history
    // for compaction. The latest summary for this conversation (if any)
    // is included so the router path can carry bounded context.
    let contextSummary: string | undefined;
    if (args.conversationId) {
      const summaries = await ctx.db
        .query("contextSummaries")
        .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId!))
        .order("desc")
        .take(1);
      contextSummary = summaries[0]?.summary;
    }

    // Library skills ride as a separate pre-rendered section so only the
    // chat persona (not the classifier/chooser snippets) carries them.
    const agentShape = async (a: Doc<"agents">) => ({
      _id: a._id,
      name: a.name,
      role: a.role,
      systemPrompt: a.systemPrompt,
      skillsSection: formatSkillsSection(await loadPromptSkills(ctx, a)) || undefined,
      // Pinned memories for this agent in this project, after the skills.
      memorySection: (await loadMemorySection(ctx, { projectId: args.projectId, agentId: a._id })) || undefined,
    });

    // The whole project team — the conversational agent is picked from here,
    // not from the (possibly mention-stale) participant set.
    const teamAgents = await Promise.all(
      (project.agentIds ?? []).map((id) => ctx.db.get(id))
    );
    const team = teamAgents.filter(
      (a): a is Doc<"agents"> => a !== null && a.isEnabled !== false
    );

    // Shared pool assembly (connections + models, encrypted key only) —
    // see lib/llmResolver.ts. chat.ts decrypts on the backend for its own call.
    const llmProviders = await loadProviderPool(ctx);

    return {
      agents: await Promise.all(selected.map(agentShape)),
      team: await Promise.all(team.map(agentShape)),
      projectName: project.name,
      history,
      contextSummary,
      activeTask,
      llmProviders,
    };
  },
});

/** Plan 016: the project's running/queued task, for the router context. */
export const getActiveTask = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    for (const status of ["running", "queued"] as const) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const row of rows) {
        if (row.projectId === args.projectId) {
          return { _id: row._id, title: row.title, status: row.status };
        }
      }
    }
    return null;
  },
});

export const getActiveTaskId = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    for (const status of ["running", "queued"] as const) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const row of rows) {
        if (row.projectId === args.projectId) {
          return row._id;
        }
      }
    }
    return null;
  },
});
