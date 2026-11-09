import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const taskStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("needs_approval"),
  // Non-terminal pause (plan 013 step 4): the orchestrator asked the user
  // a question and is waiting for the answer before continuing.
  v.literal("waiting_input"),
  v.literal("done"),
  v.literal("rejected"),
  v.literal("failed")
);

export const agentStatus = v.union(
  v.literal("idle"),
  v.literal("working"),
  v.literal("queued"),
  v.literal("needs_you"),
  v.literal("thinking"),
  v.literal("reviewing"),
  v.literal("waiting"),
  v.literal("blocked"),
  v.literal("completed"),
  v.literal("failed")
);

export const subtaskKind = v.union(
  v.literal("analysis"),
  v.literal("code_change"),
  v.literal("review"),
  v.literal("qa"),
  v.literal("research"),
  v.literal("audit"),
  v.literal("shell")
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
  v.literal("rejected"),
  // Closed without a user decision: the task was cancelled, or a manual
  // retry superseded the approvals of the previous attempt. Neither grants
  // nor denies anything (permissionBroker ignores it).
  v.literal("cancelled")
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
    // Plan 015 (additive): durable shared instructions loaded into the
    // planning prompt on every run, surviving recovery.
    instructions: v.optional(v.string()),
  }).index("by_owner", ["ownerId"]),

  agents: defineTable({
    name: v.string(),
    role: v.string(),
    // Plan 008: membership in the organization role registry (optional,
    // backfilled by key when the member is created; legacy rows keep only `role`).
    roleId: v.optional(v.id("roleDefinitions")),
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
    // Set once when syncFixedTeam retires a removed role; a later manual
    // re-enable is respected because retired rows are never re-disabled.
    retiredAt: v.optional(v.number()),
  }).index("by_enabled", ["isEnabled"]),

  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    command: v.string(),
    status: taskStatus,
    workerId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    planVersion: v.optional(v.number()),
    // Phase 4: how many times recoverStale has requeued this task after
    // a stale lease. Past the recovery bound the task is failed instead
    // of being requeued forever.
    recoveryCount: v.optional(v.number()),
    // Idempotency (plan 016): a retried/duplicate dispatch with the same key
    // reuses the existing task instead of creating a duplicate.
    idempotencyKey: v.optional(v.string()),
    // Monotonic per-task counter for taskEvents ordering (plan 016).
    eventSequence: v.optional(v.number()),
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
    // Plan 013 step 4 (additive): the question the orchestrator asked
    // while the task is `waiting_input`. The user's answer travels
    // separately (taskContext decision `user_answer`) — this field holds
    // ONLY the pending question.
    pendingQuestion: v.optional(v.string()),
    // Optional A/B/C-style choices the UI offers instead of free text.
    // Empty/absent = the free-text answer box.
    pendingOptions: v.optional(v.array(v.string())),
    // Agile: the sprint this task belongs to (1-based per project). A
    // sprint groups one planning round and its review/verification.
    sprint: v.optional(v.number()),
    // Agile: the phase within the sprint. The board shows these as columns;
    // the DAG scheduler still owns the true ordering.
    phase: v.optional(
      v.union(
        v.literal("planning"),
        v.literal("implementation"),
        v.literal("review"),
        v.literal("verification"),
        v.literal("done")
      )
    ),
  })
    .index("by_project", ["projectId"])
    .index("by_status", ["status"])
    .index("by_status_and_updated", ["status", "updatedAt"])
    .index("by_status_and_lease", ["status", "leaseExpiresAt"])
    .index("by_worker", ["workerId"])
    .index("by_worker_and_status", ["workerId", "status"])
    .index("by_idempotency", ["idempotencyKey"]),

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
    allowedPaths: v.optional(v.array(v.string())),
    reviewRound: v.optional(v.number()),
    status: subtaskStatus,
    // Phase 4 hardening (additive): how this row entered the DAG —
    // "plan" rows come from savePlan; dynamically spawned work is
    // upserted with "delegation" | "fix" | "review_fix" so recovery and
    // the dashboard can tell recovered dynamic nodes from planned ones.
    origin: v.optional(v.string()),
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
    .index("by_worker_and_status", ["workerId", "status"])
    .index("by_agent", ["agentId"])
    .index("by_agent_and_status", ["agentId", "status"])
    .index("by_status", ["status"])
    .index("by_status_and_lease", ["status", "leaseExpiresAt"]),

  workers: defineTable({
    workerId: v.string(),
    hostname: v.optional(v.string()),
    capacity: v.number(),
    activeTasks: v.number(),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
  })
    .index("by_worker_id", ["workerId"])
    .index("by_status_and_heartbeat", ["status", "lastHeartbeatAt"]),

  messages: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    authorType: v.union(v.literal("user"), v.literal("agent")),
    content: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    replyToMessageId: v.optional(v.id("messages")),
    // Plan 007 (additive): the conversation this message belongs to. Optional
    // so pre-conversation messages still validate; task-thread messages keep
    // taskId and need no conversation.
    conversationId: v.optional(v.id("conversations")),
    // Pinned by the user for quick access from the header chip. Optional so
    // pre-pin messages still validate.
    pinned: v.optional(v.boolean()),
    // Plan 006 Phase 4: durable queue. Messages are claimed by the worker
    // with the task lease pattern (leasedBy / leaseExpiresAt). Task-linked
    // report messages never enter the queue (queueStatus undefined).
    queueStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("claimed"),
        v.literal("done"),
        v.literal("failed"),
        v.literal("cancelled")
      )
    ),
    toAgentId: v.optional(v.id("agents")),
    leasedBy: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    error: v.optional(v.string()),
    // Streaming reasoning trace captured while the agent replies. Persisted
    // so the UI can render a "Thought" collapsible; optional so old rows
    // still validate. reasoningDurationMs is measured around the LLM call.
    reasoning: v.optional(v.string()),
    reasoningDurationMs: v.optional(v.number()),
    // Structured chat card rendered next to the text (assignment, push,
    // qa, verification). Optional; plain messages carry none.
    card: v.optional(
      v.object({
        kind: v.union(
          v.literal("assignment"),
          v.literal("push"),
          v.literal("qa"),
          v.literal("verification")
        ),
        data: v.any(),
      })
    ),
  })
    .index("by_project", ["projectId"])
    .index("by_task", ["taskId"])
    .index("by_reply_to", ["replyToMessageId"])
    .index("by_queue", ["queueStatus", "projectId"]),

  // Plan 007 (addendum §2): conversation participation is its own concept,
  // independent of project membership (projects.agentIds) and task assignment
  // (tasks.assignedAgentIds / subtasks.assignedAgentId). A conversation is the
  // persisted chat thread; participants are the agents currently in it.
  conversations: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    title: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("closed")),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    lastMessageAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_task", ["taskId"]),

  // Leaving is a soft delete (leftAt): participation history is kept and
  // queries filter leftAt === undefined. projectId is denormalized so
  // per-project participation reads do not join through conversations.
  conversationParticipants: defineTable({
    conversationId: v.id("conversations"),
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    joinedAt: v.number(),
    leftAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_project", ["projectId"]),

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
    // Plan 015 (additive, audit trail): the permission layer records the
    // requested tool, arguments, workspace, requester, expiry, and history.
    toolName: v.optional(v.string()),
    arguments: v.optional(v.any()),
    workspacePath: v.optional(v.string()),
    principalAgentId: v.optional(v.id("agents")),
    expiresAt: v.optional(v.number()),
    history: v.optional(v.array(v.any())),
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
    agentId: v.optional(v.id("agents")),
    message: v.optional(v.string()),
    // Monotonic per-task ordering (plan 016): UI sorts by this, not by
    // timestamp, so late-arriving events never reorder the trace.
    sequence: v.optional(v.number()),
    metadata: v.optional(v.any()),
    createdAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_sequence", ["taskId", "sequence"])
    .index("by_project", ["projectId"]),

  /**
   * Canonical agent/task event stream (plan 016). One row per canonical event
   * (`message.created`, `agent.started`, `agent.thinking`, `agent.tool.started`,
   * `agent.tool.completed`, `agent.waiting_approval`, `agent.completed`,
   * `agent.failed`, `task.updated`, `task.completed`, `task.failed`). The
   * provider-specific `taskEvents` stay the raw log; the UI subscribes to this
   * one, so it never needs to understand worker/provider vocabulary.
   */
  agentEvents: defineTable({
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    executionId: v.optional(v.id("executions")),
    agentId: v.optional(v.id("agents")),
    type: v.string(),
    payload: v.optional(v.any()),
    // Per-conversation monotonic order for UI rendering.
    sequence: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_and_sequence", ["conversationId", "sequence"])
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
    // Phase 5 (additive): the llmModels registry row that served the
    // call, and the estimated cost computed from that row's pricing at
    // call time. Both absent — never guessed — when the serving handle
    // had no registry identity or no complete pricing.
    modelId: v.optional(v.id("llmModels")),
    estimatedCost: v.optional(v.number()),
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
    // Phase 5 (additive): the task's persisted budget snapshot
    // (BudgetTracker.snapshot shape) so a resumed/recovered run restores
    // the FULL tracker state — agents, delegation count, retries — not
    // just the call/token totals the tokenUsage table carries.
    budgetSnapshot: v.optional(v.any()),
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

  // Context summaries (plan 006 Phase 3): deterministic LLM summaries of a
  // conversation's tail so prompts carry a bounded summary + last 12 instead
  // of the full history. Scoped retrieval is served by `by_conversation` with
  // a `beforeCreationTime` cursor in descending order; `by_project` serves
  // admin listing.
  contextSummaries: defineTable({
    conversationId: v.id("conversations"),
    projectId: v.id("projects"),
    summary: v.string(),
    lastCompactAt: v.number(),
    summaryCharCount: v.number(),
    messageCountBefore: v.number(),
  })
    .index("by_conversation", ["conversationId", "lastCompactAt"])
    .index("by_project", ["projectId", "lastCompactAt"]),

  // Provider health snapshots (Phase 5 observability): the worker's
  // in-memory circuit registry (llm/health.ts) mirrored to the backend by
  // the worker itself, one row per provider connection, so the Settings
  // UI can render per-connection circuit state. Written ONLY by the
  // worker through its token-gated action, and only when the deployment
  // was provisioned with the mirror token (see orchestration.ts); the
  // table stays empty otherwise and the UI says so honestly.
  providerHealth: defineTable({
    providerId: v.id("llmProviders"),
    providerName: v.string(),
    consecutiveTransientFailures: v.number(),
    totalSuccesses: v.number(),
    totalTransientFailures: v.number(),
    circuitOpenUntil: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    reportedAt: v.number(),
  }).index("by_provider", ["providerId"]),

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

  // MCP server connections (Plan 007 Phase 1 — UI config only)
  mcpServers: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    type: v.union(v.literal("local"), v.literal("remote")),
    url: v.optional(v.string()), // for remote: HTTP endpoint
    command: v.optional(v.string()), // for local: executable
    args: v.optional(v.string()), // JSON-encoded string[] for local
    status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    // Plan 009: worker-facing MCP config. All optional — a row written
    // before this plan has no value and is treated as enabled/lazy.
    enabled: v.optional(v.boolean()),
    autoConnect: v.optional(v.boolean()),
    transport: v.optional(v.string()), // "stdio" (only supported today)
    allowedDirectories: v.optional(v.array(v.string())),
  })
    .index("by_project", ["projectId"])
    .index("by_name", ["projectId", "name"]),

  // Organization: reusable role templates (Plan 008 Phase 1).
  // Role Definition is separate from Agent Member and Project Assignment.
  roleDefinitions: defineTable({
    key: v.string(),
    name: v.string(),
    category: v.string(),
    description: v.string(),
    systemPrompt: v.optional(v.string()),
    capabilities: v.array(v.string()),
    defaultTools: v.array(v.string()),
    defaultPermissions: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_category", ["category"])
    .index("by_enabled", ["enabled"]),

  // Project team: logical assignment of an organization member to a project.
  // Adding an agent here never creates a separate LLM credential.
  projectAgents: defineTable({
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    enabled: v.boolean(),
    customInstructions: v.optional(v.string()),
    allowedTools: v.optional(v.array(v.string())),
    permissionOverrides: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_agent", ["agentId"])
    .index("by_project_and_agent", ["projectId", "agentId"]),
});
