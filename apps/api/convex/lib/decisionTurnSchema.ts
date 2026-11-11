/**
 * GOAT G13: decision turns and the signal outbox (additive tables).
 *
 * - `taskSignals` (moved here from schema.ts, unchanged for approval and
 *   command rows): durable signals adapted from AkshatGiri/convex-orchestrator
 *   (Apache-2.0, re-implemented, see taskSignals.ts). G13 adds the `answer`
 *   name: a decision turn's answer is committed here, in the same mutation
 *   that records the decision and its audit row, before anything delivers it.
 *   `approvalId`, `approvalKind` and `decision` are set on approval/command
 *   rows only.
 * - `decisionTurns`: one question put to a role's decision turn (the CTO for
 *   G13; D7 auto review and N7 native questions reuse it with their own
 *   `purpose`). It records who answered, what was chosen, and why, or that
 *   the question expired without an answer (expiry never picks an option).
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const decisionTurnStatusValidator = v.union(
  v.literal("open"),
  v.literal("answered"),
  v.literal("escalated"),
  v.literal("expired")
);

/** Where an answer goes: back to the live run that asked ("inline"), or into the task's input queue ("task_input"). */
export const decisionDeliveryValidator = v.union(v.literal("inline"), v.literal("task_input"));

export const decisionTurnSourceValidator = v.union(v.literal("escalation"), v.literal("mcp"), v.literal("direct"));

export const decisionTurnTables = {
  taskSignals: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    name: v.union(v.literal("approval"), v.literal("command"), v.literal("answer")),
    approvalId: v.optional(v.id("approvals")),
    approvalKind: v.optional(v.string()),
    decision: v.optional(v.union(v.literal("approved"), v.literal("rejected"))),
    subtaskKey: v.optional(v.string()),
    command: v.optional(v.string()),
    // G13 answer rows: the turn and the answer text it carries.
    decisionTurnId: v.optional(v.id("decisionTurns")),
    answer: v.optional(v.string()),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),
    consumedBy: v.optional(v.string()),
  })
    .index("by_name_and_consumed", ["name", "consumedAt"])
    .index("by_task_and_consumed", ["taskId", "consumedAt"])
    .index("by_approval", ["approvalId"])
    .index("by_project", ["projectId"]),

  decisionTurns: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskKey: v.optional(v.string()),
    /** The role key that decides (G13: "cto"). */
    role: v.string(),
    /** What the turn is for (G13: "question"; D7/N7 add their own). */
    purpose: v.literal("question"),
    source: decisionTurnSourceValidator,
    delivery: decisionDeliveryValidator,
    kind: v.optional(v.string()),
    category: v.string(),
    question: v.string(),
    options: v.optional(v.array(v.string())),
    dedupeKey: v.string(),
    status: decisionTurnStatusValidator,
    expiresAt: v.number(),
    claimedBy: v.optional(v.string()),
    claimedUntil: v.optional(v.number()),
    answer: v.optional(v.string()),
    chosenOption: v.optional(v.string()),
    rationale: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    signalId: v.optional(v.id("taskSignals")),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_status_and_expires", ["status", "expiresAt"])
    .index("by_task", ["taskId", "createdAt"])
    .index("by_project", ["projectId"]),
};
