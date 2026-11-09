/**
 * Pinned messages for the chat header's pin chip. Reads the
 * `by_project_and_pinned` index (bounded), so the count no longer depends on
 * the pin being among the newest 1000 project messages.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess } from "./authz";

const PIN_LIMIT = 100;

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("messages")
      .withIndex("by_project_and_pinned", (q) => q.eq("projectId", args.projectId).eq("pinned", true))
      .order("desc")
      .take(PIN_LIMIT);
  },
});
