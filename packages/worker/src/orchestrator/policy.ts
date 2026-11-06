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
  taskTimeoutMs: number;
  verificationEnabled: boolean;
  verificationIncludeBuild: boolean;
  verificationTimeoutMs: number;
  // Intelligent orchestrator budgets (configurable, not hardcoded assumptions)
  maxAgentsPerTask: number;
  maxLLMCallsPerTask: number;
  maxDelegationDepth: number;
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
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
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
    maxConcurrentLLMCalls: intFromEnv("ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", 1, 1, 8),
    maxTokenBudgetPerTask: intFromEnv("ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK", 50_000, 1_000, 500_000),
    allowFallback: boolFromEnv("ORCHESTRATOR_ALLOW_FALLBACK", true),
    orchestratorAuthoritative: boolFromEnv("ORCHESTRATOR_AUTHORITATIVE", true),
  };
}
