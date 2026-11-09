/**
 * Queue for read-only repo tool calls made by grounded chat replies.
 *
 * The chat action (chat.ts) enqueues one call, polls `get` until an online
 * worker has answered, then `remove`s the row. Workers reach `claimNext` /
 * `complete` only through the token-gated wrappers in worker.ts. Rows are
 * short-lived; `claimNext` also sweeps the ones an action abandoned.
 */
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { REPO_TOOL_CAPS } from "./lib/chat/repoTools";

/** A worker's claim on a call; an expired lease lets another worker take it. */
const CLAIM_LEASE_MS = 15_000;
/** A worker counts as online when it heartbeat within this window. */
const WORKER_FRESH_MS = 45_000;
/** Rows older than this were abandoned by their action (it waits ~20 s). */
const STALE_ROW_MS = 5 * 60_000;

/** Repo tools are usable for this project: it has a workspace and a worker is online. */
export const availability = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ available: boolean }> => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.workspacePath) return { available: false };
    const fresh = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) =>
        q.eq("status", "online").gte("lastHeartbeatAt", Date.now() - WORKER_FRESH_MS)
      )
      .first();
    return { available: fresh !== null };
  },
});

export const enqueue = internalMutation({
  args: { projectId: v.id("projects"), tool: v.string(), args: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("repoToolCalls", {
      projectId: args.projectId,
      tool: args.tool.slice(0, 40),
      args: args.args.slice(0, 2_000),
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const get = internalQuery({
  args: { callId: v.id("repoToolCalls") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.callId);
    if (!row) return null;
    return { status: row.status, result: row.result, error: row.error, files: row.files };
  },
});

export const remove = internalMutation({
  args: { callId: v.id("repoToolCalls") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.callId);
    if (row) await ctx.db.delete(args.callId);
    return null;
  },
});

/** Worker: take the oldest pending call (or one whose claim lease lapsed). */
export const claimNext = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Sweep rows abandoned by a chat action that timed out or crashed.
    for (const status of ["pending", "claimed", "done", "error"] as const) {
      const stale = await ctx.db
        .query("repoToolCalls")
        .withIndex("by_status_and_created", (q) => q.eq("status", status).lt("createdAt", now - STALE_ROW_MS))
        .take(20);
      for (const row of stale) await ctx.db.delete(row._id);
    }
    let row = await ctx.db
      .query("repoToolCalls")
      .withIndex("by_status_and_created", (q) => q.eq("status", "pending"))
      .first();
    if (!row) {
      const claimed = await ctx.db
        .query("repoToolCalls")
        .withIndex("by_status_and_created", (q) => q.eq("status", "claimed"))
        .take(20);
      row = claimed.find((c) => (c.leaseExpiresAt ?? 0) < now) ?? null;
    }
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "claimed", workerId: args.workerId, leaseExpiresAt: now + CLAIM_LEASE_MS });
    const project = await ctx.db.get(row.projectId);
    return {
      callId: row._id,
      tool: row.tool,
      args: row.args,
      workspacePath: project?.workspacePath ?? null,
    };
  },
});

/** Worker: write the (capped) result. Refused when another worker owns the claim. */
export const complete = internalMutation({
  args: {
    callId: v.id("repoToolCalls"),
    workerId: v.string(),
    ok: v.boolean(),
    result: v.string(),
    files: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.callId);
    if (!row || row.status !== "claimed" || row.workerId !== args.workerId) return false;
    const text = args.result.slice(0, REPO_TOOL_CAPS.resultMaxChars + 200);
    await ctx.db.patch(args.callId, {
      status: args.ok ? "done" : "error",
      result: args.ok ? text : undefined,
      error: args.ok ? undefined : text,
      files: (args.files ?? []).slice(0, 20).map((f) => f.slice(0, 300)),
      leaseExpiresAt: undefined,
    });
    return true;
  },
});
