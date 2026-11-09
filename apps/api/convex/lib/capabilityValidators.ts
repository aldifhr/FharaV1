/**
 * Convex validators for the Model Capability Registry (plan 027). The pure
 * shapes and resolution live in modelCapabilities.ts.
 */
import { v } from "convex/values";

export const toolCallingValidator = v.union(v.literal("native"), v.literal("markup"), v.literal("none"));

export const capabilityProbeValidator = v.object({
  at: v.number(),
  connectionName: v.optional(v.string()),
  structuredOutput: v.optional(v.boolean()),
  toolCalling: v.optional(toolCallingValidator),
  errors: v.optional(v.array(v.string())),
});

/** Editable capability fields (all optional: unset = next layer decides). */
export const capabilityPatchFields = {
  structuredOutput: v.optional(v.boolean()),
  toolCalling: v.optional(toolCallingValidator),
  vision: v.optional(v.boolean()),
  maxContextTokens: v.optional(v.number()),
  supportsStreaming: v.optional(v.boolean()),
  supportsCancellation: v.optional(v.boolean()),
  strengths: v.optional(v.array(v.string())),
  costPer1kIn: v.optional(v.number()),
  costPer1kOut: v.optional(v.number()),
};
