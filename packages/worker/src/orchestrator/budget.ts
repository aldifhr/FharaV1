import type { ExecutionPolicy } from "./policy";

/**
 * Thrown by the pre-call budget gate (BudgetTracker.assertLlmCallAllowed)
 * in "enforce" mode when the task's LLM call or token budget is already
 * spent. Typed so the executor can convert it into a budget-exhausted
 * subtask outcome and the runner can end the task with an explicit
 * budget.exhausted status instead of a generic failure (spec §7).
 */
export class BudgetExhaustedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Budget exhausted: ${reason}`);
    this.name = "BudgetExhaustedError";
    this.reason = reason;
  }
}

export function isBudgetExhaustedError(error: unknown): error is BudgetExhaustedError {
  return error instanceof BudgetExhaustedError;
}

/**
 * The persisted shape of a task's budget state (BudgetTracker.snapshot).
 * Stored on taskContexts.budgetSnapshot and restored via seed/restoreExtras
 * so a resumed or recovered run keeps the FULL tracker state (Phase 5).
 */
export interface BudgetSnapshot {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  agentCount: number;
  agents: string[];
  delegationDepth: number;
  retries: number;
  elapsedMs: number;
  maxLLMCalls: number;
  maxTokenBudget: number;
  maxAgents: number;
}

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
  /** Warn-mode gate: reasons already surfaced, so warnings fire once. */
  private readonly warnedReasons = new Set<string>();

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

  /**
   * Task-wide count of APPROVED delegations (spec §7 `maxDelegations`).
   * The underlying counter predates Phase 3, when it was incremented once
   * per approved delegation and mis-read as a depth; per-branch DEPTH is
   * derived from the subtask capability chain in delegation.ts, so this
   * counter's honest meaning is the delegation count. The snapshot field
   * keeps the historical `delegationDepth` name for compatibility.
   */
  get delegationCount(): number {
    return this.delegationDepth;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  get retryCount(): number {
    return this.retries;
  }

  /**
   * Seed the tracker from persisted token usage (e.g. resumed tasks).
   * Accepts the full persisted shape: call/token totals from the
   * tokenUsage table, plus the non-usage state (agents used, delegation
   * count, retries) restored from the task's budget snapshot — a resumed
   * or recovered task must NOT silently reset those limits (spec §7).
   */
  seed(usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    agents?: string[];
    delegationDepth?: number;
    retries?: number;
  }): void {
    this.llmCalls += Math.max(0, usage.calls);
    this.inputTokens += Math.max(0, usage.inputTokens);
    this.outputTokens += Math.max(0, usage.outputTokens);
    if (usage.agents) {
      for (const agent of usage.agents) {
        if (agent) this.agents.add(agent);
      }
    }
    if (usage.delegationDepth !== undefined) {
      this.delegationDepth = Math.max(
        this.delegationDepth,
        Math.max(0, usage.delegationDepth)
      );
    }
    if (usage.retries !== undefined) {
      this.retries = Math.max(this.retries, Math.max(0, usage.retries));
    }
  }

  /**
   * Restore the non-usage part of a persisted budget snapshot (see
   * snapshot()): which agents already participated, how many delegations
   * were already approved, how many retries were already spent. Call/token
   * totals are seeded separately from the tokenUsage table, which is the
   * source of truth for them.
   */
  restoreExtras(snapshot: {
    agents?: string[];
    delegationDepth?: number;
    retries?: number;
  }): void {
    this.seed({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      agents: snapshot.agents,
      delegationDepth: snapshot.delegationDepth,
      retries: snapshot.retries,
    });
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

  /**
   * The LLM-relevant exhaustion state only (call count + tokens): the
   * limits that decide whether ANOTHER LLM call may start. Delegation and
   * agent-count limits gate delegation decisions, not calls, so they are
   * deliberately not part of this check.
   */
  isLlmBudgetExhausted(): { reason?: string; exhausted: boolean } {
    if (!this.canCallLLM()) return { exhausted: true, reason: `LLM call budget exhausted (${this.llmCalls}/${this.policy.maxLLMCallsPerTask})` };
    if (this.isTokenBudgetExhausted()) return { exhausted: true, reason: `Token budget exhausted (${this.totalTokens}/${this.policy.maxTokenBudgetPerTask})` };
    return { exhausted: false };
  }

  /**
   * Pre-call budget gate (Phase 5, spec §7). Callers invoke this BEFORE
   * every LLM call:
   *  - budget left: returns silently.
   *  - exhausted + policy.budgetMode "enforce": throws
   *    BudgetExhaustedError — the call must not happen.
   *  - exhausted + "warn" (the default this release cycle): invokes
   *    `onWarn` (once per distinct reason per tracker, so a task running
   *    over budget does not spam an event per call) and lets the call
   *    proceed.
   */
  assertLlmCallAllowed(onWarn?: (reason: string) => void): void {
    const state = this.isLlmBudgetExhausted();
    if (!state.exhausted || !state.reason) return;
    if (this.policy.budgetMode === "enforce") {
      throw new BudgetExhaustedError(state.reason);
    }
    if (!this.warnedReasons.has(state.reason)) {
      this.warnedReasons.add(state.reason);
      onWarn?.(state.reason);
    }
  }

  isBudgetExhausted(): { reason?: string; exhausted: boolean } {
    const llm = this.isLlmBudgetExhausted();
    if (llm.exhausted) return llm;
    // Delegation count (spec maxDelegations): checked on its own. The
    // previous implementation folded this into the agent branch behind
    // `!canDelegate() && agents.size >= maxAgentsPerTask`, which reduced
    // to the agent condition alone — exhaustion of the DELEGATION limit
    // by itself was never reported (PLAN §7.2 logic defect).
    if (
      this.policy.maxDelegations !== undefined &&
      this.delegationDepth >= this.policy.maxDelegations
    )
      return { exhausted: true, reason: `Delegation budget exhausted (${this.delegationDepth}/${this.policy.maxDelegations})` };
    if (this.agents.size >= this.policy.maxAgentsPerTask)
      return { exhausted: true, reason: `Agent budget exhausted (${this.agents.size}/${this.policy.maxAgentsPerTask})` };
    return { exhausted: false };
  }

  snapshot(): BudgetSnapshot {
    return {
      llmCalls: this.llmCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      agentCount: this.agents.size,
      /** Agent identities, persisted so a restored tracker knows WHICH
       *  agents already participated (restoreExtras / seed). */
      agents: Array.from(this.agents),
      delegationDepth: this.delegationDepth,
      retries: this.retries,
      elapsedMs: this.elapsedMs,
      maxLLMCalls: this.policy.maxLLMCallsPerTask,
      maxTokenBudget: this.policy.maxTokenBudgetPerTask,
      maxAgents: this.policy.maxAgentsPerTask,
    };
  }
}
