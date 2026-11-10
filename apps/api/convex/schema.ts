import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { permissionModeValidator } from "./lib/permissionModes";
import { usageLedgerFields } from "./lib/usageLedger";
import {
  decisionExpectedValidator,
  decisionOutcomeValidator,
  decisionTypeValidator,
  estimatorMultiplierValidator,
  outcomeLabelValidator,
} from "./lib/calibration/validators";
import {
  acceptanceStatusValidator,
  escalationValidator,
  gateResultValidator,
  subtaskContractFields,
  modelTiersValidator,
  llmSelectionModeValidator,
} from "./lib/contractValidators";
import {
  observationFields,
  requirementCoverageValidator,
  requirementValidator,
} from "./lib/traceValidators";

/** file:line evidence on a Reviewer opinion or shadow note. */
const reviewEvidenceValidator = v.object({
  file: v.string(),
  line: v.optional(v.number()),
  note: v.optional(v.string()),
});

export const taskStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("needs_approval"),
  // Non-terminal pause (plan 013 step 4): the orchestrator asked the user
  // a question and is waiting for the answer before continuing.
  v.literal("waiting_input"),
  // Non-terminal user pause (plan 022): no new subtask starts; running
  // ones finish. Never auto-resumes (scheduler and recovery skip it).
  v.literal("paused"),
  v.literal("done"),
  v.literal("rejected"),
  v.literal("failed"),
  // Terminal: the user stopped the task (tasks.cancel). Distinct from
  // "failed" so filters, incidents and success rates do not count a
  // deliberate stop as a failure.
  v.literal("cancelled")
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
  v.literal("merge_pr"),
  // Plan Inspector: the plan waits for the user's review before execution.
  v.literal("plan")
);

