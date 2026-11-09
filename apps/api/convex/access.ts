import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess } from "./authz";

/**
 * Authorization bridge for public ACTIONS (which have no `ctx.db`). The
 * caller's identity propagates into `ctx.runQuery`, so this applies the same
 * conditional ownership rule as `assertProjectAccess` in queries/mutations:
 * open (owner-less) projects stay open in local single-user mode, owned
 * projects require their owner. Throws on denial.
 */
export const checkProjectAccess = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    return { projectId: project._id };
  },
});
