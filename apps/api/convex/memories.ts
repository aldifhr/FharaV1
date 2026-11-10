import { query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertAgentAccess, assertProjectAccess, assertRegistryWriteAccess, assertMessageAccess } from "./lib/authz";
import {
  formatMemorySection,
  memoryFromMessage,
  selectPromptMemories,
  validateMemoryInput,
  type MemoryLike,
} from "./lib/memory";
import { recordAudit, setFields } from "./lib/recordAudit";
import {
  RECALL_MAX,
  RECALL_TOP_K,
  formatRecalledSection,
  pickRecalled,
  recallSearchText,
  type RecallCandidate,
} from "./lib/memoryRecall";

/**
 * Memory (shared / project / agent). Access follows the rest of the
 * registry: project memories go through assertProjectAccess, agent ones
 * through assertAgentAccess for writes, shared ones through
 * assertRegistryWriteAccess for writes. Reads of shared/agent memories are
 * open like agents.list and skills.list (local single-user mode).
 */

type Ctx = QueryCtx | MutationCtx;

const scopeArg = v.union(v.literal("shared"), v.literal("project"), v.literal("agent"));

function toLike(row: Doc<"memories">): MemoryLike {
  return {
    scope: row.scope,
    projectId: row.projectId,
    agentId: row.agentId,
    title: row.title,
    content: row.content,
    pinned: row.pinned,
    createdAt: row.createdAt,
  };
}

/**
 * The rendered "## Memory" section for one agent working in one project
 * (empty string when nothing is pinned). Read by getRunContext (task runs)
 * and chatContext.getContext (chat).
 */
export async function loadMemorySection(
  ctx: Ctx,
  target: { projectId?: Id<"projects">; agentId?: Id<"agents"> }
): Promise<string> {
  const shared = await ctx.db
    .query("memories")
    .withIndex("by_scope", (q) => q.eq("scope", "shared").eq("pinned", true))
    .collect();
  const project = target.projectId
    ? (
        await ctx.db
          .query("memories")
          .withIndex("by_project", (q) => q.eq("projectId", target.projectId).eq("scope", "project"))
          .collect()
      ).filter((row) => row.pinned)
    : [];
  const agent = target.agentId
    ? (
        await ctx.db
          .query("memories")
          .withIndex("by_agent", (q) => q.eq("agentId", target.agentId))
          .collect()
      ).filter((row) => row.pinned && row.scope === "agent")
    : [];
  const picked = selectPromptMemories([...shared, ...project, ...agent].map(toLike), {
    projectId: target.projectId,
    agentId: target.agentId,
  });
  return formatMemorySection(picked);
}

/**
 * Plan L4: full-text search over one scope's memories (Convex searchIndex).
 * `pinned` narrows to pinned / unpinned rows; absent = both. Never throws:
 * an empty query returns [].
 */
async function searchScope(
  ctx: Ctx,
  scope: Doc<"memories">["scope"],
  owner: { projectId?: Id<"projects">; agentId?: Id<"agents"> },
  text: string,
  limit: number,
  pinned?: boolean
): Promise<Doc<"memories">[]> {
  if (!text) return [];
  if (scope === "project" && !owner.projectId) return [];
  if (scope === "agent" && !owner.agentId) return [];
  return await ctx.db
    .query("memories")
    .withSearchIndex("search_content", (q) => {
      let built = q.search("content", text).eq("scope", scope);
      if (scope === "project") built = built.eq("projectId", owner.projectId);
      if (scope === "agent") built = built.eq("agentId", owner.agentId);
      if (pinned !== undefined) built = built.eq("pinned", pinned);
      return built;
    })
    .take(limit);
}

/**
 * Plan L4: the top-k UNPINNED memories (shared, this project's, this
 * agent's) that match `query`. Pinned memories are never recalled here —
 * they are always on through loadMemorySection. Another project's or another
 * agent's memories are never searched.
 */
export async function recallMemories(
  ctx: Ctx,
  target: { projectId?: Id<"projects">; agentId?: Id<"agents"> },
  query: string,
  k: number = RECALL_TOP_K
): Promise<Doc<"memories">[]> {
  const text = recallSearchText(query);
  if (!text) return [];
  const limit = Math.min(Math.max(1, k), RECALL_MAX);
  const scopes = ["shared", "project", "agent"] as const;
  const results = await Promise.all(scopes.map((scope) => searchScope(ctx, scope, target, text, limit, false)));
  const byId = new Map<string, Doc<"memories">>();
  const candidates: RecallCandidate[] = [];
  for (const rows of results) {
    rows.forEach((row, rank) => {
      byId.set(row._id, row);
      candidates.push({ id: row._id, title: row.title, content: row.content, scope: row.scope, pinned: row.pinned, rank });
    });
  }
  return pickRecalled(candidates, query, limit).map((pick) => byId.get(pick.id)!);
}