/** Plan Inspector project setting (lib/planReviewPolicy.ts). Unset = off. */
export const planReviewSetting = v.union(
  v.literal("off"),
  v.literal("medium_plus"),
  v.literal("always")
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

/** Lifecycle of a task-branch push (plan 019). */
export const pushStatus = v.union(
  // Commit recorded; nothing leaves the machine until the user clicks.
  v.literal("ready"),
  // The user clicked Push (explicit approval recorded); waiting for a worker.
  v.literal("requested"),
  // A worker holds the push lease and is running git push / the PR call.
  v.literal("pushing"),
  v.literal("pushed"),
  v.literal("failed")
);

export const prState = v.union(
  v.literal("draft"),
  v.literal("open"),
  v.literal("merged"),
  v.literal("closed")
);

/** Post-push PR facts (lib/prFeedback.ts). */
export const prCiState = v.union(v.literal("pending"), v.literal("passed"), v.literal("failed"));
export const prReviewState = v.union(
  v.literal("none"),
  v.literal("approved"),
  v.literal("changes_requested"),
  v.literal("commented")
);
export const prMergeable = v.union(v.literal("unknown"), v.literal("mergeable"), v.literal("conflict"));
export const prFixKind = v.union(
  v.literal("ci_failed"),
  v.literal("changes_requested"),
  v.literal("review_comments"),
  v.literal("merge_conflict")
);
export const prCheckFact = v.object({
  name: v.string(),
  status: prCiState,
  conclusion: v.optional(v.string()),
  url: v.optional(v.string()),
  checkRunId: v.optional(v.number()),
});
export const notificationKind = v.union(
  v.literal("ready_to_merge"),
  v.literal("ci_failed"),
  v.literal("changes_requested"),
  v.literal("merge_conflict"),
  v.literal("fix_cap_reached"),
  v.literal("fix_failed")
);

// Workflow Studio (plan 030): a visual agent-workflow DAG definition. Node
// and edge shapes stay string-keyed (frontend ids such as `node_abc12345`),
// not Convex ids: they are a frontend DAG contract and the backend
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
    // Plan 020 (additive): permission mode new tasks start in. Unset =
    // supervised. The legacy `approvalMode` switch above is kept as-is.
    defaultPermissionMode: v.optional(permissionModeValidator),
    // Plan Inspector (additive): pause after plan.created for the user's
    // review. Unset = off.
    planReview: v.optional(planReviewSetting),
    // Plan 022 (additive): model tier per role (llmModels ids). Explicit
    // agent assignment > tier > default.
    modelTiers: v.optional(modelTiersValidator),
    // Shadow Agent (additive): new tasks start with the Reviewer observing.
    // Unset = off.
    shadowAgentDefault: v.optional(v.boolean()),
    // Workload Manager (additive): the worker prefers the capable agent
    // with spare capacity. Unset = the worker's env default
    // (ORCHESTRATOR_LOAD_AWARE_ROUTING, off).
    loadAwareRouting: v.optional(v.boolean()),
    // Context Snapshot retention in days (additive). Unset = 14.
    contextSnapshotRetentionDays: v.optional(v.number()),
    // Decision Outcome Calibration (additive): per-role (× complexity)
    // multipliers the Task Estimator applies. Unset = 1. Changed only by
    // an explicit, audited Apply on /calibration.
    estimatorMultipliers: v.optional(v.array(estimatorMultiplierValidator)),
    // Plan 027 (additive): rank exact-capability agents by their recorded
    // performance. Unset = the worker's env default
    // (ORCHESTRATOR_PERFORMANCE_ROUTING, off).
    performanceRouting: v.optional(v.boolean()),
    // Chat UX (additive): "Always allow" rules for agent-initiated
    // commands, keyed on the normalized command head ("npm run test"),
    // never the full argv (lib/commandRules.ts). The worker's exact-argv
    // allowlist still applies first; dangerous / push-like commands never
    // match a rule. Unset = no rules.
    // Post-push feedback loop (additive): a failed CI check, a review that
    // asks for changes, new review comments or a merge conflict on a task's
    // PR queue a fix task on the same branch/worktree. Unset = off.
    prFeedbackReactions: v.optional(v.boolean()),
    commandAllowRules: v.optional(
      v.array(
        v.object({
          prefix: v.string(),
          createdAt: v.number(),
          createdBy: v.string(),
        })
      )
    ),
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
      v.union(
        v.literal("fixed"),
        v.literal("priority"),
        v.literal("weighted"),
        v.literal("round_robin")
      )
    ),
    // Execution runtime override: "api" (Fhara host tools + gated LLM) or
    // "opencode" (OpenCode CLI with native tools in the task worktree).
    // Unset = the worker's global ORCHESTRATOR_EXECUTION_RUNTIME default.
    executionRuntime: v.optional(v.union(v.literal("api"), v.literal("opencode"))),
    // Optional OpenCode model ("provider/model"); unset = Fhara's own LLM.
    opencodeModel: v.optional(v.string()),
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
    // Library skills attached to this agent (skills table). Distinct from
    // the legacy `skills: string[]` capability tags above.
    skillIds: v.optional(v.array(v.id("skills"))),
    // Skill v2: pinned versions ({skillId, version}); an attached skill
    // without a pin follows its latest version.
    skillPins: v.optional(v.array(v.object({ skillId: v.id("skills"), version: v.number() }))),
    // How skills reach the prompt: "inline" (default, unset) appends them
    // within SKILLS_PROMPT_BUDGET; "on_demand" lists names + descriptions
    // and gives the agent the read-only load_skill tool.
    skillLoading: v.optional(v.union(v.literal("inline"), v.literal("on_demand"))),
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
    // Plan 020 (additive): this task's permission mode, chosen in the
    // composer. Unset (pre-020 tasks) = supervised.
    permissionMode: v.optional(permissionModeValidator),
    // Plan Inspector (additive): the user's "Replan with note" text. The
    // next worker claim plans afresh with it as planner feedback; the next
    // saved planner version clears it.
    planReviewNote: v.optional(v.string()),
    // Plan 022 (additive): explicit user pause. Set with status "paused";
    // cleared on resume.
    pausedBy: v.optional(v.literal("user")),
    pausedAt: v.optional(v.number()),
    // Shadow Agent (additive): the Reviewer observes this task and leaves
    // notes after each completed subtask. Never executes or blocks.
    shadowAgent: v.optional(v.boolean()),
    // Plan 025 (additive): requirements extracted from the request at plan
    // time, and the last deterministic coverage check before "done".
    requirements: v.optional(v.array(requirementValidator)),
    requirementCoverage: v.optional(requirementCoverageValidator),
    // Agile: the sprint this task belongs to (1-based per project). A
    // sprint groups one planning round and its review/verification.
    sprint: v.optional(v.number()),
    // Plan 019 (additive): the chat conversation the task was dispatched
    // from, so stage cards (verification / QA / push) land in that chat.
    conversationId: v.optional(v.id("conversations")),
    // Post-push feedback loop (additive): a fix task is owned by the task
    // whose PR it fixes and runs on that task's branch/worktree.
    parentTaskId: v.optional(v.id("tasks")),
    prFix: v.optional(
      v.object({
        repoFullName: v.string(),
        prNumber: v.number(),
        kind: prFixKind,
        reactionId: v.id("prReactions"),
      })
    ),
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
    .index("by_idempotency", ["idempotencyKey"])
    .index("by_parent", ["parentTaskId"]),

  plans: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    version: v.number(),
    strategy: v.string(),
    // "user": a version produced by editing the plan on the Plan card.
    createdBy: v.union(v.literal("orchestrator"), v.literal("fallback"), v.literal("user")),
    goal: v.string(),
    payload: v.any(),
    /** Set when the plan is a deterministic fallback: why (task UI). */
    degradedReason: v.optional(v.string()),
    // Task Estimator (additive): lib/estimate.ts PlanEstimate, computed
    // before execution. An estimate, never a guarantee.
    estimate: v.optional(v.any()),
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
    // Live "what is the agent doing" line for a running subtask
    // ("Reading 4 files", "Running npm test", "Waiting for the model").
    activity: v.optional(v.string()),
    activityAt: v.optional(v.number()),
    // Plan 022 (additive): the subtask contract (objective, constraints,
    // deliverable, acceptance gates; scope = allowedPaths) and its
    // acceptance, separate from the execution status above.
    ...subtaskContractFields,
    acceptanceStatus: v.optional(acceptanceStatusValidator),
    acceptanceReason: v.optional(v.string()),
    gateResults: v.optional(v.array(gateResultValidator)),
    escalation: v.optional(escalationValidator),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_key", ["taskId", "key"])
    .index("by_task_and_status", ["taskId", "status"])
    .index("by_project", ["projectId"]),

  // Live output tail of a running subtask (worker:setSubtaskLiveOutput).
  // Kept off the subtasks row: it is rewritten every ~400ms while a model
  // streams, and subtask rows (with their outputs) feed project-wide
  // reactive queries that should not refire on every flush.
  subtaskLive: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    key: v.string(),
    text: v.string(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_key", ["taskId", "key"])
    // Project delete cascade (projects.cascadeDelete).
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
    // Plan 022 (additive): idempotent dispatch, `${taskId}/${subtaskKey}/attempt-N`.
    // A re-dispatch with the same key reuses (in flight / lease lapsed) or
    // skips (finished) the existing row instead of creating a duplicate.
    dispatchKey: v.optional(v.string()),
    // Set when recovery ended this execution because its lease lapsed with
    // no heartbeat (not a worker-reported failure): the next dispatch of
    // the same attempt reclaims the row.
    leaseLost: v.optional(v.boolean()),
  })
    .index("by_task", ["taskId"])
    .index("by_dispatch_key", ["dispatchKey"])
    .index("by_worker", ["workerId"])
    .index("by_worker_and_status", ["workerId", "status"])
    .index("by_agent", ["agentId"])
    .index("by_agent_and_status", ["agentId", "status"])
    .index("by_status", ["status"])
    .index("by_status_and_lease", ["status", "leaseExpiresAt"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  workers: defineTable({
    workerId: v.string(),
    hostname: v.optional(v.string()),
    capacity: v.number(),
    activeTasks: v.number(),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
    // Features this worker build serves, sent on every heartbeat (e.g.
    // "repoTools" for grounded chat). An older worker sends none, so chat
    // never queues work it would not pick up.
    capabilities: v.optional(v.array(v.string())),
  })
    .index("by_worker_id", ["workerId"])
    .index("by_status_and_heartbeat", ["status", "lastHeartbeatAt"]),

  messages: defineTable({
    // Optional since personal chat (plan 039): a message in a `personal`
    // conversation never carries projectId, even after a project is
    // attached (D1), so project timelines, pins, clearChat and the delete
    // cascade never see it. Every other message still sets it.
    projectId: v.optional(v.id("projects")),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    authorType: v.union(v.literal("user"), v.literal("agent")),
    content: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    replyToMessageId: v.optional(v.id("messages")),
    // Reply quote: the message the user replied to (chat "Reply" action).
    // Distinct from replyToMessageId, which links an agent reply to the
    // user message it answers.
    quotedMessageId: v.optional(v.id("messages")),
    // Plan 007 (additive): the conversation this message belongs to. Optional
    // so pre-conversation messages still validate; task-thread messages keep
    // taskId and need no conversation.
    conversationId: v.optional(v.id("conversations")),
    // Pinned by the user for quick access from the header chip. Optional so
    // pre-pin messages still validate.
    pinned: v.optional(v.boolean()),
    // True while the chat action is still streaming this agent reply. The
    // UI animates "Thinking" / the caret from it; cleared on finish or error.
    streaming: v.optional(v.boolean()),
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
    // Durable chat replies (t3code idea #1, idea only). A chat user message
    // carries its reply lifecycle: pending → replying (claimed by one
    // replyToChat run) → answered | failed. The worker queue (queueStatus)
    // is not used for chat: nothing ever claimed those rows.
    replyStatus: v.optional(
      v.union(v.literal("pending"), v.literal("replying"), v.literal("answered"), v.literal("failed"))
    ),
    // The replyToChat run holding the claim and when it is presumed dead.
    replyRunId: v.optional(v.string()),
    replyLeaseExpiresAt: v.optional(v.number()),
    // What the reply needs to be re-run by Retry (send's routing options).
    replyOptions: v.optional(
      v.object({
        preferredAgentIds: v.optional(v.array(v.id("agents"))),
        permissionMode: v.optional(permissionModeValidator),
      })
    ),
    // Idempotent send (t3code idea #2): the composer's client message id.
    // A retried/double-submitted send with the same id returns this row.
    clientId: v.optional(v.string()),
    // Agent bubble whose streaming run died (stale sweep or a failed run):
    // the UI shows "Reply interrupted" with Retry instead of a live caret.
    interrupted: v.optional(v.boolean()),
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
    // Repo-grounded chat: workspace files the agent read (read_file) while
    // writing this reply. The bubble shows a quiet "Checked: …" line.
    checkedFiles: v.optional(v.array(v.string())),
    // Post-answer check: file paths / file:line references in this reply
    // that no tool result (or the repo snapshot) showed. Quiet
    // "Unverified: …" line under the bubble.
    unverifiedRefs: v.optional(v.array(v.string())),
    // Chat activity timeline (additive): one compact row per tool call the
    // agent made while writing this reply, appended as each call completes
    // so the UI streams it live. `tool` is the raw tool name; `target` the
    // path / pattern / skill / role it acted on; `lines` a read range.
    toolSteps: v.optional(
      v.array(
        v.object({
          tool: v.string(),
          target: v.optional(v.string()),
          lines: v.optional(v.string()),
          ok: v.boolean(),
          at: v.number(),
        })
      )
    ),
    // One sanitized sentence of what the agent is about to do ("Bekerja"
    // line): the classifier's intent or the first reasoning sentence.
    intentLine: v.optional(v.string()),
    // Create task offer (additive): set on a CTO chat reply when the server
    // read the user's message as work (intent "task"); `kind` is the intent
    // subtype ("testing", "implementation", …) and `commands` the
    // allowlisted command lines a run request asked for ("npm run test").
    // The web Create task button keys on this, not on the reply's wording.
    taskOffer: v.optional(
      v.object({
        kind: v.string(),
        commands: v.optional(v.array(v.string())),
      })
    ),
    // Collaboration graph (additive): this agent reply was a CTO @mention
    // handoff; the CTO agent that handed the turn over.
    handoffFromAgentId: v.optional(v.id("agents")),
    // Structured chat card rendered next to the text (assignment, push,
    // qa, verification). Optional; plain messages carry none.
    card: v.optional(
      v.object({
        kind: v.union(
          v.literal("assignment"),
          v.literal("push"),
          v.literal("qa"),
          v.literal("verification"),
          // Plan 019: "Changed N files" diff card after a code change.
          v.literal("changes"),
          // Plan Inspector: the plan waiting for review (reads live state).
          v.literal("plan")
        ),
        data: v.any(),
      })
    ),
  })
    .index("by_project", ["projectId"])
    .index("by_task", ["taskId"])
    .index("by_reply_to", ["replyToMessageId"])
    .index("by_queue", ["queueStatus", "projectId"])
    // Stale sweeps: bubbles still streaming, user messages still replying.
    .index("by_streaming", ["streaming"])
    .index("by_project_and_client_id", ["projectId", "clientId"])
    .index("by_reply_status", ["replyStatus"])
    // Header pin chip: pinned messages of one project without a scan.
    .index("by_project_and_pinned", ["projectId", "pinned"])
    // Personal chat (plan 039): conversation history without the by_project
    // take-200 scan, and send dedupe for messages that have no project.
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_and_client_id", ["conversationId", "clientId"]),

  // Plan 007 (addendum §2): conversation participation is its own concept,
  // independent of project membership (projects.agentIds) and task assignment
  // (tasks.assignedAgentIds / subtasks.assignedAgentId). A conversation is the
  // persisted chat thread; participants are the agents currently in it.
  // Read-only repo tool calls for grounded chat replies. A Convex chat
  // action cannot read the project repo (it lives on the worker's host), so
  // it queues one call here, an online worker claims it, runs it read-only
  // inside the project workspace and writes the capped result back; the
  // action polls for it and deletes the row. See lib/chat/repoTools.ts.
  repoToolCalls: defineTable({
    projectId: v.id("projects"),
    tool: v.string(),
    // JSON-encoded tool arguments (validated by the worker).
    args: v.string(),
    status: v.union(v.literal("pending"), v.literal("claimed"), v.literal("done"), v.literal("error")),
    workerId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    // Repo-relative files the call read (read_file only).
    files: v.optional(v.array(v.string())),
    createdAt: v.number(),
  }).index("by_status_and_created", ["status", "createdAt"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  conversations: defineTable({
    // Optional since personal chat (plan 039): a personal conversation has
    // no project until attachProject sets it once. Project/team rows always
    // carry it (lib/conversationShape.ts).
    projectId: v.optional(v.id("projects")),
    taskId: v.optional(v.id("tasks")),
    // Plan 039. Absent on legacy rows = "project" (conversationKind()).
    // "team" is reserved for team chat without a project (deferred, D6).
    kind: v.optional(v.union(v.literal("personal"), v.literal("project"), v.literal("team"))),
    // Plan 039: the one agent of a personal conversation (required iff personal).
    agentId: v.optional(v.id("agents")),
    // Plan 039: getViewerId at create (null until an auth provider is wired).
    ownerId: v.optional(v.string()),
    // Plan 039: when attachProject set projectId on a personal conversation.
    projectAttachedAt: v.optional(v.number()),
    title: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("closed")),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    lastMessageAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_task", ["taskId"])
    // Plan 039: personal get-or-create and the personal list.
    .index("by_agent_kind_status", ["agentId", "kind", "status"])
    .index("by_kind_and_last_message", ["kind", "lastMessageAt"]),

  // Leaving is a soft delete (leftAt): participation history is kept and
  // queries filter leftAt === undefined. projectId is denormalized so
  // per-project participation reads do not join through conversations.
  conversationParticipants: defineTable({
    conversationId: v.id("conversations"),
    // Optional since plan 039: a personal conversation's participant row has
    // no project until the conversation is attached to one.
    projectId: v.optional(v.id("projects")),
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
    // Plan 020 (additive): who resolved it. "auto" = approved by the task's
    // permission mode without a pause. Unset on rows decided by a person.
    decidedBy: v.optional(v.union(v.literal("user"), v.literal("auto"))),
    // Chat UX (additive): run_command approvals the worker waits on
    // in-process (it keeps its lease). offerAlways is decided server-side:
    // "always" from a card that did not offer it is downgraded to "allow".
    offerAlways: v.optional(v.boolean()),
    decision: v.optional(v.union(v.literal("allow"), v.literal("always"), v.literal("deny"))),
    // The user's note with the decision (typed in the composer), or the
    // reason a wait was declined ("user replied instead", "timed out").
    note: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_task", ["taskId"])
    .index("by_project", ["projectId"])
    .index("by_project_and_status", ["projectId", "status"]),

  // Durable approval signals (idea from convex-orchestrator's `signals`
  // inbox, re-implemented). Approve / reject writes one row in the same
  // mutation that resolves the approval. "approval" rows wake a task parked
  // in needs_approval (the worker's resumable scan reads them, the resume
  // claim consumes them); "command" rows record a run_command decision the
  // in-process waiter reads, and let a replayed subtask reuse an allow the
  // user already gave when its first worker died mid-wait.
  taskSignals: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    name: v.union(v.literal("approval"), v.literal("command")),
    approvalId: v.id("approvals"),
    approvalKind: v.string(),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    subtaskKey: v.optional(v.string()),
    command: v.optional(v.string()),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),
    consumedBy: v.optional(v.string()),
  })
    .index("by_name_and_consumed", ["name", "consumedAt"])
    .index("by_task_and_consumed", ["taskId", "consumedAt"])
    .index("by_approval", ["approvalId"])
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

  // Plan 025: typed execution observations, derived deterministically from
  // the run's events (executions, checks, QA, acceptance, scope checks).
  executionObservations: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    ...observationFields,
  }).index("by_task", ["taskId"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

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
    // Idempotency key (t3code idea #2): a re-emit with the same key for the
    // same task (replayed attempt, retried mutation) writes nothing new.
    eventKey: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_sequence", ["taskId", "sequence"])
    .index("by_task_and_event_key", ["taskId", "eventKey"])
    .index("by_project", ["projectId"])
    // Workload view: one event type (subtask.routed) per project in a time
    // window, without scanning every tool event of every task.
    .index("by_project_and_type", ["projectId", "type"]),

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
    // Per-task sequence order (t3code idea #3): newest-window reads and
    // since-sequence replay for task-scoped canonical events.
    .index("by_task_and_sequence", ["taskId", "sequence"])
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
  }).index("by_task", ["taskId"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

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
    // Runs trace (additive): the execution attempt / subtask that made the
    // call, when the worker knew it. Absent on planner calls and on rows
    // recorded before this field existed (runs.get falls back to a
    // per-agent time-window match for those).
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    // The provider reported no usage: the counts are a chars/4 estimate
    // made by the worker (shown as "≈" in runs/evals).
    estimated: v.optional(v.boolean()),
    // What made the call (additive). Unset = a task/chat call; "playground"
    // = an Agent Playground run (never part of a task budget).
    kind: v.optional(v.string()),
    // Plan 040 P3 per-call ledger (additive, all optional): cache and
    // reasoning breakdown, duration, wire kind, call role, recording
    // source. Absent when the provider did not report it (lib/usageLedger.ts).
    ...usageLedgerFields,
    createdAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_project", ["projectId"])
    .index("by_created_at", ["createdAt"])
    .index("by_task", ["taskId"])
    .index("by_execution", ["executionId"]),

  // Intelligent orchestrator — shared task context
  // User text injected into a task (single input guard): steering
  // instructions and ask_user answers. Admitted only through
  // lib/taskInputGuard.admitTaskInput; `delivered` flips to true only when
  // the worker actually renders the text into an agent prompt.
  taskInputs: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    kind: v.union(v.literal("steer"), v.literal("answer")),
    text: v.string(),
    // For answers: the question that was open when the answer landed.
    question: v.optional(v.string()),
    delivered: v.boolean(),
    deliveredAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_task_and_delivered", ["taskId", "delivered"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

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
  }).index("by_task", ["taskId"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

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
  }).index("by_task", ["taskId"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  // Lifecycle state history (for recoverability)
  lifecycleHistory: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    state: v.string(),
    prevState: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_task", ["taskId"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  // Provider Connections (spec §4A) — reusable connections shared by all
  // projects/agents. Models live in llmModels (§4B); a connection can offer
  // many models. NOTE (Phase 2, additive step): the legacy `model` column
  // and the plaintext `apiKey` column are still declared so existing rows
  // validate; new writes store the key ONLY as `apiKeyCiphertext`
  // (AES-256-GCM, see lib/llmCrypto.ts) and the migration moves `model` into
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
    // Settings preset the connection was added from (lib/llmPresets.ts).
    // Additive; unset on rows added before presets existed.
    presetId: v.optional(v.string()),
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
    // Place in the one model list across connections (lib/llmOrder.ts):
    // the fallback order, and the rotation start priority in round robin.
    // Additive; unset rows sort after positioned ones by connection
    // priority, which is the order they had before the list existed.
    position: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider", ["providerId"])
    .index("by_provider_and_model", ["providerId", "modelId"]),

  // Global LLM selection mode (plan 032): one row for the whole app —
  // "fallback" (top priority first, fail over on error) or "round_robin"
  // (rotate the starting provider). Read by the worker through the run
  // context; it carries no credential material.
  llmSelectionSettings: defineTable({
    mode: llmSelectionModeValidator,
    updatedAt: v.number(),
  }),

  // App-wide OpenCode runtime (plan 035): one row for the whole app — the
  // runtime ("api" = Fhara's own tools, "opencode" = the CLI) and the model
  // the CLI runs ("provider/model"; empty = Fhara's own LLM). The CLI and its
  // credentials belong to the worker, so the choice is global, not per agent.
  // Read by the worker through the run context; no credential material.
  opencodeSettings: defineTable({
    runtime: v.union(v.literal("api"), v.literal("opencode")),
    model: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  // Context summaries (plan 006 Phase 3): deterministic LLM summaries of a
  // conversation's tail so prompts carry a bounded summary + last 12 instead
  // of the full history. Scoped retrieval is served by `by_conversation` with
  // a `beforeCreationTime` cursor in descending order; `by_project` serves
  // admin listing.
  contextSummaries: defineTable({
    conversationId: v.id("conversations"),
    // Optional since plan 039 (personal conversations have no project).
    projectId: v.optional(v.id("projects")),
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
  // One GitHub account for the whole deployment (single-owner app). Every
  // project pushes, opens PRs and lists repos with this token; a project
  // keeps only its repo binding + webhook secret in `integrations`.
  // Tokens are AES-GCM ciphertext (lib/llmCrypto, PROVIDER_ENCRYPTION_KEY).
  githubConnections: defineTable({
    scope: v.literal("global"),
    // Viewer that connected it (auth subject), when an identity was present.
    ownerId: v.optional(v.string()),
    login: v.optional(v.string()),
    accessTokenCiphertext: v.optional(v.string()),
    refreshTokenCiphertext: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("error"), v.literal("disconnected")),
    errorMessage: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    // Set when the migration promoted a legacy per-project row.
    migratedFromIntegrationId: v.optional(v.id("integrations")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_scope", ["scope"]),

  // Signed OAuth `state` nonces: created by integrations.getOAuthUrl,
  // consumed exactly once by the callback, pruned after an hour.
  oauthStates: defineTable({
    nonce: v.string(),
    provider: v.literal("github"),
    ownerId: v.optional(v.string()),
    returnTo: v.optional(v.string()),
    createdAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_nonce", ["nonce"])
    .index("by_createdAt", ["createdAt"]),

  // Per-project GitHub repo binding (owner/repo/base branch) + webhook
  // secret. `accessToken`/`refreshToken` are LEGACY (pre-global, plaintext):
  // read only as a fallback until migrateGithubToGlobal promotes one to
  // `githubConnections` and clears them.
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
    // Plan 019 (additive): PR base branch for task pushes (default: the
    // repository's default branch, else "main").
    githubBaseBranch: v.optional(v.string()),
    // GitHub webhook secret, AES-GCM ciphertext (lib/llmCrypto, the
    // PROVIDER_ENCRYPTION_KEY format). Never returned to a client; the
    // plaintext is shown once when generated.
    webhookSecret: v.optional(v.string()),
    webhookSecretSetAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("error"), v.literal("disconnected")),
    errorMessage: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_type", ["type"])
    .index("by_project_and_type", ["projectId", "type"]),

  // Plan 019: one row per committed task branch that can be pushed to
  // GitHub. The push card in chat reads this row live; the worker claims
  // `requested` rows with a lease (same pattern as tasks/messages).
  taskPushes: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    messageId: v.optional(v.id("messages")),
    branchName: v.string(),
    commitSha: v.string(),
    commitMessage: v.string(),
    filesChanged: v.number(),
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    ahead: v.optional(v.number()),
    behind: v.optional(v.number()),
    // Local branch ahead/behind were measured against.
    comparedTo: v.optional(v.string()),
    status: pushStatus,
    openPr: v.optional(v.boolean()),
    // The approved `git_push` approval row the user's click created.
    approvalId: v.optional(v.id("approvals")),
    // Set by the card's Hold button; cleared when the push is requested.
    heldAt: v.optional(v.number()),
    requestedAt: v.optional(v.number()),
    workerId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    attempts: v.number(),
    error: v.optional(v.string()),
    pushedAt: v.optional(v.number()),
    baseBranch: v.optional(v.string()),
    repoFullName: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    prUrl: v.optional(v.string()),
    prTitle: v.optional(v.string()),
    prState: v.optional(prState),
    prCheckedAt: v.optional(v.number()),
    // Post-push feedback loop (additive). A fix task's push row names the
    // task that owns the PR; unset = this row's own task.
    ownerTaskId: v.optional(v.id("tasks")),
    // PR facts from webhooks and the refresh cron, copied onto every row of
    // the same PR. CI is tracked for the PR head commit only.
    headSha: v.optional(v.string()),
    ciState: v.optional(prCiState),
    ciChecks: v.optional(v.array(prCheckFact)),
    reviewState: v.optional(prReviewState),
    mergeable: v.optional(prMergeable),
    lastCommentAt: v.optional(v.number()),
    prFactsAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_owner_task", ["ownerTaskId"])
    .index("by_repo_pr", ["repoFullName", "prNumber"])
    .index("by_task_and_sha", ["taskId", "commitSha"])
    .index("by_status_and_requested", ["status", "requestedAt"])
    .index("by_status_and_lease", ["status", "leaseExpiresAt"])
    .index("by_pr_state_and_checked", ["prState", "prCheckedAt"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  // Post-push feedback loop: one row per PR signal that Fhara reacts to,
  // deduped on (PR, signature). `created` rows count toward the per-PR
  // fix cap (FHARA_PR_FIX_MAX_ATTEMPTS, default 3).
  prReactions: defineTable({
    projectId: v.id("projects"),
    ownerTaskId: v.id("tasks"),
    pushId: v.id("taskPushes"),
    repoFullName: v.string(),
    prNumber: v.number(),
    kind: prFixKind,
    // ci:<sha> · review:<id> · conflict:<sha>
    signature: v.string(),
    headSha: v.optional(v.string()),
    // Webhook context the fix prompt falls back to when the API is down.
    context: v.optional(v.any()),
    status: v.union(
      v.literal("scheduled"),
      v.literal("deferred"),
      v.literal("created"),
      v.literal("skipped")
    ),
    skipReason: v.optional(v.string()),
    fixTaskId: v.optional(v.id("tasks")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pr_and_signature", ["repoFullName", "prNumber", "signature"])
    .index("by_pr_and_status", ["repoFullName", "prNumber", "status"])
    .index("by_owner_task", ["ownerTaskId"])
    .index("by_project", ["projectId"]),

  // Stored "needs you" notifications. Recomputed from PR facts and task
  // state, so a notification resolves itself when what raised it changes.
  notifications: defineTable({
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    pushId: v.optional(v.id("taskPushes")),
    kind: notificationKind,
    title: v.string(),
    detail: v.optional(v.string()),
    url: v.optional(v.string()),
    // `${taskId}:${kind}`: at most one open row per task and kind.
    dedupeKey: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_dedupe_and_status", ["dedupeKey", "status"])
    .index("by_status_and_updated", ["status", "updatedAt"])
    .index("by_task_and_status", ["taskId", "status"])
    .index("by_project", ["projectId"]),

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
    .index("by_project", ["projectId"])
    // Webhook replay dedupe: one row per X-GitHub-Delivery id.
    .index("by_delivery", ["deliveryId"]),

  // MCP server connections (Plan 007 Phase 1 — UI config only)
  mcpServers: defineTable({
    // Integrations: no projectId = a GLOBAL server, delivered to every
    // project's runs. A run gets global + its own project's servers.
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    type: v.union(v.literal("local"), v.literal("remote")),
    url: v.optional(v.string()), // for remote: HTTP endpoint
    command: v.optional(v.string()), // for local: executable
    args: v.optional(v.string()), // JSON-encoded string[] for local
    status: v.union(
      v.literal("connected"),
      v.literal("disconnected"),
      v.literal("error"),
      v.literal("untested")
    ),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    // Plan 009: worker-facing MCP config. All optional — a row written
    // before this plan has no value and is treated as enabled/lazy.
    enabled: v.optional(v.boolean()),
    autoConnect: v.optional(v.boolean()),
    transport: v.optional(v.string()), // "stdio" (only supported today)
    allowedDirectories: v.optional(v.array(v.string())),
    // Integrations page (all additive). `preset` is a lib/mcpPresets id;
    // missing = legacy filesystem-style row.
    preset: v.optional(v.string()),
    // Role allowlist (lib/roles keys). Missing/empty = every role.
    agentRoles: v.optional(v.array(v.string())),
    // Extra tool names a custom/non-filesystem server may expose (read-level).
    toolAllowlist: v.optional(v.array(v.string())),
    // Env for the child process, JSON {KEY: value} encrypted with
    // lib/llmCrypto (PROVIDER_ENCRYPTION_KEY). Only `envKeys` reaches the
    // browser; the worker decrypts at spawn.
    envCiphertext: v.optional(v.string()),
    envKeys: v.optional(v.array(v.string())),
    // GitHub preset: copy the project's OAuth token into the env on connect.
    useGithubOAuth: v.optional(v.boolean()),
    // "Test connection": the web sets testRequestedAt; a worker claims it
    // (lease) and reports the outcome.
    testRequestedAt: v.optional(v.number()),
    testWorkerId: v.optional(v.string()),
    testLeaseExpiresAt: v.optional(v.number()),
    lastTestedAt: v.optional(v.number()),
    toolCount: v.optional(v.number()),
    toolNames: v.optional(v.array(v.string())),
    updatedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_test_requested", ["testRequestedAt"])
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

  // Second Opinion + Shadow Agent: read-only Reviewer results. A second
  // opinion (user-requested, one subtask or one chat reply) carries a
  // verdict; a shadow review (automatic, after each completed subtask of a
  // task with shadowAgent on) carries notes. Neither ever changes the run.
  reviewOpinions: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    subtaskKey: v.optional(v.string()),
    messageId: v.optional(v.id("messages")),
    conversationId: v.optional(v.id("conversations")),
    mode: v.union(v.literal("second_opinion"), v.literal("shadow")),
    target: v.union(v.literal("subtask"), v.literal("chat")),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("skipped")),
    verdict: v.optional(v.union(v.literal("agree"), v.literal("concerns"), v.literal("disagree"))),
    reason: v.optional(v.string()),
    evidence: v.optional(v.array(reviewEvidenceValidator)),
    notes: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("risk"), v.literal("missed_requirement"), v.literal("suggestion")),
          text: v.string(),
          evidence: v.array(reviewEvidenceValidator),
        })
      )
    ),
    model: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    toolCalls: v.optional(v.number()),
    error: v.optional(v.string()),
    // "Replan with this note": when the user sent this opinion to the
    // planner, and how it landed (replanned / requeued / steered).
    replanRequestedAt: v.optional(v.number()),
    replanOutcome: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_message", ["messageId"])
    .index("by_project_and_target", ["projectId", "target"]),

  // Incident Room: one record per failure worth a look (task failed,
  // subtask escalated / blocked), grouping where it failed, the error, the
  // last events, the escalation and related audit rows.
  incidents: defineTable({
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    trigger: v.union(v.literal("task_failed"), v.literal("subtask_escalated"), v.literal("subtask_blocked")),
    status: v.union(v.literal("open"), v.literal("resolved")),
    title: v.string(),
    subtaskKey: v.optional(v.string()),
    failurePoint: v.optional(
      v.object({ subtaskKey: v.optional(v.string()), title: v.optional(v.string()), role: v.optional(v.string()), stage: v.optional(v.string()) })
    ),
    error: v.optional(v.string()),
    lastEvents: v.array(
      v.object({
        type: v.string(),
        level: v.optional(v.string()),
        subtaskKey: v.optional(v.string()),
        text: v.optional(v.string()),
        at: v.number(),
      })
    ),
    escalation: v.optional(escalationValidator),
    auditIds: v.array(v.id("audit")),
    owner: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_status", ["status"]),

  // Workflow Studio (plan 030): user-defined agent-workflow DAGs, persisted
  // backend-side like every other Fhara store. Additive: a fresh table, no
  // legacy rows, no migration. The studio UI was removed by user request, so
  // nothing reads or writes this table any more; it is kept (not dropped) so
  // stored definitions are not destroyed. The execution mapping into
  // ExecutionPlan subtasks was never implemented.
  workflows: defineTable({
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    nodes: v.array(workflowNodeValidator),
    edges: v.array(workflowEdgeValidator),
  })
    .index("by_updated", ["updatedAt"]),

  // Self-Improvement Lab: an LLM-proposed change to a prompt, skill or role
  // config after a failed run. Applied only on the user's Apply (audited).
  improvementSuggestions: defineTable({
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    incidentId: v.optional(v.id("incidents")),
    status: v.union(
      v.literal("running"),
      v.literal("ready"),
      v.literal("no_change"),
      v.literal("applied"),
      v.literal("dismissed"),
      v.literal("error")
    ),
    targetKind: v.optional(v.union(v.literal("agent_prompt"), v.literal("skill"), v.literal("role_prompt"))),
    targetId: v.optional(v.string()),
    targetLabel: v.optional(v.string()),
    baseText: v.optional(v.string()),
    proposedText: v.optional(v.string()),
    diff: v.optional(v.string()),
    rationale: v.optional(v.string()),
    error: v.optional(v.string()),
    model: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_incident", ["incidentId"])
    .index("by_task", ["taskId"])
    .index("by_status", ["status"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  // Library: reusable agent skills (markdown instructions). Attached to
  // agents via `agents.skillIds` and appended to their prompt at run time.
  skills: defineTable({
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    tags: v.optional(v.array(v.string())),
    // Set on skills imported from GitHub (skills.importFromGithub). `sha` is
    // the commit the content was read at; re-import overwrites when it moves.
    source: v.optional(
      v.object({
        kind: v.literal("github"),
        repo: v.string(), // "owner/repo"
        path: v.string(), // repo-relative SKILL.md path
        sha: v.string(),
        license: v.optional(v.string()), // SPDX id, e.g. "MIT"
        licenseUrl: v.optional(v.string()),
        url: v.string(), // html URL of the SKILL.md at `sha`
      })
    ),
    // True when the stored body was cut: before Skill v2 imports were
    // trimmed to the inline cap; since v2 only past SKILL_STORED_MAX.
    trimmed: v.optional(v.boolean()),
    // Skill v2: latest version number (skillVersions). Unset on skills
    // written before v2 until their first edit/import/backfill.
    version: v.optional(v.number()),
    // Skills this one needs; assigning it pulls them in (lib/skillGraph.ts).
    requires: v.optional(v.array(v.id("skills"))),
    // Tools/permissions it needs (advisory: warns, never grants).
    permissions: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  // Skill v2: one row per saved version of a skill (create, edit, import
  // update, rollback). Agents can pin one (agents.skillPins).
  skillVersions: defineTable({
    skillId: v.id("skills"),
    version: v.number(),
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    tags: v.optional(v.array(v.string())),
    requires: v.optional(v.array(v.id("skills"))),
    permissions: v.optional(v.array(v.string())),
    // Commit the content was imported at (GitHub skills).
    sourceSha: v.optional(v.string()),
    author: v.string(),
    kind: v.union(
      v.literal("baseline"),
      v.literal("create"),
      v.literal("edit"),
      v.literal("import"),
      v.literal("rollback")
    ),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_skill", ["skillId", "version"]),

  // Custom agent templates (built-ins live in code: lib/agentTemplates.ts).
  // A template prefills a new agent: role, instructions, library skills,
  // optional LLM preference, runtime and avatar.
  agentTemplates: defineTable({
    name: v.string(),
    role: v.string(),
    description: v.string(),
    systemPrompt: v.string(),
    skillIds: v.optional(v.array(v.id("skills"))),
    llmProviderId: v.optional(v.id("llmProviders")),
    llmModelId: v.optional(v.id("llmModels")),
    runtime: v.optional(v.union(v.literal("api"), v.literal("opencode"))),
    opencodeModel: v.optional(v.string()),
    avatarParams: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
    // Always false for rows; built-in templates are never stored.
    builtIn: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  // Memory: markdown notes agents carry between runs. Pinned rows are
  // injected as a "## Memory" section after the skills (lib/memory.ts):
  // shared → project (projectId) → agent (agentId). Unpinned rows are
  // reference-only for now.
  memories: defineTable({
    scope: v.union(v.literal("shared"), v.literal("project"), v.literal("agent")),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    title: v.string(),
    content: v.string(),
    tags: v.optional(v.array(v.string())),
    pinned: v.boolean(),
    source: v.union(v.literal("user"), v.literal("agent")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scope", ["scope", "pinned"])
    .index("by_project", ["projectId", "scope"])
    .index("by_agent", ["agentId"]),

  // Context Snapshot (additive): one light row per LLM call — who, what for,
  // model, tokens, per-section token estimates, error. The prompt and
  // response text live in contextSnapshotBodies so list queries stay light.
  // Pruned by the daily cron after the project's retention (default 14 days).
  contextSnapshots: defineTable({
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    subtaskId: v.optional(v.id("subtasks")),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    messageId: v.optional(v.id("messages")),
    conversationId: v.optional(v.id("conversations")),
    agentId: v.optional(v.id("agents")),
    agentRole: v.optional(v.string()),
    callRole: v.string(),
    source: v.union(v.literal("worker"), v.literal("chat")),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    temperature: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    usageEstimated: v.optional(v.boolean()),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
    sectionStats: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        chars: v.number(),
        tokens: v.number(),
        truncated: v.optional(v.boolean()),
      })
    ),
    promptTokens: v.number(),
    toolNames: v.array(v.string()),
    skillNames: v.array(v.string()),
    memoryIncluded: v.boolean(),
    historyMessages: v.number(),
    truncated: v.boolean(),
    bytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId", "createdAt"])
    .index("by_message", ["messageId"])
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_created", ["createdAt"]),

  contextSnapshotBodies: defineTable({
    snapshotId: v.id("contextSnapshots"),
    sections: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        content: v.string(),
        truncatedChars: v.optional(v.number()),
      })
    ),
    response: v.string(),
    responseTruncatedChars: v.optional(v.number()),
  }).index("by_snapshot", ["snapshotId"]),

  // Decision Outcome Calibration: one row per orchestrator decision,
  // derived from the event that recorded it (lib/calibration/capture.ts),
  // and its deterministic outcome once the subtask/task ends.
  decisions: defineTable({
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    subtaskKey: v.optional(v.string()),
    type: decisionTypeValidator,
    chosen: v.string(),
    alternatives: v.array(v.string()),
    reason: v.optional(v.string()),
    expected: v.optional(decisionExpectedValidator),
    snapshotId: v.optional(v.id("contextSnapshots")),
    sourceEventId: v.optional(v.id("taskEvents")),
    dedupeKey: v.string(),
    agentId: v.optional(v.id("agents")),
    agentName: v.optional(v.string()),
    capability: v.optional(v.string()),
    role: v.optional(v.string()),
    planVersion: v.optional(v.number()),
    meta: v.optional(v.any()),
    decidedAt: v.number(),
    outcome: v.optional(decisionOutcomeValidator),
    label: v.optional(outcomeLabelValidator),
    backfilled: v.optional(v.boolean()),
  })
    .index("by_task", ["taskId", "decidedAt"])
    .index("by_dedupe", ["dedupeKey"])
    .index("by_project", ["projectId", "decidedAt"])
    .index("by_decided", ["decidedAt"]),

  // Apply / Dismiss on a calibration recommendation (audited).
  calibrationActions: defineTable({
    projectId: v.optional(v.id("projects")),
    recId: v.string(),
    action: v.union(v.literal("applied"), v.literal("dismissed")),
    title: v.string(),
    change: v.optional(v.any()),
    actor: v.string(),
    createdAt: v.number(),
  })
    .index("by_rec", ["recId", "createdAt"])
    .index("by_created", ["createdAt"])
    // Project delete cascade (projects.cascadeDelete).
    .index("by_project", ["projectId"]),

  // Plan 034: the OpenCode model list a worker read from its local CLI
  // (`opencode models`). One row per worker; the UI reads the freshest row so
  // the agent editor can offer the models that CLI can actually run.
  opencodeModelCatalog: defineTable({
    workerId: v.string(),
    hostname: v.optional(v.string()),
    // `provider/model` ids, capped by the reporter.
    models: v.array(v.string()),
    // False when the CLI is missing or the listing failed.
    available: v.boolean(),
    error: v.optional(v.string()),
    // The binary that was asked (ORCHESTRATOR_NATIVE_PROVIDER_COMMAND).
    command: v.optional(v.string()),
    updatedAt: v.number(),
    // Set by the UI ("Refresh"); the worker picks it up on its next poll and
    // clears it by reporting again.
    refreshRequestedAt: v.optional(v.number()),
    // OpenCode provider (plan 038, additive): what the worker's detection
    // found. `installed` = the binary was found (on PATH or at the
    // configured command path); `version` = `opencode --version`; `path` =
    // where it was found. Rows written before plan 038 have none of these
    // and read as "not checked yet".
    installed: v.optional(v.boolean()),
    version: v.optional(v.string()),
    path: v.optional(v.string()),
    // "Test" in Settings: the UI asks, the worker runs a tiny
    // `opencode run` probe on its next poll and stores the result.
    testRequestedAt: v.optional(v.number()),
    testModel: v.optional(v.string()),
    testResult: v.optional(
      v.object({
        ok: v.boolean(),
        latencyMs: v.number(),
        model: v.optional(v.string()),
        error: v.optional(v.string()),
        at: v.number(),
      })
    ),
  })
    .index("by_worker_id", ["workerId"])
    .index("by_updated_at", ["updatedAt"]),
});
