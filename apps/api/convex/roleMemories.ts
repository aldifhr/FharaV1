import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { validateMemoryInput } from "./lib/memory";
import {
  ROLE_LEARNINGS_MAX,
  ROLE_LEARNING_KINDS,
  ROLE_MEMORY_CAP,
  cleanLearning,
  findDuplicate,
  pickEvictions,
} from "./lib/roleMemory";

/**
 * Role memory: each role writes its own notes per project by itself
 * (lib/roleMemory.ts). The worker asks a role for its learnings after it
 * finished work in a task and hands them here; no approval step. Rows are
 * `memories` with scope "agent", the role's agentId and the projectId,
 * UNPINNED, source "agent". Writing stops when the project turned "Role
 * memory" off; existing rows are still recalled.
 */

export const learningInput = v.object({
  title: v.string(),
  content: v.string(),
  kind: v.optional(v.string()),
});

const KIND_TAGS = new Set<string>(ROLE_LEARNING_KINDS);

export function roleMemoryEnabled(project: Pick<Doc<"projects">, "roleMemoryDisabled"> | null | undefined): boolean {
  return !project?.roleMemoryDisabled;
}

/**
 * Worker write: upsert one role's learnings in one project. Each item is
 * secret-masked and capped (cleanLearning; diffs dropped), then updates the
 * closest existing note of that role in that project (title/content
 * similarity) or is inserted. Afterwards the role keeps at most
 * ROLE_MEMORY_CAP notes there: the oldest unpinned agent-written ones go.
 * A pinned note or one the user wrote is never rewritten or evicted.
 */
export const upsertLearnings = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    taskId: v.optional(v.id("tasks")),
    learnings: v.array(learningInput),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { applied: false as const, reason: "project_not_found" as const, inserted: 0, updated: 0, evicted: 0 };
    if (!roleMemoryEnabled(project)) {
      return { applied: false as const, reason: "disabled" as const, inserted: 0, updated: 0, evicted: 0 };
    }
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return { applied: false as const, reason: "agent_not_found" as const, inserted: 0, updated: 0, evicted: 0 };
    const rows = (
      await ctx.db
        .query("memories")
        .withIndex("by_project_agent", (q) => q.eq("projectId", args.projectId).eq("agentId", args.agentId))
        .collect()
    ).filter((row) => row.scope === "agent");
    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    for (const raw of args.learnings.slice(0, ROLE_LEARNINGS_MAX)) {
      const clean = cleanLearning(raw);
      if (!clean) continue;
      let valid: { title: string; content: string };
      try {
        const out = validateMemoryInput({ title: clean.title, content: clean.content });
        valid = { title: out.title!, content: out.content! };
      } catch {
        continue;
      }
      const tags = KIND_TAGS.has(clean.kind) ? [clean.kind] : undefined;
      const dup = findDuplicate(rows, valid);
      if (dup) {
        // The user's own words and pinned notes stay as written.
        if (dup.pinned || dup.source === "user") continue;
        if (dup.title === valid.title && dup.content === valid.content) {
          await ctx.db.patch(dup._id, { updatedAt: now });
          dup.updatedAt = now;
          continue;
        }
        await ctx.db.patch(dup._id, { title: valid.title, content: valid.content, ...(tags ? { tags } : {}), updatedAt: now });
        Object.assign(dup, { title: valid.title, content: valid.content, updatedAt: now });
        updated += 1;
        continue;
      }
      const memoryId: Id<"memories"> = await ctx.db.insert("memories", {
        scope: "agent",
        projectId: args.projectId,
        agentId: args.agentId,
        title: valid.title,
        content: valid.content,
        ...(tags ? { tags } : {}),
        pinned: false,
        source: "agent",
        createdAt: now,
        updatedAt: now,
      });
      const row = await ctx.db.get(memoryId);
      if (row) rows.push(row);
      inserted += 1;
    }
    const evict = pickEvictions(rows, ROLE_MEMORY_CAP);
    for (const row of evict) await ctx.db.delete(row._id);
    if (inserted || updated || evict.length) {
      await recordAudit(ctx, {
        action: "memory.role_learned",
        target: `${agent.role}: ${inserted} new, ${updated} updated`,
        projectId: args.projectId,
        details: { agentId: args.agentId, inserted, updated, evicted: evict.length, ...(args.taskId ? { taskId: args.taskId } : {}) },
      });
    }
    return { applied: true as const, inserted, updated, evicted: evict.length };
  },
});

/** Project settings: whether roles write their own notes here (default on). */
export const getProjectSetting = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    return { enabled: roleMemoryEnabled(project), cap: ROLE_MEMORY_CAP };
  },
});

export const setProjectSetting = mutation({
  args: { projectId: v.id("projects"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    if (roleMemoryEnabled(project) === args.enabled) return args.enabled;
    await ctx.db.patch(args.projectId, { roleMemoryDisabled: args.enabled ? undefined : true });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["roleMemory"], roleMemory: args.enabled },
    });
    return args.enabled;
  },
});