/** Plan L4: the rendered "## Recalled memory" section ("" when nothing matched). */
export async function loadRecalledSection(
  ctx: Ctx,
  target: { projectId?: Id<"projects">; agentId?: Id<"agents"> },
  query: string
): Promise<string> {
  const rows = await recallMemories(ctx, target, query);
  return formatRecalledSection(rows, query);
}

/** Validates the scope/owner pair and the caller's access to it. */
async function assertScopeAccess(
  ctx: Ctx,
  scope: Doc<"memories">["scope"],
  projectId: Id<"projects"> | undefined,
  agentId: Id<"agents"> | undefined,
  write: boolean
) {
  if (scope === "project") {
    if (!projectId) throw new Error("A project memory needs a project");
    await assertProjectAccess(ctx, projectId);
    return;
  }
  if (scope === "agent") {
    if (!agentId) throw new Error("An agent memory needs an agent");
    if (write) await assertAgentAccess(ctx, agentId);
    else if (!(await ctx.db.get(agentId))) throw new Error("Agent not found");
    return;
  }
  if (write) await assertRegistryWriteAccess(ctx);
}

async function getWritable(ctx: MutationCtx, memoryId: Id<"memories">) {
  const row = await ctx.db.get(memoryId);
  if (!row) throw new Error("Memory not found");
  await assertScopeAccess(ctx, row.scope, row.projectId, row.agentId, true);
  return row;
}

/** One scope's memories: pinned first, then most recently updated. */
export const list = query({
  args: {
    scope: scopeArg,
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
  },
  handler: async (ctx, args) => {
    let rows: Doc<"memories">[];
    if (args.scope === "project") {
      if (!args.projectId) return [];
      await assertProjectAccess(ctx, args.projectId);
      rows = await ctx.db
        .query("memories")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId).eq("scope", "project"))
        .collect();
    } else if (args.scope === "agent") {
      if (!args.agentId) return [];
      rows = (
        await ctx.db
          .query("memories")
          .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
          .collect()
      ).filter((row) => row.scope === "agent");
    } else {
      rows = await ctx.db
        .query("memories")
        .withIndex("by_scope", (q) => q.eq("scope", "shared"))
        .collect();
    }
    return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  },
});

/** What an agent would get injected in a project (for the /memory preview). */
export const previewSection = query({
  args: { projectId: v.optional(v.id("projects")), agentId: v.optional(v.id("agents")) },
  handler: async (ctx, args) => {
    if (args.projectId) await assertProjectAccess(ctx, args.projectId);
    return await loadMemorySection(ctx, args);
  },
});

/**
 * Plan L4: the /memory search box — one scope's memories (pinned and
 * unpinned) matching `text`, at most 10. Read-only.
 */
export const search = query({
  args: {
    scope: scopeArg,
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.scope === "project" && args.projectId) await assertProjectAccess(ctx, args.projectId);
    return await searchScope(ctx, args.scope, args, recallSearchText(args.text), RECALL_MAX);
  },
});

/** Plan L4: what a request would recall for an agent in a project (preview). */
export const previewRecall = query({
  args: { projectId: v.optional(v.id("projects")), agentId: v.optional(v.id("agents")), text: v.string() },
  handler: async (ctx, args) => {
    if (args.projectId) await assertProjectAccess(ctx, args.projectId);
    const rows = await recallMemories(ctx, args, args.text);
    return rows.map((row) => ({ _id: row._id, scope: row.scope, title: row.title }));
  },
});

