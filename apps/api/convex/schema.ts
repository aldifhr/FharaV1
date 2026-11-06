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
    qaUrl: v.optional(v.string()),
    devUrl: v.optional(v.string()),
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
    // Legacy fields from pre-global-LLM era. Kept optional so old docs
    // (e.g. llmProvider) still pass validation. New code does not write these.
    llmProvider: v.optional(v.string()),
    llmModel: v.optional(v.string()),
    llmBaseUrl: v.optional(v.string()),
    llmApiKeyEnv: v.optional(v.string()),
    llmApiKey: v.optional(v.string()),
    // LLM assignment (Phase 2 resolver): optional per-agent provider/model
    // preference. The resolver (worker llm/resolver.ts) tries the preferred
    // connection/model first, then the fallback assignment, then the pool.
    llmProviderId: v.optional(v.id("llmProviders")),
    llmModelId: v.optional(v.id("llmModels")),
    llmFallbackProviderId: v.optional(v.id("llmProviders")),
    llmFallbackModelId: v.optional(v.id("llmModels")),
    llmSelectionPolicy: v.optional(
      v.union(v.literal("fixed"), v.literal("priority"), v.literal("weighted"))
    ),
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
    replyToMessageId: v.optional(v.id("messages")),
  })
    .index("by_project", ["projectId"])
    .index("by_task", ["taskId"])
    .index("by_reply_to", ["replyToMessageId"]),

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
    // Provider connection that served the call (filled from Phase 5;
    // column created in Phase 2 so the schema changes only once).
    providerId: v.optional(v.id("llmProviders")),
    inputTokens: v.number(),
    outputTokens: v.number(),
    createdAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_project", ["projectId"])
    .index("by_created_at", ["createdAt"])
    .index("by_task", ["taskId"]),

  // Intelligent orchestrator — shared task context
  taskContexts: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    originalRequest: v.string(),
    objective: v.string(),
    status: taskStatus,
    decisions: v.array(v.any()),
    artifacts: v.array(v.any()),
    outstandingIssues: v.array(v.any()),
    updatedAt: v.number(),
  }).index("by_task", ["taskId"]),

  // Conditional delegation decisions
  delegations: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    fromAgentId: v.optional(v.id("agents")),
    toAgentId: v.optional(v.id("agents")),
    decision: v.union(
      v.literal("APPROVE"),
      v.literal("REJECT"),
      v.literal("REVISE"),
      v.literal("COMPLETE"),
      v.literal("BLOCKED")
    ),
    reason: v.optional(v.string()),
    capability: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]),

  // Lifecycle state history (for recoverability)
  lifecycleHistory: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    state: v.string(),
    prevState: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]),

  // Provider Connections (spec §4A) — reusable connections shared by all
  // projects/agents. Models live in llmModels (§4B); a connection can offer
  // many models. NOTE (Phase 2, additive step): the legacy `model` column
  // and the plaintext `apiKey` column are still declared so existing rows
  // validate; new writes store the key ONLY as `apiKeyCiphertext`
  // (AES-256-GCM, see llmCrypto.ts) and the migration moves `model` into
  // llmModels. Dropping both legacy columns is a separate deploy step that
  // happens after the migration is verified.
  llmProviders: defineTable({
    projectId: v.optional(v.string()),
    name: v.string(),
    provider: v.string(),
    model: v.string(),
    baseUrl: v.string(),
    apiKeyEnv: v.string(),
    apiKey: v.optional(v.string()),
    apiKeyCiphertext: v.optional(v.string()),
    priority: v.number(),
    weight: v.number(),
    modelPatterns: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  }),

  // Model Registry (spec §4B) — model metadata independent of agents and
  // of connections; one connection offers many models.
  llmModels: defineTable({
    providerId: v.id("llmProviders"),
    modelId: v.string(),
    displayName: v.optional(v.string()),
    contextWindow: v.optional(v.number()),
    supportsTools: v.optional(v.boolean()),
    supportsReasoning: v.optional(v.boolean()),
    inputPricePer1k: v.optional(v.number()),
    outputPricePer1k: v.optional(v.number()),
    isAvailable: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider", ["providerId"])
    .index("by_provider_and_model", ["providerId", "modelId"]),

  // Integrations (e.g. GitHub MCP connector)
  integrations: defineTable({
    projectId: v.id("projects"),
    type: v.union(v.literal("github")),
    name: v.string(),
    // Encrypted config: OAuth tokens, webhook secrets, etc.
    config: v.optional(v.string()),
    // For GitHub: access token, refresh token, etc.
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    // GitHub specific
    githubOwner: v.optional(v.string()),
    githubRepo: v.optional(v.string()),
    webhookSecret: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("error"), v.literal("disconnected")),
    errorMessage: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_type", ["type"])
    .index("by_project_and_type", ["projectId", "type"]),

  // Integration webhook events (for async processing)
  integrationEvents: defineTable({
    integrationId: v.id("integrations"),
    projectId: v.id("projects"),
    eventType: v.string(),
    payload: v.any(),
    deliveryId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("processed"), v.literal("failed")),
    error: v.optional(v.string()),
    createdAt: v.number(),
    processedAt: v.optional(v.number()),
  })
    .index("by_integration", ["integrationId"])
    .index("by_status", ["status"])
    .index("by_project", ["projectId"]),
});
