import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    workspacePath: v.string(),
    agentIds: v.optional(v.array(v.id("agents"))),
  }),
  agents: defineTable({
    name: v.string(),
    role: v.string(),
    systemPrompt: v.optional(v.string()),
    llmProvider: v.optional(v.string()),
    llmModel: v.optional(v.string()),
    llmBaseUrl: v.optional(v.string()),
    llmApiKey: v.optional(v.string()),
    status: v.union(
      v.literal("idle"),
      v.literal("working"),
      v.literal("queued"),
      v.literal("needs_you")
    ),
    avatarParams: v.optional(v.any()),
  }),
  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    command: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("needs_approval"),
      v.literal("done"),
      v.literal("rejected"),
      v.literal("failed")
    ),
  }),
  messages: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    authorType: v.union(v.literal("user"), v.literal("agent")),
    content: v.string(),
  }),
  approvals: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    kind: v.union(
      v.literal("apply_changes"),
      v.literal("git_push"),
      v.literal("run_command")
    ),
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected")
    ),
  }),
  fileChanges: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    filePath: v.string(),
    changeType: v.union(
      v.literal("new"),
      v.literal("modified"),
      v.literal("deleted")
    ),
    oldContent: v.optional(v.string()),
    newContent: v.optional(v.string()),
    diff: v.string(),
  }),
  taskEvents: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    type: v.string(),
    payload: v.optional(v.any()),
  }),
});
