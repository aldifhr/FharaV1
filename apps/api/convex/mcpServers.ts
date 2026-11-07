import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess } from "./authz";

/**
 * MCP server config — Plan 007 Phase 1 (UI config) + Plan 009 (worker
 * integration).
 *
 * CRUD for MCP server configurations stored in Convex. All writes are
 * internal mutations, called by the Next.js server route (UI) or by the
 * token-gated worker actions in worker.ts, which hold
 * CONVEX_SERVICE_TOKEN. Reads use the same conditional ownership model as
 * the rest of the app (authz.ts): local single-user mode has no identity,
 * so access is not denied when no viewer exists. Do not add a hard
 * identity check here.
 *
 * `updateStatus` is the worker's best-effort report that a local server
 * connected / failed; the /mcp page renders it. The /mcpServers.list
 * shape sent to the worker via getRunContext carries only config fields
 * (name/command/args/paths) — never credentials.
 */

const mcpConfigFields = {
  enabled: v.optional(v.boolean()),
  autoConnect: v.optional(v.boolean()),
  transport: v.optional(v.string()),
  allowedDirectories: v.optional(v.array(v.string())),
};

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return ctx.db
      .query("mcpServers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const add = internalMutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    type: v.union(v.literal("local"), v.literal("remote")),
    url: v.optional(v.string()),
    command: v.optional(v.string()),
    args: v.optional(v.string()),
    ...mcpConfigFields,
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("mcpServers", {
      projectId: args.projectId,
      name: args.name,
      type: args.type,
      url: args.url,
      command: args.command,
      args: args.args,
      status: "disconnected",
      createdAt: Date.now(),
      enabled: args.enabled,
      autoConnect: args.autoConnect,
      transport: args.transport,
      allowedDirectories: args.allowedDirectories,
    });
  },
});

export const updateStatus = internalMutation({
  args: {
    serverId: v.id("mcpServers"),
    status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("error")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.serverId, {
      status: args.status,
      errorMessage: args.errorMessage,
    });
  },
});

export const remove = internalMutation({
  args: { serverId: v.id("mcpServers") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.serverId);
  },
});
