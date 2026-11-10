import { executionRuntimeFromEnv } from "@/execution/nativeProvider";
import { observedLlmLatencyMs } from "@/llm/latency";

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
  /**
   * True when ORCHESTRATOR_SUBTASK_TIMEOUT_MS was set explicitly: the
   * operator's value is used as-is (no latency-aware growth).
   */
  subtaskTimeoutFromEnv?: boolean;
  /**
   * Subtask timeout for high/ultra complexity tasks
   * (ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS). Applied by policyForComplexity;
   * hand-built policies that omit it keep subtaskTimeoutMs for every task.
   */
  subtaskTimeoutMsHigh?: number;
  /** Task deadline for high/ultra complexity tasks (ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS). */
  taskTimeoutMsHigh?: number;
  subtaskRetries: number;
  approvalTimeoutMs: number;
  /**
   * Phase 4: LIVE task deadline. The runner arms one AbortController per
   * task with this timeout; when it fires, in-flight LLM calls, QA and
   * verification are aborted and the task ends instead of running on.
   */
  taskTimeoutMs: number;
  /**
   * MausBot-style turn timeout: the task aborts only when it made NO
   * observable progress (any backend event, usage, or staged change) for
   * this long, instead of a fixed wall-clock deadline. 0 disables it.
   */
  idleTimeoutMs?: number;
  /**
   * Planning watchdog: one planner call (initial plan or a replan) that
   * has not returned after this long is treated as stalled; the task is
   * failed with a visible reason instead of staying in planning. 0
   * disables it.
   */
  planningStallMs?: number;
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
   * Plan 014 (provider-native runtime): which execution runtime serves
   * subtasks.
   *  - "api" (default): the agent's LLM calls drive Fhara's own host
   *    tools (governance registry, sandbox, allowlist) — fully gated.
   *  - "native-provider": the provider CLI runs its own native tools in
   *    the task workspace (danger-full-access per the recorded Plan 014
   *    decision). Host tools stay for the `api` path.
   */
  executionRuntime?: "api" | "native-provider";
  worktreeIsolation?: boolean;
  /**
   * Plan 006 Phase 2: when the decision advisor is consulted.
   *  - "off": never (pure deterministic engine).
   *  - "ambiguous": only when the deterministic engine returns "ambiguous".
   *  - "always": on every observation (A/B comparison).
   */
  decisionLlmMode?: "off" | "ambiguous" | "always";
  /** Plan 006 Phase 2: bound on decision steps per task run. */
  maxDecisionSteps?: number;
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
  /**
   * Plan 036: the Agent Reach web tool for read-only agents.
   *  - `agentReachEnabled`: when true (default), an agent that declares
   *    `web_reach` in its `supportedTools` may read public web content
   *    during a research or audit subtask. The tool is read-only and only
   *    the public channels are reachable.
   *  - `agentReachCommand`: the Agent Reach binary (default `agent-reach`).
   *  - `agentReachTimeoutMs`: wall-clock limit per Agent Reach call.
   *  - `agentReachMaxItems`: cap on the items one call returns.
   *  - `agentReachMaxToolIterations`: bound on the tool-loop rounds.
   * All optional so hand-built policies (tests) keep working unchanged.
   */
  agentReachEnabled?: boolean;
  agentReachCommand?: string;
  agentReachTimeoutMs?: number;
  agentReachMaxItems?: number;
  agentReachMaxToolIterations?: number;
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
  reviewMode?: "always" | "auto" | "never";
  /**
   * Plan 005 Phase 3: when a QA node is added for a code change.
   *  - "always": every code change gets a QA node when a QA agent exists.
   *  - "auto": only with a QA agent, a code change, and a risk signal, a
   *    verification request, or a project QA/dev URL.
   *  - "never": no QA node ever runs — planner hints, LLM-emitted qa
   *    nodes and browser-testing delegation are all filtered out.
   *  - "auto" (DEFAULT, loadPolicy / ORCHESTRATOR_QA_MODE): browser QA only
   *    when changes were applied AND the project is browser-runnable AND
   *    (UI files / frontend-design work OR an explicit QA/e2e/browser
   *    request). Environment problems → "blocked" QA (skipped with a note),
   *    never a fix loop or a failed task unless qaRequired.
   */
  qaMode?: "always" | "auto" | "never";
  /**
   * When true, an environment-blocked QA run (no browser, no deps, no dev
   * script) FAILS the task; otherwise it is reported as skipped and the
   * task can complete. Env: ORCHESTRATOR_QA_REQUIRED / QA_REQUIRED.
   */
  qaRequired?: boolean;
  /** Max automatic QA fix rounds (default 1). Falls back to maxReviewIterations when unset. */
  qaMaxFixIterations?: number;
  /**
   * Load-aware routing default (Workload Manager), used when the project
   * has no `loadAwareRouting` setting. Env ORCHESTRATOR_LOAD_AWARE_ROUTING,
   * default off.
   */
  loadAwareRouting?: boolean;
  /**
   * Performance routing default (plan 027), used when the project has no
   * `performanceRouting` setting. Env ORCHESTRATOR_PERFORMANCE_ROUTING,
   * default off.
   */
  performanceRouting?: boolean;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/** "always" | "auto" | "never" from env, defaulting to fallback ("auto"). */
