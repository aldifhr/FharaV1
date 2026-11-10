/**
 * Workflow Studio (plan 030): user-defined agent-workflow DAGs.
 *
 * A workflow is a visual DAG of agent steps � a definition only, never
 * executed here. Reads are open (global store, local single-user mode);
 * writes go through `assertRegistryWriteAccess` like the agent registry.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { workflowEdgeValidator, workflowNodeValidator, workflowPatchValidator } from "./schema";
import { assertRegistryWriteAccess } from "./lib/authz";

/** Page size for the (small) global workflow list. */
const WORKFLOW_PAGE_SIZE = 200;

function toView(row: Doc<"workflows">) {
  return {
    id: row._id as string,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nodes: row.nodes,
    edges: row.edges,
  };
}

/** All workflows, newest updated first (the studio opens the first row). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("workflows")
      .withIndex("by_updated")
      .order("desc")
      .take(WORKFLOW_PAGE_SIZE);
    return rows.map(toView);
  },
});

export const create = mutation({
  args: {
    name: v.optional(v.string()),
    nodes: v.array(workflowNodeValidator),
    edges: v.array(workflowEdgeValidator),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const now = Date.now();
    const workflowId = await ctx.db.insert("workflows", {
      name: args.name?.trim() || "Workflow",
      createdAt: now,
      updatedAt: now,
      nodes: args.nodes,
      edges: args.edges,
    });
    const row = await ctx.db.get(workflowId);
    if (!row) throw new Error("Workflow not found");
    return toView(row);
  },
});

export const update = mutation({
  args: {
    id: v.string(),
    patch: workflowPatchValidator,
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const workflowId = ctx.db.normalizeId("workflows", args.id);
    if (!workflowId) throw new Error("Workflow not found");
    const row = await ctx.db.get(workflowId);
    if (!row) throw new Error("Workflow not found");
    const patch: {
      name?: string;
      nodes?: typeof row.nodes;
      edges?: typeof row.edges;
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (args.patch.name !== undefined) patch.name = args.patch.name;
    if (args.patch.nodes !== undefined) patch.nodes = args.patch.nodes;
    if (args.patch.edges !== undefined) patch.edges = args.patch.edges;
    await ctx.db.patch(workflowId, patch);
    const updated = await ctx.db.get(workflowId);
    if (!updated) throw new Error("Workflow not found");
    return toView(updated);
  },
});

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const workflowId = ctx.db.normalizeId("workflows", args.id);
    if (!workflowId) return false;
    const row = await ctx.db.get(workflowId);
    if (!row) return false;
    await ctx.db.delete(workflowId);
    return true;
  },
});