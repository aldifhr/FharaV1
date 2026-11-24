import { v } from "@fhara/runtime/values";

// Workflow Studio (plan 030): a visual agent-workflow DAG definition. Node
// and edge shapes stay string-keyed (frontend ids such as `node_abc12345`),
// not FharaRuntime ids: they are a frontend DAG contract and the backend
// ExecutionPlan mapping is future work. The studio UI was removed; the
// validators below only describe the retained `workflows` table.
export const workflowNodeType = v.union(
  v.literal("start"),
  v.literal("agent"),
  v.literal("approval"),
  v.literal("conditional"),
  v.literal("end")
);

export const edgeCondition = v.union(
  v.literal("always"),
  v.literal("on_success"),
  v.literal("on_failure"),
  v.literal("custom")
);

export const workflowNodeValidator = v.object({
  id: v.string(),
  type: workflowNodeType,
  title: v.string(),
  role: v.optional(v.string()),
  prompt: v.optional(v.string()),
  retries: v.optional(v.number()),
  message: v.optional(v.string()),
  x: v.number(),
  y: v.number(),
});

export const workflowEdgeValidator = v.object({
  id: v.string(),
  from: v.string(),
  to: v.string(),
  condition: edgeCondition,
  label: v.optional(v.string()),
});

/**
 * The Workflow Studio UI was removed. The `workflows` table and its
 * node/edge validators stay so stored definitions are not destroyed, but
 * nothing reads or writes them any more.
 */
