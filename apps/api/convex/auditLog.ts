import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjectIds } from "./lib/authz";

/**
 * Audit log page (read-only), newest first.
 *
 * Pagination uses a `_creationTime` cursor rather than `.paginate()` so the
 * filters can run in code without returning empty pages: each call scans at
 * most SCAN_CAP rows older than `cursor`, keeps the ones that match, and
 * returns `nextCursor` (the oldest row it scanned) while more may remain.
 * A page can therefore hold fewer than `limit` rows; the UI just offers
 * "Load more" while `nextCursor` is non-null.
 *
 * Scope: with `projectId`, that project's rows (by_project index). Without
 * it, every row of a project the viewer can see plus global rows (no
 * projectId: agent registry, LLM providers/models, removed projects).
 */

const SCAN_CAP = 600;
const MAX_LIMIT = 100;

const category = v.union(v.literal("config"), v.literal("tools"));

export const list = query({
  args: {
    projectId: v.optional(v.id("projects")),
    actor: v.optional(v.string()),
    action: v.optional(v.string()),
    decision: v.optional(
      v.union(v.literal("allowed"), v.literal("denied"), v.literal("pending"), v.literal("recorded"))
    ),
    /** "config" = tool "config"; "tools" = governed tool calls (not config/approval). */
    category: v.optional(category),
    /** `_creationTime` of the last row of the previous page. */
    cursor: v.optional(v.union(v.number(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit ?? 50)));
    const cursor = args.cursor ?? undefined;

    let visible: Set<string> | null = null;
    let scanned: Doc<"audit">[];
    if (args.projectId) {
      await assertProjectAccess(ctx, args.projectId);
      const projectId = args.projectId;
      scanned = await ctx.db
        .query("audit")
        .withIndex("by_project", (q) =>
          cursor !== undefined
            ? q.eq("projectId", projectId).lt("_creationTime", cursor)
            : q.eq("projectId", projectId)
        )
        .order("desc")
        .take(SCAN_CAP);
    } else {
      visible = await visibleProjectIds(ctx);
      scanned = await ctx.db
        .query("audit")
        .withIndex("by_creation_time", (q) =>
          cursor !== undefined ? q.lt("_creationTime", cursor) : q
        )
        .order("desc")
        .take(SCAN_CAP);
    }

    const actor = args.actor?.trim().toLowerCase();
    const action = args.action?.trim().toLowerCase();
    const matches = (row: Doc<"audit">) => {
      if (visible && row.projectId && !visible.has(row.projectId)) return false;
      if (actor && row.actor.toLowerCase() !== actor) return false;
      if (action && !row.action.toLowerCase().includes(action)) return false;
      if (args.decision && row.decision !== args.decision) return false;
      if (args.category === "config" && row.tool !== "config") return false;
      if (args.category === "tools" && (row.tool === "config" || row.tool === "approval")) return false;
      return true;
    };

    const items: Doc<"audit">[] = [];
    let consumed = 0;
    for (const row of scanned) {
      consumed++;
      if (!matches(row)) continue;
      items.push(row);
      if (items.length >= limit) break;
    }
    // More rows may exist when the scan hit its cap, or when the page filled
    // before the scanned rows ran out.
    const more = scanned.length >= SCAN_CAP || consumed < scanned.length;
    const nextCursor = more && consumed > 0 ? scanned[consumed - 1]._creationTime : null;

    // Labels: actor role when the actor is an agent name, and project name.
    const agents = await ctx.db.query("agents").take(500);
    const roleByName = new Map(agents.map((a) => [a.name, a.role]));
    const projectNames = new Map<string, string>();
    for (const row of items) {
      if (!row.projectId || projectNames.has(row.projectId)) continue;
      const project = await ctx.db.get(row.projectId);
      projectNames.set(row.projectId, project?.name ?? "");
    }

    return {
      items: items.map((row) => ({
        _id: row._id,
        _creationTime: row._creationTime,
        createdAt: row.createdAt,
        actor: row.actor,
        actorRole: roleByName.get(row.actor) ?? null,
        tool: row.tool,
        action: row.action,
        decision: row.decision,
        target: row.target ?? null,
        details: row.details ?? null,
        projectId: row.projectId ?? null,
        projectName: row.projectId ? projectNames.get(row.projectId) || null : null,
        taskId: row.taskId ?? null,
        executionId: row.executionId ?? null,
      })),
      nextCursor,
    };
  },
});
