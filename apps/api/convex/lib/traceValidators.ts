/**
 * Convex validators for plan 025 (requirements traceability, execution
 * observations). The pure shapes live in requirements.ts / observations.ts.
 */
import { v } from "convex/values";

export const requirementValidator = v.object({
  id: v.string(),
  text: v.string(),
  span: v.optional(v.object({ start: v.number(), end: v.number() })),
  source: v.union(v.literal("llm"), v.literal("fallback")),
});

/** The last coverage check of a task (worker, before "done"). */
export const requirementCoverageValidator = v.object({
  checkedAt: v.number(),
  /** covered = every requirement covered; gaps = replan requested; completed_with_gaps = ended with gaps. */
  outcome: v.union(v.literal("covered"), v.literal("gaps"), v.literal("completed_with_gaps")),
  covered: v.array(v.string()),
  missingEvidence: v.array(v.string()),
  uncovered: v.array(v.string()),
});

export const observationTypeValidator = v.union(
  v.literal("agent_completed"),
  v.literal("agent_failed"),
  v.literal("test_failed"),
  v.literal("gate_failed"),
  v.literal("scope_violation"),
  v.literal("no_progress"),
  v.literal("dependency_blocked"),
  v.literal("provider_error")
);

export const observationFields = {
  eventType: observationTypeValidator,
  source: v.object({
    agentId: v.optional(v.string()),
    subtaskKey: v.optional(v.string()),
    tool: v.optional(v.string()),
  }),
  facts: v.object({
    affectedFiles: v.optional(v.array(v.string())),
    errorCode: v.optional(v.string()),
    findings: v.optional(v.array(v.string())),
  }),
  evidenceRefs: v.array(v.string()),
  observedAt: v.number(),
};
