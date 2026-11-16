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
import { REPO_TOOL_CAPS, REPO_TOOLS_CAPABILITY } from "./lib/chat/repoTools";

/** A worker's claim on a call; an expired lease lets another worker take it. */
const CLAIM_LEASE_MS = 15_000;
/**
 * Chat completions on the worker's CLI run up to CHAT_LLM_WAIT_MS (180 s in
 * chat.ts), so their rows get a lease long enough to cover one completion;
 * the 15 s tool lease would let a second worker re-claim mid-run and run it
 * twice (its own `complete` would then be refused as stale).
 */
const CHAT_LLM_LEASE_MS = 200_000;
/** A worker counts as online when it heartbeat within this window. */
const WORKER_FRESH_MS = 45_000;
/** Rows older than this were abandoned by their action (it waits ~20 s). */
const STALE_ROW_MS = 5 * 60_000;

/** Why repo tools are off for a reply (shown quietly in the Thinking trace). */
export type RepoToolsOffReason = "no_workspace" | "no_worker" | "worker_outdated";

/**
 * Repo tools are usable for this project: it has a workspace and an online
 * worker that advertises repo-tool support on its heartbeat. A fresh worker
 * without the capability is an older build that never polls the queue, so
 * calls would only wait out the timeout: it counts as unavailable.
 */
export const availability = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ available: boolean; reason?: RepoToolsOffReason }> => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.workspacePath) return { available: false, reason: "no_workspace" };
    const fresh = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) =>
        q.eq("status", "online").gte("lastHeartbeatAt", Date.now() - WORKER_FRESH_MS)
      )
      .take(50);
    if (fresh.length === 0) return { available: false, reason: "no_worker" };
    if (!fresh.some((w) => (w.capabilities ?? []).includes(REPO_TOOLS_CAPABILITY))) {
      return { available: false, reason: "worker_outdated" };
    }
    return { available: true };
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

/** Row cap for one chat payload; the worker slices its own prompt at the same size. */
export const CHAT_LLM_PAYLOAD_MAX_CHARS = 120_000;

export interface ChatLlmMessage {
  role: string;
  content: string;
}

/**
 * Fit one chat completion into the row cap by shrinking components BEFORE
 * serialization: the system prompt first, then the oldest turns, then the
 * last turn's content. Slicing the serialized JSON would cut it mid-string
 * and hand the worker an unparseable payload.
 */
export function fitChatLlmPayload(model: string, system: string, messages: ChatLlmMessage[]): string {
  const serialize = (sys: string, msgs: ChatLlmMessage[]) =>
    JSON.stringify({ model: model.slice(0, 200), system: sys, messages: msgs });
  let sys = system.slice(0, 60_000);
  const msgs = messages.map((m) => ({ role: String(m?.role ?? "user"), content: String(m?.content ?? "") }));
  if (serialize(sys, msgs).length <= CHAT_LLM_PAYLOAD_MAX_CHARS) return serialize(sys, msgs);
  sys = sys.slice(0, 20_000);
  // Keep the newest turn; drop older ones while the payload is too big.
  while (serialize(sys, msgs).length > CHAT_LLM_PAYLOAD_MAX_CHARS && msgs.length > 1) msgs.shift();
  if (serialize(sys, msgs).length > CHAT_LLM_PAYLOAD_MAX_CHARS && msgs.length > 0) {
    // One huge turn left: binary-shrink its content until it fits (JSON
    // escaping can inflate a slice, so a fixed cut could still overflow).
    const envelope = serialize(sys, []).length;
    let keep = Math.max(0, CHAT_LLM_PAYLOAD_MAX_CHARS - envelope);
    while (
      keep > 1 &&
      serialize(sys, [{ role: msgs[0].role, content: msgs[0].content.slice(0, keep) }]).length > CHAT_LLM_PAYLOAD_MAX_CHARS
    ) {
      keep = Math.floor(keep / 2);
    }
    msgs[0] = { role: msgs[0].role, content: msgs[0].content.slice(0, keep) };
  }
  return serialize(sys, msgs);
}

/**
 * Plan 060: one chat completion on the worker's local OpenCode CLI. The prompt
 * (system + history) is larger than a repo tool's argument cap, so it gets its
 * own bounded enqueue with the same queue and lease mechanics.
 */
export const enqueueChatLlm = internalMutation({
  args: { projectId: v.id("projects"), model: v.string(), system: v.string(), messages: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("repoToolCalls", {
      projectId: args.projectId,
      tool: "opencode_chat",
      args: fitChatLlmPayload(args.model, args.system, JSON.parse(args.messages) as ChatLlmMessage[]),
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
    const leaseMs = row.tool === "opencode_chat" ? CHAT_LLM_LEASE_MS : CLAIM_LEASE_MS;
    await ctx.db.patch(row._id, { status: "claimed", workerId: args.workerId, leaseExpiresAt: now + leaseMs });
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
