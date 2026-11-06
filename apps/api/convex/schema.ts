import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const taskStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("needs_approval"),
  v.literal("done"),
  v.literal("rejected"),
  v.literal("failed")
);

export const agentStatus = v.union(
  v.literal("idle"),
  v.literal("working"),
  v.literal("queued"),
  v.literal("needs_you")
);

export const subtaskKind = v.union(
  v.literal("analysis"),
  v.literal("code_change"),
  v.literal("review"),
  v.literal("qa"),
  v.literal("research"),
  v.literal("audit")
);

export const subtaskStatus = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("running"),
  v.literal("waiting_approval"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("blocked"),
  v.literal("skipped")
);

export const executionStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting_approval"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled")
);

export const approvalKind = v.union(
  v.literal("apply_changes"),
  v.literal("git_push"),
  v.literal("run_command"),
  v.literal("merge_pr")
);

export const approvalStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected")
);

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    workspacePath: v.string(),
    agentIds: v.optional(v.array(v.id("agents"))),
    ownerId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"))),
    mainBranch: v.optional(v.string()),
    worktreesPath: v.optional(v.string()),
  }).index("by_owner", ["ownerId"]),

  agents: defineTable({
    name: v.string(),
    role: v.string(),
    systemPrompt: v.optional(v.string()),
    llmProvider: v.optional(v.string()),
    llmModel: v.optional(v.string()),
    llmBaseUrl: v.optional(v.string()),
    llmApiKeyEnv: v.optional(v.string()),
    llmApiKey: v.optional(v.string()),
    status: agentStatus,
    avatarParams: v.optional(v.any()),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    skills: v.optional(v.array(v.string())),
    supportedTools: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    maxConcurrency: v.optional(v.number()),
  }).index("by_enabled", ["isEnabled"]),

  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    command: v.string(),
    status: taskStatus,
    workerId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    planVersion: v.optional(v.number()),
    strategy: v.optional(v.string()),
    classification: v.optional(v.string()),
    replanCount: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    branchName: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    assignedAgentIds: v.optional(v.array(v.id("agents"))),
  })
    .index("by_project", ["projectId"])
    .index("by_status", ["status"])
    .index("by_status_and_updated", ["status", "updatedAt"])
    .index("by_worker", ["workerId"]),

  plans: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    version: v.number(),
    strategy: v.string(),
    createdBy: v.union(v.literal("orchestrator"), v.literal("fallback")),
    goal: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_version", ["taskId", "version"])
    .index("by_project", ["projectId"]),

  subtasks: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    key: v.string(),
    title: v.string(),
    description: v.string(),
    kind: subtaskKind,
    capability: v.string(),
    dependencies: v.array(v.string()),
    order: v.number(),
    status: subtaskStatus,
    assignedAgentId: v.optional(v.id("agents")),
    assignedAgentName: v.optional(v.string()),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    attempts: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_key", ["taskId", "key"])
    .index("by_task_and_status", ["taskId", "status"])
    .index("by_project", ["projectId"]),

  executions: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskId: v.optional(v.id("subtasks")),
    subtaskKey: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    capability: v.string(),
    workerId: v.string(),
    status: executionStatus,
    attempt: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_worker", ["workerId"])
    .index("by_agent", ["agentId"])
    .index("by_status", ["status"])
    .index("by_status_and_lease", ["status", "leaseExpiresAt"]),

  workers: defineTable({
    workerId: v.string(),
    hostname: v.optional(v.string()),
    capacity: v.number(),
    activeTasks: v.number(),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
  }).index("by_worker_id", ["workerId"]),

  messages: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    authorType: v.union(v.literal("user"), v.literal("agent")),
    content: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
  })
    .index("by_project", ["projectId"])
    .index("by_task", ["taskId"]),

  approvals: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    kind: approvalKind,
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    planVersion: v.optional(v.number()),
    status: approvalStatus,
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_task", ["taskId"])
    .index("by_project", ["projectId"]),

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
    oldContentHash: v.optional(v.string()),
    newContentHash: v.optional(v.string()),
    diff: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    approvedAt: v.optional(v.number()),
    appliedAt: v.optional(v.number()),
    appliedByWorkerId: v.optional(v.string()),
  }).index("by_task", ["taskId"]).index("by_project", ["projectId"]),

  taskEvents: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    type: v.string(),
    payload: v.optional(v.any()),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    level: v.optional(v.union(v.literal("info"), v.literal("warn"), v.literal("error"))),
  })
    .index("by_task", ["taskId"])
    .index("by_project", ["projectId"]),

  evaluations: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    planVersion: v.number(),
    verdict: v.union(
      v.literal("passed"),
      v.literal("failed"),
      v.literal("inconclusive")
    ),
    checks: v.any(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]),

  audit: defineTable({
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    executionId: v.optional(v.id("executions")),
    workerId: v.optional(v.string()),
    actor: v.string(),
    tool: v.string(),
    action: v.string(),
    decision: v.union(v.literal("allowed"), v.literal("denied"), v.literal("pending"), v.literal("recorded")),
    target: v.optional(v.string()),
    details: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_project", ["projectId"])
    .index("by_created_at", ["createdAt"]),

  tokenUsage: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    createdAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_project", ["projectId"])
    .index("by_created_at", ["createdAt"]),
});