function planningModeFromEnv(name: string, fallback: "auto" | "never" = "auto"): "always" | "auto" | "never" {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "always" || raw === "auto" || raw === "never" ? raw : fallback;
}

/** Default subtask timeout when ORCHESTRATOR_SUBTASK_TIMEOUT_MS is unset. */
export const DEFAULT_SUBTASK_TIMEOUT_MS = 900_000;
/** Latency-aware timeout: fixed headroom plus this many observed LLM calls. */
export const SUBTASK_LATENCY_BASE_MS = 120_000;
export const SUBTASK_LATENCY_CALLS = 4;
const SUBTASK_TIMEOUT_CAP_MS = 3_600_000;

/**
 * The timeout one subtask runs under: the policy value, grown to
 * `base + k × observed per-call LLM latency` when the model is slow (a
 * subtask makes several calls; a 6-min-per-call model needs ~26 min).
 * An explicit ORCHESTRATOR_SUBTASK_TIMEOUT_MS is used as-is. A native
 * (OpenCode) subtask always gets at least the native CLI timeout plus a
 * minute, so the scheduler never cuts the CLI off before its own limit.
 */
export function subtaskTimeoutFor(
  policy: Pick<ExecutionPolicy, "subtaskTimeoutMs" | "subtaskTimeoutFromEnv">,
  options: { latencyMs?: number; nativeTimeoutMs?: number } = {}
): number {
  let timeout = policy.subtaskTimeoutMs;
  if (!policy.subtaskTimeoutFromEnv) {
    const latency = options.latencyMs ?? observedLlmLatencyMs();
    if (latency > 0) timeout = Math.max(timeout, SUBTASK_LATENCY_BASE_MS + SUBTASK_LATENCY_CALLS * latency);
  }
  if (options.nativeTimeoutMs && options.nativeTimeoutMs > 0) {
    timeout = Math.max(timeout, options.nativeTimeoutMs + 60_000);
  }
  return Math.min(SUBTASK_TIMEOUT_CAP_MS, Math.floor(timeout));
}

export type TaskComplexity = "low" | "medium" | "high" | "ultra";

/**
 * The policy one task runs under: high/ultra complexity tasks get the
 * larger subtask timeout and task deadline (a multi-concern change with a
 * slow model cannot finish inside the low-complexity bounds). Never
 * shrinks a bound: the high values only apply when they are larger.
 */
export function policyForComplexity(policy: ExecutionPolicy, complexity?: TaskComplexity): ExecutionPolicy {
  if (complexity !== "high" && complexity !== "ultra") return policy;
  return {
    ...policy,
    subtaskTimeoutMs: Math.max(policy.subtaskTimeoutMs, policy.subtaskTimeoutMsHigh ?? 0),
    taskTimeoutMs: Math.max(policy.taskTimeoutMs, policy.taskTimeoutMsHigh ?? 0),
  };
}

