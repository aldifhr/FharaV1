/**
 * O2: System status lines in task threads (lib/systemLine.ts). The worker
 * appends them through `append`; an identical line already posted on the
 * same task is not posted again (a resumed run re-dispatching a node does not
 * repeat "Sent to Frontend").
 */
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./lib/authz";
import { isSystemLine, normalizeSystemLine, SYSTEM_VOICE } from "./lib/systemLine";

const DEDUPE_WINDOW = 200;

export const insert = internalMutation({
  args: { projectId: v.id("projects"), taskId: v.id("tasks"), content: v.string() },
  handler: async (ctx, args) => {
    const content = normalizeSystemLine(args.content);
    if (!content) return null;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(DEDUPE_WINDOW);
    if (recent.some((row) => isSystemLine(row) && row.content === content)) return null;
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      authorType: "agent",
      voice: SYSTEM_VOICE,
      content,
    });
  },
});

/** Worker entry point (service token). */
export const append = action({
  args: { workerToken: v.string(), projectId: v.id("projects"), taskId: v.id("tasks"), content: v.string() },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runMutation(internal.systemLines.insert, {
      projectId: args.projectId,
      taskId: args.taskId,
      content: args.content,
    });
  },
});
