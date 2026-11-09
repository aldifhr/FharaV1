import type { ExecutionPolicy } from "@/orchestrator/policy";

/**
 * The execution-policy fields every runner test sets the same way. Tests
 * add what they actually exercise (concurrency, replans, review rounds,
 * authoritative mode, ...) through `testPolicy({...})`.
 */
export const TEST_POLICY_BASE = {
  maxSubtasks: 8,
  subtaskTimeoutMs: 5_000,
  subtaskRetries: 0,
  approvalTimeoutMs: 60_000,
  taskTimeoutMs: 60_000,
  verificationEnabled: false,
  verificationIncludeBuild: false,
  verificationTimeoutMs: 10_000,
  maxAgentsPerTask: 3,
  maxLLMCallsPerTask: 12,
  maxDelegationDepth: 2,
  maxTokenBudgetPerTask: 50_000,
} satisfies Partial<ExecutionPolicy>;

/** A full ExecutionPolicy: the shared base plus the test's own fields. */
export function testPolicy(fields: Partial<ExecutionPolicy>): ExecutionPolicy {
  return { ...TEST_POLICY_BASE, ...fields } as ExecutionPolicy;
}