/**
 * Default subtask parallelism. Parallel runs are on by default ONLY when
 * worktree isolation is on (the task runs in its own git worktree, never
 * in the user's checkout): then ORCHESTRATOR_PARALLEL_DEFAULT (default 2,
 * 1–3) independent, non-conflicting DAG nodes may run side by side.
 * Without isolation the default stays sequential (1). An explicit
 * ORCHESTRATOR_MAX_CONCURRENCY always wins.
 */
export function defaultParallelism(worktreeIsolation: boolean): number {
  if (!worktreeIsolation) return 1;
  return intFromEnv("ORCHESTRATOR_PARALLEL_DEFAULT", 2, 1, 3);
}

export function loadPolicy(): ExecutionPolicy {
  const maxReplans = intFromEnv("ORCHESTRATOR_MAX_REPLANS", 1, 0, 3);
  // Off by default: isolation fails tasks whose workspace is not a git
  // repo, and needs the Convex node action to share the worker's disk.
  const worktreeIsolation = boolFromEnv("ORCHESTRATOR_WORKTREE_ISOLATION", false);
  const parallelism = defaultParallelism(worktreeIsolation);
  return {
    maxSubtasks: intFromEnv("ORCHESTRATOR_MAX_SUBTASKS", 8, 1, 20),
    maxConcurrency: intFromEnv("ORCHESTRATOR_MAX_CONCURRENCY", parallelism, 1, 8),
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
    // Configurable up to 1h (was clamped to 300s, which a slow model
    // cannot meet on a multi-file change — e2e ULTRA).
    // Default 900s (was 300s): live tests 3/4 timed out medium native
    // (OpenCode) subtasks at 300s while one nous call takes 5-8 min. The
    // runner grows it further from observed latency (subtaskTimeoutFor).
    subtaskTimeoutMs: intFromEnv("ORCHESTRATOR_SUBTASK_TIMEOUT_MS", DEFAULT_SUBTASK_TIMEOUT_MS, 30_000, 3_600_000),
    subtaskTimeoutFromEnv: Boolean(process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS),
    subtaskTimeoutMsHigh: intFromEnv(
      "ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS",
      // 900s: one slow call (~280s on longcat) plus a full retry must fit.
      Math.max(900_000, intFromEnv("ORCHESTRATOR_SUBTASK_TIMEOUT_MS", DEFAULT_SUBTASK_TIMEOUT_MS, 30_000, 3_600_000)),
      30_000,
      3_600_000
    ),
    subtaskRetries: intFromEnv("ORCHESTRATOR_SUBTASK_RETRIES", 1, 0, 3),
    approvalTimeoutMs: intFromEnv("ORCHESTRATOR_APPROVAL_TIMEOUT_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
    taskTimeoutMs: intFromEnv("ORCHESTRATOR_TASK_TIMEOUT_MS", 20 * 60_000, 60_000, 3 * 60 * 60_000),
    taskTimeoutMsHigh: intFromEnv(
      "ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS",
      Math.max(40 * 60_000, intFromEnv("ORCHESTRATOR_TASK_TIMEOUT_MS", 20 * 60_000, 60_000, 3 * 60 * 60_000)),
      60_000,
      3 * 60 * 60_000
    ),
    // MausBot mechanism: progress-based termination. Build steps keep the
    // task alive; only true inactivity trips this. 0 = disabled.
    idleTimeoutMs: intFromEnv("ORCHESTRATOR_IDLE_TIMEOUT_MS", 10 * 60_000, 60_000, 24 * 60 * 60_000),
    // Planning watchdog (e2e 2026-11-09: a task sat in planning after a
    // stall-triggered replan). 0 = disabled.
    planningStallMs: intFromEnv("ORCHESTRATOR_PLANNING_STALL_MS", 12 * 60_000, 0, 3 * 60 * 60_000),
    verificationEnabled: boolFromEnv("ORCHESTRATOR_VERIFICATION_ENABLED", true),
    verificationIncludeBuild: boolFromEnv("ORCHESTRATOR_VERIFICATION_BUILD", true),
    verificationTimeoutMs: intFromEnv("ORCHESTRATOR_VERIFICATION_TIMEOUT_MS", 300_000, 30_000, 300_000),
    // Intelligent orchestrator defaults from spec, env-overridable
    maxAgentsPerTask: intFromEnv("ORCHESTRATOR_MAX_AGENTS_PER_TASK", 3, 1, 10),
    // Default raised 5 -> 12: a healthy task spends calls on planning, one
    // implementation attempt + retry, review, and possible fix rounds, so a
    // limit of 5 killed normal tasks once the tracker was actually fed.
    maxLLMCallsPerTask: intFromEnv("ORCHESTRATOR_MAX_LLM_CALLS_PER_TASK", 400, 1, 1_000),
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
    // Sequential-by-default: a limit of 1 keeps LLM calls one-by-one so
    // tasks and subtasks never overlap (WORKER_CONCURRENCY=1 + FIFO
    // scheduler). Raise ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS for
    // provider-parallel work.
    // Follows the parallel default so side-by-side nodes do not queue on
    // the LLM gate (1 unless worktree isolation is on).
    maxConcurrentLLMCalls: intFromEnv("ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", parallelism, 1, 8),
    maxTokenBudgetPerTask: intFromEnv("ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK", 2_000_000, 1_000, 100_000_000),
    // Plan 040 (D8): off by default; unmatched work is BLOCKED, never the CTO.
    allowFallback: boolFromEnv("ORCHESTRATOR_ALLOW_FALLBACK", false),
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
    // Global default; an agent's own `executionRuntime` overrides it
    // (resolveExecutionRuntime). ORCHESTRATOR_EXECUTION_RUNTIME wins over
    // the legacy ORCHESTRATOR_RUNTIME; "opencode" aliases "native-provider".
    executionRuntime: executionRuntimeFromEnv(),
    worktreeIsolation,
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
    // Plan 036: the Agent Reach web tool. Enabled by default; an agent must
    // still declare `web_reach` in its `supportedTools` to get it.
    agentReachEnabled: boolFromEnv("ORCHESTRATOR_AGENT_REACH_ENABLED", true),
    agentReachCommand: (process.env.ORCHESTRATOR_AGENT_REACH_COMMAND ?? "agent-reach").trim() || "agent-reach",
    agentReachTimeoutMs: intFromEnv("ORCHESTRATOR_AGENT_REACH_TIMEOUT_MS", 60_000, 1_000, 300_000),
    agentReachMaxItems: intFromEnv("ORCHESTRATOR_AGENT_REACH_MAX_ITEMS", 10, 1, 20),
    agentReachMaxToolIterations: intFromEnv("ORCHESTRATOR_AGENT_REACH_MAX_TOOL_ITERATIONS", 4, 1, 20),
    reviewMode: planningModeFromEnv("ORCHESTRATOR_REVIEW_MODE"),
    qaMode: planningModeFromEnv("ORCHESTRATOR_QA_MODE", "auto"),
    // QA gets its own, smaller fix budget than review (QA audit §5).
    qaMaxFixIterations: intFromEnv("ORCHESTRATOR_QA_MAX_FIX_ITERATIONS", intFromEnv("QA_MAX_FIX_ITERATIONS", 1, 0, 5), 0, 5),
    qaRequired: boolFromEnv("ORCHESTRATOR_QA_REQUIRED", boolFromEnv("QA_REQUIRED", false)),
    loadAwareRouting: boolFromEnv("ORCHESTRATOR_LOAD_AWARE_ROUTING", false),
    performanceRouting: boolFromEnv("ORCHESTRATOR_PERFORMANCE_ROUTING", false),
  };
}
