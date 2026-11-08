function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export interface ExecutionPolicy {
  maxSubtasks: number;
  maxConcurrency: number;
  maxReplans: number;
  /**
   * Spec vocabulary alias for maxReplans (spec §7): the single bound on
   * planning iterations (initial plan + replans). loadPolicy always sets
   * it; consumers fall back to maxReplans when a hand-built policy omits it.
   */
  maxPlanningIterations?: number;
  maxReviewIterations: number;
  subtaskTimeoutMs: number;
  subtaskRetries: number;
  approvalTimeoutMs: number;
  /**
   * Phase 4: LIVE task deadline. The runner arms one AbortController per
   * task with this timeout; when it fires, in-flight LLM calls, QA and
   * verification are aborted and the task ends instead of running on.
   */
  taskTimeoutMs: number;
  verificationEnabled: boolean;
  verificationIncludeBuild: boolean;
  verificationTimeoutMs: number;
  // Intelligent orchestrator budgets (configurable, not hardcoded assumptions)
  maxAgentsPerTask: number;
  maxLLMCallsPerTask: number;
  maxDelegationDepth: number;
  /**
   * Spec §7 vocabulary: the maximum number of APPROVED delegations in one
   * task (a task-wide COUNT, distinct from maxDelegationDepth, which is
   * the per-branch chain depth enforced from the subtask chain since
   * Phase 3). Read by the delegation gate (delegation.ts) and by
   * BudgetTracker.isBudgetExhausted. Optional: hand-built policies that
   * omit it disable the count gate.
   */
  maxDelegations?: number;
  /**
   * Phase 5 budget enforcement mode:
   *  - "enforce": a pre-call gate throws BudgetExhaustedError when the
   *    task's LLM call / token budget is spent; the runner ends the task
   *    with an explicit budget.exhausted status.
   *  - "warn": the same exhaustion only emits a budget.warning event and
   *    the task runs on.
   * Default is "warn" for this release cycle (see loadPolicy) so the new
   * hard stop is observed in the wild before it becomes the default.
   */
  budgetMode?: "warn" | "enforce";
  maxConcurrentLLMCalls: number;
  maxTokenBudgetPerTask: number;
  /**
   * Whether capability routing may fall back to the highest-priority
   * enabled agent when no agent actually serves a capability (Phase 3).
   * When false, routing returns no agent and delegation reports a real
   * BLOCKED instead of silently running the wrong agent.
   */
  allowFallback?: boolean;
  /**
   * Phase 3: when true, the orchestrator owns execution decisions — its
   * plan is the one executed and its APPROVE/REVISE/BLOCKED decisions add
   * real subtasks / halt scheduling. When false, the legacy path runs:
   * planner plan directly, orchestrator decisions recorded only.
   */
  orchestratorAuthoritative?: boolean;
  /**
   * Plan 006 Phase 1: when the intent router is unsure, who decides.
   *  - "off": ambiguous input always becomes a chat answer (fails closed).
   *  - "ambiguous": only the ambiguous case consults the LLM advisor.
   *  - "always": the advisor is consulted on every message.
   */
  routerLlmMode?: "off" | "ambiguous" | "always";
  /** Plan 006 Phase 1: cap on agents answering one chat message. */
  chatMaxAgents?: number;
  /**
   * Plan 006 Phase 2: when the decision advisor is consulted.
   *  - "off": never (pure deterministic engine).
   *  - "ambiguous": only when the deterministic engine returns "ambiguous".
   *  - "always": on every observation (A/B comparison).
   */
  decisionLlmMode?: "off" | "ambiguous" | "always";
  /** Plan 006 Phase 2: bound on decision steps per task run. */
  maxDecisionSteps?: number;
  /**
   * Plan 005 Phase 3 (progressive planning): when a review node is added
   * for a code change.
   *  - "always": every code change gets a review node (legacy behaviour).
   *  - "auto": only on a risk signal (auth/security/payments/migrations/
   *    concurrency, multi-capability, multi-domain, or an agent explicitly
   *    offering review capability).
   *  - "never": the orchestrator never adds a review node (the plan's own
   *    review node, if any, is kept — hints never remove plan nodes).
   */
  toolLoop?: boolean;
  /**
   * Plan 009: MCP filesystem tool loop.
   *  - `mcpToolLoop`: when true, read-only agents may use discovered MCP
   *    tools mid-task. Default true (an absent server just means no tools).
   *  - `mcpWriteTools`: when false (default), write/edit/mkdir/move/delete
   *    MCP tools are filtered for every role — `code_change` owns writes
   *    through the approval-gated diff pipeline.
   *  - `mcpMaxToolIterations`: bound on tool-loop rounds per subtask.
   *  - `mcpTimeoutMs`: per-MCP-request timeout (a hung server is killed).
   *  - `mcpMaxResultChars`: cap on a tool result before it reaches the LLM.
   * All optional so hand-built policies (tests) keep working unchanged.
   */
  mcpToolLoop?: boolean;
  mcpWriteTools?: boolean;
  mcpMaxToolIterations?: number;
  mcpTimeoutMs?: number;
  mcpMaxResultChars?: number;
  reviewMode?: "always" | "auto" | "never";
  /**
   * Plan 005 Phase 3: when a QA node is added for a code change.
   *  - "always": every code change gets a QA node when a QA agent exists.
   *  - "auto": only with a QA agent, a code change, and a risk signal, a
   *    verification request, or a project QA/dev URL.
   *  - "never": the orchestrator never adds a QA node.
   */
  qaMode?: "always" | "auto" | "never";
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/** "always" | "auto" | "never" from env, defaulting to "auto". */
function planningModeFromEnv(name: string): "always" | "auto" | "never" {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "always" || raw === "auto" || raw === "never" ? raw : "auto";
}

export function loadPolicy(): ExecutionPolicy {
  const maxReplans = intFromEnv("ORCHESTRATOR_MAX_REPLANS", 1, 0, 3);
  return {
    maxSubtasks: intFromEnv("ORCHESTRATOR_MAX_SUBTASKS", 8, 1, 20),
    maxConcurrency: intFromEnv("ORCHESTRATOR_MAX_CONCURRENCY", 2, 1, 8),
    maxReplans,
    // Spec alias: defaults to the maxReplans value so the two never drift;
    // ORCHESTRATOR_MAX_PLANNING_ITERATIONS overrides the iteration bound
    // directly when set.
    maxPlanningIterations: intFromEnv(
      "ORCHESTRATOR_MAX_PLANNING_ITERATIONS",
      maxReplans,
      0,
      3
    ),
    maxReviewIterations: intFromEnv("ORCHESTRATOR_MAX_REVIEW_ITERATIONS", 2, 0, 5),
    subtaskTimeoutMs: intFromEnv("ORCHESTRATOR_SUBTASK_TIMEOUT_MS", 300_000, 30_000, 300_000),
    subtaskRetries: intFromEnv("ORCHESTRATOR_SUBTASK_RETRIES", 1, 0, 3),
    approvalTimeoutMs: intFromEnv("ORCHESTRATOR_APPROVAL_TIMEOUT_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
    taskTimeoutMs: intFromEnv("ORCHESTRATOR_TASK_TIMEOUT_MS", 5 * 60_000, 60_000, 5 * 60_000),
    verificationEnabled: boolFromEnv("ORCHESTRATOR_VERIFICATION_ENABLED", true),
    verificationIncludeBuild: boolFromEnv("ORCHESTRATOR_VERIFICATION_BUILD", true),
    verificationTimeoutMs: intFromEnv("ORCHESTRATOR_VERIFICATION_TIMEOUT_MS", 300_000, 30_000, 300_000),
    // Intelligent orchestrator defaults from spec, env-overridable
    maxAgentsPerTask: intFromEnv("ORCHESTRATOR_MAX_AGENTS_PER_TASK", 3, 1, 10),
    // Default raised 5 -> 12: a healthy task spends calls on planning, one
    // implementation attempt + retry, review, and possible fix rounds, so a
    // limit of 5 killed normal tasks once the tracker was actually fed.
    maxLLMCallsPerTask: intFromEnv("ORCHESTRATOR_MAX_LLM_CALLS_PER_TASK", 12, 1, 50),
    maxDelegationDepth: intFromEnv("ORCHESTRATOR_MAX_DELEGATION_DEPTH", 2, 0, 10),
    maxDelegations: intFromEnv("ORCHESTRATOR_MAX_DELEGATIONS", 10, 0, 100),
    // Phase 5: warn-only by default for ONE release cycle — the pre-call
    // gate logs budget.warning events instead of stopping tasks, so the
    // calibrated limits (12 calls / 50k tokens) can be observed against
    // real workloads before hard-stop enforcement becomes the default.
    // Set ORCHESTRATOR_BUDGET_MODE=enforce to opt into the hard stop now.
    budgetMode:
      (process.env.ORCHESTRATOR_BUDGET_MODE ?? "").trim().toLowerCase() === "enforce"
        ? "enforce"
        : "warn",
    // Phase 4: this field is LIVE. Phase 4 hardening: it sizes the
    // PER-TASK LLM gate — the runner creates one LlmConcurrencyGate per
    // task run from this value, so concurrent tasks each honor their
    // own policy. The separate WORKER-WIDE gate (total provider
    // pressure across tasks) is worker configuration: the
    // WORKER_LLM_MAX_CONCURRENCY env var, bootstrapped once from this
    // policy value by the worker entrypoint — never resized per task.
    // Default 2: a limit of 1 serialized every LLM call of a task
    // (planner, parallel subtasks, review) behind a single slot, which
    // silently defeated the plan's own DAG parallelism; 2 keeps a real
    // bound on provider pressure without serializing the graph.
    maxConcurrentLLMCalls: intFromEnv("ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", 2, 1, 8),
    maxTokenBudgetPerTask: intFromEnv("ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK", 50_000, 1_000, 500_000),
    allowFallback: boolFromEnv("ORCHESTRATOR_ALLOW_FALLBACK", true),
    orchestratorAuthoritative: boolFromEnv("ORCHESTRATOR_AUTHORITATIVE", true),
    // Plan 006 Phase 1: the router is deterministic by default; the advisor
    // turns on only when the flag is set (Phase 4 wires the real call).
    routerLlmMode:
      (process.env.ORCHESTRATOR_ROUTER_LLM ?? "").trim().toLowerCase() ===
      "always"
        ? "always"
        : (process.env.ORCHESTRATOR_ROUTER_LLM ?? "").trim().toLowerCase() ===
            "ambiguous"
          ? "ambiguous"
          : "off",
    chatMaxAgents: intFromEnv("ORCHESTRATOR_CHAT_MAX_AGENTS", 1, 1, 5),
    // Plan 013 step 7: the decision engine is the only orchestrator path
    // (flag deleted; default is irrevocably on).
    // Plan 005 Phase 4 Step 4.3 (enabled once Phase 4 tests went green):
    // the advisor is consulted only on ambiguous observations; the
    // deterministic policy decisions still win via validateDecision.
    decisionLlmMode:
      (process.env.ORCHESTRATOR_DECISION_LLM ?? "").trim().toLowerCase() === "always"
        ? "always"
        : (process.env.ORCHESTRATOR_DECISION_LLM ?? "").trim().toLowerCase() === "off"
          ? "off"
          : "ambiguous",
    maxDecisionSteps: intFromEnv("ORCHESTRATOR_MAX_DECISION_STEPS", 20, 1, 200),
    toolLoop: boolFromEnv("ORCHESTRATOR_TOOL_LOOP", false),
    mcpToolLoop: boolFromEnv("ORCHESTRATOR_MCP_TOOL_LOOP", true),
    mcpWriteTools: boolFromEnv("ORCHESTRATOR_MCP_WRITE_TOOLS", false),
    mcpMaxToolIterations: intFromEnv("ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS", 6, 1, 20),
    mcpTimeoutMs: intFromEnv("ORCHESTRATOR_MCP_TIMEOUT_MS", 30_000, 1_000, 300_000),
    mcpMaxResultChars: intFromEnv("ORCHESTRATOR_MCP_MAX_RESULT_CHARS", 8_000, 500, 200_000),
    reviewMode: planningModeFromEnv("ORCHESTRATOR_REVIEW_MODE"),
    qaMode: planningModeFromEnv("ORCHESTRATOR_QA_MODE"),
  };
}
