import { v } from "@fhara/runtime/values";
import { subtaskContractFields } from "./contractValidators";
import { subtaskKind } from "../schema";

/** Subtask shape shared by `savePlan` and `saveDynamicSubtasks` worker actions. */
export const workerSubtaskValidator = v.object({
  key: v.string(),
  title: v.string(),
  description: v.string(),
  kind: subtaskKind,
  capability: v.string(),
  dependencies: v.array(v.string()),
  order: v.number(),
  allowedPaths: v.optional(v.array(v.string())),
  origin: v.optional(v.string()),
  reviewRound: v.optional(v.number()),
  ...subtaskContractFields,
});

/** Editable MCP server fields shared by the preset-create and update actions. */
export const mcpEditableArgs = {
  name: v.optional(v.string()),
  fields: v.optional(v.record(v.string(), v.string())),
  env: v.optional(v.record(v.string(), v.string())),
  agentRoles: v.optional(v.array(v.string())),
  toolAllowlist: v.optional(v.array(v.string())),
  enabled: v.optional(v.boolean()),
  autoConnect: v.optional(v.boolean()),
  useGithubOAuth: v.optional(v.boolean()),
  type: v.optional(v.union(v.literal("local"), v.literal("remote"))),
  command: v.optional(v.string()),
  commandArgs: v.optional(v.array(v.string())),
  url: v.optional(v.string()),
};
