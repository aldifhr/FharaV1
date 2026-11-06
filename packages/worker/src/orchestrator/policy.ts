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
  maxDelegationChain: number;
  maxConcurrentLLMCalls: number;
  maxTokenBudgetPerTask: number;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function loadPolicy(): ExecutionPolicy {
  return {
    maxSubtasks: intFromEnv("ORCHESTRATOR_MAX_SUBTASKS", 8, 1, 20),
    maxConcurrency: intFromEnv("ORCHESTRATOR_MAX_CONCURRENCY", 2, 1, 8),
    maxReplans: intFromEnv("ORCHESTRATOR_MAX_REPLANS", 1, 0, 3),
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
    maxDelegationChain: intFromEnv("ORCHESTRATOR_MAX_DELEGATION_CHAIN", 2, 0, 10),
    maxConcurrentLLMCalls: intFromEnv("ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", 1, 1, 8),
    maxTokenBudgetPerTask: intFromEnv("ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK", 50_000, 1_000, 500_000),
  };
}
