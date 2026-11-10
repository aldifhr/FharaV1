/**
 * L6: no-replay side-effect ledger.
 *
 * The phase model follows embassy's delivery ledger (`docs/DELIVERY.md`,
 * https://github.com/YuanpingSong/embassy, MIT, Copyright (c) 2026
 * YuanpingSong): queued → armed → accepted → terminal, with `ambiguous`
 * for a write whose outcome nobody can prove. Only positive proof that
 * nothing was written lets an effect run again; an armed or accepted
 * effect found by a later attempt is reconciled from reality by the worker
 * (remote branch SHA, PR by head branch, file hashes) and never replayed.
 * Ideas only, no code copied.
 *
 * Worker writes are internal (reached through token-gated `worker.*`
 * actions). The card's buttons are the user-facing `resolve` mutation:
 * "Retry" on an ambiguous effect always needs that click.
 */
import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./lib/authz";
import { taskCardConversationId } from "./lib/conversationScope";
import { sideEffectKind } from "./schema";

type EffectRow = Doc<"sideEffects">;

/** What the worker does next after `arm`. */
export type ArmDecision =
  /** Nothing was written before: perform the write. */
  | "proceed"
  /** A previous attempt armed (or accepted) it: check reality, never write blindly. */
  | "reconcile"
  /** Already done: skip the write and use the recorded evidence. */
  | "done"
  /** Waiting on the user (Check / Mark done / Retry). */
  | "ambiguous";

/** Pure transition for `arm` (exported for tests). */
export function armDecision(row: Pick<EffectRow, "phase" | "outcome"> | null): ArmDecision {
  if (!row) return "proceed";
  switch (row.phase) {
    case "queued":
      return "proceed";
    case "armed":
    case "accepted":
      return "reconcile";
    case "terminal":
      // A clean failure is positive proof nothing was written.
      return row.outcome === "failed" ? "proceed" : "done";
    case "ambiguous":
      return "ambiguous";
  }
}

async function byKey(ctx: MutationCtx, key: string): Promise<EffectRow | null> {
  return await ctx.db
    .query("sideEffects")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
}

export const arm = internalMutation({
  args: {
    key: v.string(),
    kind: sideEffectKind,
    workerId: v.string(),
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    pushId: v.optional(v.id("taskPushes")),
    evidence: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await byKey(ctx, args.key);
    const decision = armDecision(row);
    if (!row) {
      const effectId = await ctx.db.insert("sideEffects", {
        key: args.key,
        kind: args.kind,
        phase: "armed",
        taskId: args.taskId,
        projectId: args.projectId,
        pushId: args.pushId,
        workerId: args.workerId,
        attempts: 1,
        evidence: args.evidence,
        armedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { decision, effectId, phase: "armed" as const, evidence: args.evidence ?? null, attempts: 1 };
    }
    if (decision === "proceed") {
      await ctx.db.patch(row._id, {
        phase: "armed",
        outcome: undefined,
        workerId: args.workerId,
        attempts: row.attempts + 1,
        armedAt: now,
        acceptedAt: undefined,
        settledAt: undefined,
        reason: undefined,
        updatedAt: now,
      });
      return { decision, effectId: row._id, phase: "armed" as const, evidence: row.evidence ?? null, attempts: row.attempts + 1 };
    }
    if (decision === "reconcile") {
      // This attempt now owns the reconcile; the phase stays as it was.
      await ctx.db.patch(row._id, { workerId: args.workerId, updatedAt: now });
    }
    return { decision, effectId: row._id, phase: row.phase, evidence: row.evidence ?? null, attempts: row.attempts };
  },
});

export const accept = internalMutation({
  args: { effectId: v.id("sideEffects"), workerId: v.string(), evidence: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.effectId);
    if (!row) return { applied: false as const, reason: "not_found" as const };
    if (row.phase !== "armed") return { applied: false as const, reason: "not_armed" as const, phase: row.phase };
    const now = Date.now();
    await ctx.db.patch(row._id, {
      phase: "accepted",
      acceptedAt: now,
      workerId: args.workerId,
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      updatedAt: now,
    });
    return { applied: true as const };
  },
});

export const settle = internalMutation({
  args: {
    effectId: v.id("sideEffects"),
    workerId: v.string(),
    outcome: v.union(v.literal("done"), v.literal("failed")),
    evidence: v.optional(v.any()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.effectId);
    if (!row) return { applied: false as const, reason: "not_found" as const };
    // First terminal result wins (a late duplicate never flips it).
    if (row.phase === "terminal") return { applied: false as const, reason: "already_terminal" as const, outcome: row.outcome };
    // A `failed` settle is only allowed while nothing was accepted: after
    // the provider accepted the write, failure is not provable.
    if (args.outcome === "failed" && row.phase === "accepted") {
      return { applied: false as const, reason: "accepted" as const };
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      phase: "terminal",
      outcome: args.outcome,
      settledAt: now,
      workerId: args.workerId,
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      reason: args.reason?.slice(0, 500),
      updatedAt: now,
    });
    return { applied: true as const };
  },
});

