import { v } from "convex/values";

/** Decision Outcome Calibration: per-role (optionally per complexity) estimator multiplier. */
export const estimatorMultiplierValidator = v.object({
  role: v.string(),
  // low | medium | high | ultra; unset = every complexity of the role.
  complexity: v.optional(v.string()),
  tokens: v.optional(v.number()),
  duration: v.optional(v.number()),
});

export const decisionTypeValidator = v.union(
  v.literal("plan"),
  v.literal("routing"),
  v.literal("delegation"),
  v.literal("replan"),
  v.literal("escalation"),
  v.literal("qa_loop"),
  v.literal("review_loop"),
  v.literal("engine")
);

export const outcomeLabelValidator = v.union(
  v.literal("good"),
  v.literal("suboptimal"),
  v.literal("bad"),
  v.literal("unknown")
);

export const decisionOutcomeValidator = v.object({
  label: outcomeLabelValidator,
  factors: v.array(v.string()),
  final: v.boolean(),
  signals: v.any(),
  evaluatedAt: v.number(),
});

export const decisionExpectedValidator = v.object({
  objective: v.optional(v.string()),
  acceptance: v.optional(v.array(v.string())),
  requirementIds: v.optional(v.array(v.string())),
  requirements: v.optional(v.array(v.string())),
  note: v.optional(v.string()),
});
