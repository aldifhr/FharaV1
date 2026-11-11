/**
 * Direct-thread session settings (Nuphos N10): the MCP server set a thread
 * should run with, and the reasoning effort the user picked.
 *
 * - `directMcpSetHash`: the hash (lib/mcpDeclaration.ts, no secrets) of the
 *   enabled MCP servers for the thread's project and role, read by
 *   directThreads.poll. The worker compares it with the hash its session
 *   declared (tasks.direct.mcpSetHash) and releases the session between
 *   turns when they differ.
 * - `setEffort`: tasks.direct.effort. The worker applies it before the next
 *   prompt, never mid-turn, and again on every resume.
 */
import { mutation, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./lib/authz";
import { mcpSetHashFor, normalizeDirectEffort } from "./lib/mcpDeclaration";
import { resolveRunMcpServers } from "./mcpServers";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);

/** The MCP set hash a direct thread for `role` in this project should have now ("" for none). */
export async function directMcpSetHash(ctx: QueryCtx, projectId: Id<"projects">, role: string): Promise<string> {
  const rows = await resolveRunMcpServers(ctx, projectId);
  return mcpSetHashFor(
    rows.map((row) => ({ ...row, _id: String(row._id) })),
    role
  );
}

/**
 * The reasoning effort for a direct thread ("low", "medium", "high", or
 * null for the agent's default). Values the agent doesn't offer are said
 * in the thread when the worker applies them.
 */
export const setEffort = mutation({
  args: { taskId: v.id("tasks"), effort: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ effort: string | null }> => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.mode !== "direct" || !task.direct) throw new Error("Direct thread not found");
    await assertProjectAccess(ctx, task.projectId);
    if (TERMINAL.has(task.status)) throw new Error("This thread is closed.");
    const effort = normalizeDirectEffort(args.effort);
    if ((task.direct.effort ?? null) === effort) return { effort };
    const direct = { ...task.direct };
    if (effort) direct.effort = effort;
    else delete direct.effort;
    await ctx.db.patch(task._id, { direct, updatedAt: Date.now() });
    return { effort };
  },
});
