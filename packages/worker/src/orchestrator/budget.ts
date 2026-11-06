import type { ExecutionPolicy } from "./policy";

export interface TokenUsageInput {
  inputTokens: number;
  outputTokens: number;
  model: string;
  agentName: string;
  agentId?: string;
}

export class BudgetTracker {
  private llmCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly agents = new Set<string>();
  private delegationDepth = 0;
  private retries = 0;
  private startTime = Date.now();

  constructor(private readonly policy: ExecutionPolicy) {}

  /** The policy this tracker enforces (read by delegation decisions). */
  getPolicy(): ExecutionPolicy {
    return this.policy;
  }

  get llmCallCount(): number {
    return this.llmCalls;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  get agentCount(): number {
    return this.agents.size;
  }

  get currentDelegationDepth(): number {
    return this.delegationDepth;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  get retryCount(): number {
    return this.retries;
  }

  /** Seed the tracker from persisted token usage (e.g. resumed tasks). */
  seed(usage: { calls: number; inputTokens: number; outputTokens: number }): void {
    this.llmCalls += Math.max(0, usage.calls);
    this.inputTokens += Math.max(0, usage.inputTokens);
    this.outputTokens += Math.max(0, usage.outputTokens);
  }

  recordLLMCall(usage: TokenUsageInput): void {
    this.llmCalls += 1;
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    if (usage.agentId) this.agents.add(usage.agentId);
    else if (usage.agentName) this.agents.add(usage.agentName);
  }

  recordAgent(agentId: string | undefined, agentName?: string): void {
    const key = agentId ?? agentName;
    if (key) this.agents.add(key);
  }

  incrementDelegation(): void {
    this.delegationDepth += 1;
  }

  incrementRetry(): void {
    this.retries += 1;
  }

  canCallLLM(): boolean {
    return this.llmCalls < this.policy.maxLLMCallsPerTask;
  }

  canDelegate(): boolean {
    return this.delegationDepth < this.policy.maxDelegationDepth && this.agents.size < this.policy.maxAgentsPerTask;
  }

  /**
   * Agent-count gate only. Delegation DEPTH is no longer decided from this
   * tracker's global counter (Phase 3): it is derived from the delegating
   * subtask's per-branch capability chain in delegation.ts. This gate keeps
   * the task-wide bound on how many distinct agents may participate.
   */
  canAddAgent(): boolean {
    return this.agents.size < this.policy.maxAgentsPerTask;
  }

  isTokenBudgetExhausted(): boolean {
    return this.totalTokens >= this.policy.maxTokenBudgetPerTask;
  }

  isBudgetExhausted(): { reason?: string; exhausted: boolean } {
    if (!this.canCallLLM()) return { exhausted: true, reason: `LLM call budget exhausted (${this.llmCalls}/${this.policy.maxLLMCallsPerTask})` };
    if (this.isTokenBudgetExhausted()) return { exhausted: true, reason: `Token budget exhausted (${this.totalTokens}/${this.policy.maxTokenBudgetPerTask})` };
    if (!this.canDelegate() && this.agents.size >= this.policy.maxAgentsPerTask)
      return { exhausted: true, reason: `Agent budget exhausted (${this.agents.size}/${this.policy.maxAgentsPerTask})` };
    return { exhausted: false };
  }

  snapshot() {
    return {
      llmCalls: this.llmCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      agentCount: this.agents.size,
      delegationDepth: this.delegationDepth,
      retries: this.retries,
      elapsedMs: this.elapsedMs,
      maxLLMCalls: this.policy.maxLLMCallsPerTask,
      maxTokenBudget: this.policy.maxTokenBudgetPerTask,
      maxAgents: this.policy.maxAgentsPerTask,
    };
  }
}

export function resolveModelConfig(agent: {
  llmModel?: string;
  llmProvider?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
}, defaults = { provider: "anthropic", model: "claude-sonnet-4-20250514" }): { provider: string; model: string; baseUrl?: string } {
  // Precedence: agent-specific > project/global defaults (currently agent-only, but kept for future project-level)
  const provider = agent.llmProvider ?? defaults.provider;
  const model = agent.llmModel ?? (provider === "openai-compatible" ? "gpt-4o-mini" : defaults.model);
  return { provider, model, baseUrl: agent.llmBaseUrl };
}

export function shouldUseLLMEvaluation(
  deterministic: { verdict: string; pendingItems: number },
  tokenBudgetRemaining: number,
  llmBudgetRemaining: number
): boolean {
  if (deterministic.pendingItems > 0) return false; // deterministic already found failures
  if (deterministic.verdict === "passed") return false;
  if (llmBudgetRemaining <= 0) return false;
  if (tokenBudgetRemaining <= 0) return false;
  return true;
}
