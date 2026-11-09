/**
 * Convex validators for the plan 022 shapes (subtask contract, gate
 * results, escalation, model tiers). Kept apart from the pure helpers in
 * subtaskContract.ts / modelTiers.ts so those stay free of Convex imports
 * and can sit at the worker's foundation layer.
 */
import { v } from "convex/values";

// ---------------------------------------------------------------------------

export const acceptanceCheckValidator = v.union(
  v.literal("test"),
  v.literal("typecheck"),
  v.literal("file_exists"),
  v.literal("command"),
  v.literal("review"),
  v.literal("manual")
);

export const acceptanceGateValidator = v.object({
  id: v.string(),
  criterion: v.string(),
  check: acceptanceCheckValidator,
  target: v.optional(v.string()),
  required: v.optional(v.boolean()),
});

export const gateResultValidator = v.object({
  gateId: v.string(),
  status: v.union(v.literal("pass"), v.literal("fail"), v.literal("skipped")),
  evidence: v.object({
    kind: v.string(),
    ref: v.optional(v.string()),
    summary: v.string(),
  }),
});

export const acceptanceStatusValidator = v.union(
  v.literal("delivered"),
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("blocked"),
  v.literal("escalated")
);

export const escalationValidator = v.object({
  kind: v.union(
    v.literal("schema_change"),
    v.literal("new_dependency"),
    v.literal("security"),
    v.literal("out_of_scope"),
    v.literal("ambiguous")
  ),
  reason: v.string(),
  detail: v.optional(v.string()),
  options: v.optional(v.array(v.string())),
  source: v.optional(v.union(v.literal("executor"), v.literal("detected"))),
});

/** Contract fields carried by a subtask definition (plan payload + rows). */
export const subtaskContractFields = {
  objective: v.optional(v.string()),
  constraints: v.optional(v.array(v.string())),
  deliverable: v.optional(v.string()),
  acceptance: v.optional(v.array(acceptanceGateValidator)),
};


export const modelTiersValidator = v.object({
  planner: v.optional(v.id("llmModels")),
  reviewer: v.optional(v.id("llmModels")),
  worker: v.optional(v.id("llmModels")),
});