export const create = mutation({
  args: {
    scope: scopeArg,
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    title: v.string(),
    content: v.string(),
    tags: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
    source: v.optional(v.union(v.literal("user"), v.literal("agent"))),
  },
  handler: async (ctx, args) => {
    await assertScopeAccess(ctx, args.scope, args.projectId, args.agentId, true);
    const clean = validateMemoryInput({ title: args.title, content: args.content, tags: args.tags ?? [] });
    const now = Date.now();
    const memoryId = await ctx.db.insert("memories", {
      scope: args.scope,
      ...(args.scope === "project" ? { projectId: args.projectId } : {}),
      ...(args.scope === "agent" ? { agentId: args.agentId } : {}),
      title: clean.title!,
      content: clean.content!,
      ...(clean.tags?.length ? { tags: clean.tags } : {}),
      pinned: args.pinned ?? false,
      source: args.source ?? "user",
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, {
      action: "memory.create",
      target: `${args.scope}: ${clean.title!}`,
      details: { fields: setFields(args) },
      ...(args.scope === "project" && args.projectId ? { projectId: args.projectId } : {}),
    });
    return memoryId;
  },
});

export const update = mutation({
  args: {
    memoryId: v.id("memories"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await getWritable(ctx, args.memoryId);
    const clean = validateMemoryInput({ title: args.title, content: args.content, tags: args.tags });
    await ctx.db.patch(row._id, {
      ...(clean.title !== undefined ? { title: clean.title } : {}),
      ...(clean.content !== undefined ? { content: clean.content } : {}),
      ...(clean.tags !== undefined ? { tags: clean.tags.length ? clean.tags : undefined } : {}),
      ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
      updatedAt: Date.now(),
    });
    const { memoryId: _id, ...fields } = args;
    await recordAudit(ctx, {
      action: "memory.update",
      target: `${row.scope}: ${clean.title ?? row.title}`,
      details: { changed: setFields(fields) },
      ...(row.projectId ? { projectId: row.projectId } : {}),
    });
  },
});

export const setPinned = mutation({
  args: { memoryId: v.id("memories"), pinned: v.boolean() },
  handler: async (ctx, args) => {
    const row = await getWritable(ctx, args.memoryId);
    await ctx.db.patch(row._id, { pinned: args.pinned, updatedAt: Date.now() });
    await recordAudit(ctx, {
      action: args.pinned ? "memory.pin" : "memory.unpin",
      target: `${row.scope}: ${row.title}`,
      ...(row.projectId ? { projectId: row.projectId } : {}),
    });
  },
});

export const remove = mutation({
  args: { memoryId: v.id("memories") },
  handler: async (ctx, args) => {
    const row = await getWritable(ctx, args.memoryId);
    await ctx.db.delete(row._id);
    await recordAudit(ctx, {
      action: "memory.remove",
      target: `${row.scope}: ${row.title}`,
      ...(row.projectId ? { projectId: row.projectId } : {}),
    });
  },
});

/**
 * "Remember" on a chat message: saves it as a PINNED project memory
 * (source "user") so the project's agents get it in their next prompt.
 * Remembering the same text twice returns the existing memory.
 */
export const rememberMessage = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    const { conversation } = await assertMessageAccess(ctx, message);
    const draft = memoryFromMessage(message.content);
    if (!draft.content) throw new Error("Nothing to remember in this message");
    // Plan 039 D7: "Remember" in a personal chat saves a pinned memory for
    // that conversation's agent only, never shared or project memory.
    if (!message.projectId) {
      const agentId = conversation?.kind === "personal" ? conversation.agentId : undefined;
      if (!agentId) throw new Error("Nothing to remember in this message");
      const mine = (
        await ctx.db
          .query("memories")
          .withIndex("by_agent", (q) => q.eq("agentId", agentId))
          .collect()
      ).find((row) => row.scope === "agent" && row.content === draft.content);
      if (mine) {
        if (!mine.pinned) await ctx.db.patch(mine._id, { pinned: true, updatedAt: Date.now() });
        return { memoryId: mine._id, created: false };
      }
      const now = Date.now();
      const memoryId = await ctx.db.insert("memories", {
        scope: "agent",
        agentId,
        title: draft.title,
        content: draft.content,
        pinned: true,
        source: "user",
        createdAt: now,
        updatedAt: now,
      });
      await recordAudit(ctx, {
        action: "memory.create",
        target: `agent: ${draft.title}`,
        details: { fromMessage: true, personal: true },
      });
      return { memoryId, created: true };
    }
    const projectId = message.projectId;
    const existing = (
      await ctx.db
        .query("memories")
        .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("scope", "project"))
        .collect()
    ).find((row) => row.content === draft.content);
    if (existing) {
      if (!existing.pinned) await ctx.db.patch(existing._id, { pinned: true, updatedAt: Date.now() });
      return { memoryId: existing._id, created: false };
    }
    const now = Date.now();
    const memoryId = await ctx.db.insert("memories", {
      scope: "project",
      projectId,
      title: draft.title,
      content: draft.content,
      pinned: true,
      source: "user",
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, {
      action: "memory.create",
      target: `project: ${draft.title}`,
      details: { fromMessage: true },
      projectId,
    });
    return { memoryId, created: true };
  },
});
