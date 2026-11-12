import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertAgentAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";

/**
 * Turn an agent on or off from the agent panel. Works for the fixed team too:
 * a disabled fixed agent stays disabled, because the fixed-team sync matches
 * it by role (no duplicate is seeded) and never writes `isEnabled` back.
 */
export const setEnabled = mutation({
  args: { agentId: v.id("agents"), isEnabled: v.boolean() },
  handler: async (ctx, args) => {
    const agent = await assertAgentAccess(ctx, args.agentId);
    if ((agent.isEnabled !== false) === args.isEnabled) return;
    await ctx.db.patch(args.agentId, { isEnabled: args.isEnabled });
    await recordAudit(ctx, {
      action: "agent.update",
      target: `${agent.name} (${agent.role})`,
      details: { changed: ["isEnabled"], isEnabled: args.isEnabled },
    });
  },
});