function effectLabel(row: Pick<EffectRow, "kind">, label?: string): string {
  if (label) return label;
  return row.kind === "push" ? "the push" : row.kind === "pr_create" ? "the pull request" : row.kind === "apply" ? "the file changes" : "the restore";
}

/**
 * Nobody can prove what happened: park the effect and post the card
 * ("Fhara could not confirm whether the push happened — Check / Mark done
 * / Retry"). Idempotent: one card per effect.
 */
export const markAmbiguous = internalMutation({
  args: {
    effectId: v.id("sideEffects"),
    workerId: v.string(),
    reason: v.string(),
    label: v.optional(v.string()),
    evidence: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.effectId);
    if (!row) return { applied: false as const, reason: "not_found" as const };
    if (row.phase === "terminal") return { applied: false as const, reason: "already_terminal" as const };
    const now = Date.now();
    await ctx.db.patch(row._id, {
      phase: "ambiguous",
      reason: args.reason.slice(0, 500),
      workerId: args.workerId,
      resolvedBy: undefined,
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      updatedAt: now,
    });
    let messageId = row.messageId;
    const task = row.taskId ? await ctx.db.get(row.taskId) : null;
    if (!messageId && task) {
      const label = effectLabel(row, args.label);
      messageId = await ctx.db.insert("messages", {
        projectId: task.projectId,
        taskId: task._id,
        conversationId: await taskCardConversationId(ctx, task.conversationId),
        authorType: "agent",
        content: `Fhara could not confirm whether ${label} happened.`,
        card: {
          kind: "side_effect",
          data: { effectId: String(row._id), kind: row.kind, label, taskId: String(task._id) },
        },
      });
      await ctx.db.patch(row._id, { messageId });
    }
    return { applied: true as const, messageId: messageId ?? null };
  },
});

/** The card's live view of one effect. */
export const get = query({
  args: { effectId: v.id("sideEffects") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.effectId);
    if (!row) return null;
    if (row.projectId) await assertProjectAccess(ctx, row.projectId);
    else return null;
    return {
      _id: row._id,
      kind: row.kind,
      phase: row.phase,
      outcome: row.outcome ?? null,
      reason: row.reason ?? null,
      attempts: row.attempts,
      resolvedBy: row.resolvedBy ?? null,
      pushId: row.pushId ?? null,
      taskId: row.taskId ?? null,
      updatedAt: row.updatedAt,
    };
  },
});

/** Pure: the ledger phase a user click moves an ambiguous effect to (exported for tests). */
export function resolvedPhase(action: "check" | "mark_done" | "retry"): Pick<EffectRow, "phase"> & { outcome?: "done" } {
  if (action === "mark_done") return { phase: "terminal", outcome: "done" };
  // Check: back to armed, so the next attempt reconciles and never writes.
  if (action === "check") return { phase: "armed" };
  // Retry: the user's explicit go-ahead to write again.
  return { phase: "queued" };
}

/**
 * The ambiguous card's buttons. Check re-runs the reconcile (no write);
 * Mark done records the user's word; Retry lets the write run again. For a
 * push, Check and Retry requeue the push request (still behind its
 * approved `git_push` approval) and Mark done marks it pushed.
 */
export const resolve = mutation({
  args: {
    effectId: v.id("sideEffects"),
    action: v.union(v.literal("check"), v.literal("mark_done"), v.literal("retry")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.effectId);
    if (!row || !row.projectId) throw new Error("Side effect not found");
    await assertProjectAccess(ctx, row.projectId);
    if (row.phase !== "ambiguous") return { applied: false as const, phase: row.phase };
    const now = Date.now();
    const next = resolvedPhase(args.action);
    await ctx.db.patch(row._id, {
      phase: next.phase,
      outcome: next.outcome,
      resolvedBy: args.action,
      ...(next.phase === "terminal" ? { settledAt: now } : {}),
      updatedAt: now,
    });
    if (row.pushId) await requeuePush(ctx, row.pushId, args.action, now);
    return { applied: true as const, phase: next.phase };
  },
});

async function requeuePush(
  ctx: MutationCtx,
  pushId: Id<"taskPushes">,
  action: "check" | "mark_done" | "retry",
  now: number
): Promise<void> {
  const push = await ctx.db.get(pushId);
  if (!push || push.status === "pushing") return;
  if (action === "mark_done") {
    // The push itself is done (a PR effect only runs after a push landed).
    await ctx.db.patch(push._id, { status: "pushed", pushedAt: push.pushedAt ?? now, error: undefined, updatedAt: now });
    return;
  }
  await ctx.db.patch(push._id, {
    status: "requested",
    requestedAt: now,
    error: undefined,
    workerId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
}
