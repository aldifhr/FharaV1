import type { AgentDefinition, Classification, ExecutionPlan, Requirement } from "@/types";
import { classifyCommand } from "./classifier";
import { routeCapability } from "./capabilities";
import { BudgetTracker } from "./budget";
import { loadPolicy, type ExecutionPolicy } from "./policy";
import { createPlan, type PlannerInput } from "./planner";
import type { GlobalLLMConfig } from "../llm";
import type { TaskLlmResolver } from "../llm/resolver";
import type { LlmConcurrencyGate } from "../effects/llmCall";
import {
  createSharedTaskContext,
  addDecision,
  extractDecisionsAndArtifactsFromResult,
  type SharedTaskContext,
  type AgentResult,
  type ExecutionHistoryEntry,
} from "./taskContext";
import type { FixCandidate } from "./ownership";
import type { RoutingAdjustment } from "./planner";
import { routePrimaryAgent, evaluateDelegation, type DelegationDecision } from "./delegation";

export interface OrchestratorInput {
  taskId: string;
  projectId: string;
  command: string;
  title: string;
  agents: AgentDefinition[];
  classification?: Classification;
  budget?: BudgetTracker;
  priorExecutions?: ExecutionHistoryEntry[];
  /**
   * The runner's own shared context (Phase 3). When provided, the
   * orchestrator reasons over THIS context — the same object the runner
   * keeps updating as subtasks finish — instead of building a throwaway
   * one whose decisions never reach the live execution.
   */
  sharedContext?: SharedTaskContext;
}

export interface OrchestratorPlan {
  primary: AgentDefinition | null;
  primaryCapability: string;
  strategy: "single" | "dag";
  sharedContext: SharedTaskContext;
  reasoning: string[];
  budgetLimitations?: string;
}

/**
 * Intelligent orchestrator — decides primary agent, evaluates budget,
 * and produces a deterministic execution sequence.
 *
 * Phase 3 ownership model: the orchestrator is the control plane. This
 * function produces the routing/decision view over the runner's shared
 * context; `createAuthoritativePlan` below turns that into the actual
 * ExecutionPlan that gets executed (planner.ts is its plan-building
 * subroutine), and `evaluateAfterExecution` turns finished subtasks into
 * decisions the runner acts on. It still does not execute agents itself —
 * the runner/scheduler do — but its plan and decisions are now the ones
 * that run, not an advisory side-channel.
 */
export function createOrchestratorPlan(input: OrchestratorInput): OrchestratorPlan {
  const classification = input.classification ?? classifyCommand(input.command);
  const policy = loadPolicy();

  const routing = routePrimaryAgent(input.command, classification, input.agents, {
    allowFallback: policy.allowFallback,
  });
  const sharedContext = input.sharedContext ?? createSharedTaskContext({
    taskId: input.taskId,
    projectId: input.projectId,
    originalRequest: input.command,
    title: input.title,
    classification,
    priorExecutions: input.priorExecutions ?? [],
  });

  if (!routing.primaryAgent) {
    return {
      primary: null,
      primaryCapability: routing.primaryCapability,
      strategy: routing.strategy === "direct" ? "single" : routing.strategy,
      sharedContext,
      reasoning: routing.reasoning,
      budgetLimitations: routing.unavailableReason,
    };
  }

  return {
    primary: routing.primaryAgent,
    primaryCapability: routing.primaryCapability,
    strategy: routing.strategy === "direct" ? "single" : routing.strategy,
    sharedContext,
    reasoning: routing.reasoning,
  };
}

/**
 * After an agent executes, decide next action.
 */
export function evaluateAfterExecution(input: {
  result: AgentResult;
  classification: Classification;
  agents: AgentDefinition[];
  budget: BudgetTracker;
  previousAgents: string[];
  delegationDepth: number;
  alreadyDelegated: string[];
  taskContext: SharedTaskContext;
  /** Per-branch capability chain of the finished subtask (see delegation.ts). */
  chainCapabilities?: string[];
  /** Live per-agent execution counts for the delegation concurrency gate. */
  activeByAgent?: ReadonlyMap<string, number>;
  /** The agent that produced `result` (Phase 4 Step 4.1 selfServe gate). */
  proposer?: AgentDefinition;
  /**
   * Capabilities the stored plan already schedules (planned nodes only).
   * The deterministic QA heuristic must not spawn a second QA node when the
   * plan already has one: the dynamic copy doubles QA cost and reports a
   * duplicate verdict for the same work.
   */
  plannedCapabilities?: string[];
  /** Plan 040: for the fix-owner rule (see evaluateDelegation). */
  planSubtasks?: FixCandidate[];
  writerByKey?: ReadonlyMap<string, AgentDefinition>;
}): { decision: DelegationDecision; nextAgent?: AgentDefinition; nextCapability?: string; reason: string; updatedContext: SharedTaskContext } {
  const { result, classification, agents, budget, previousAgents, delegationDepth, alreadyDelegated, taskContext } = input;

  // Enrich context
  const { decisions, artifacts, issues } = extractDecisionsAndArtifactsFromResult(result);
  let updated = {
    ...taskContext,
    agentExecutions: [
      ...taskContext.agentExecutions,
      {
        agentName: result.agentName,
        agentId: result.agentId,
        capability: result.capability,
        subtaskKey: "exec",
        title: result.summary,
        status: result.success ? ("COMPLETED" as const) : ("FAILED" as const),
        summary: result.summary,
        findings: result.findings,
        completedAt: Date.now(),
      } satisfies ExecutionHistoryEntry,
    ],
    artifacts: [...taskContext.artifacts, ...artifacts],
    outstandingIssues: [...taskContext.outstandingIssues, ...issues.filter((i) => i.status === "open")],
    decisions: [...taskContext.decisions, ...decisions],
  } as SharedTaskContext;

  // Budget check first
  const budgetState = budget.isBudgetExhausted();
  if (budgetState.exhausted) {
    updated = addDecision(updated, {
      decision: "BLOCKED",
      reason: budgetState.reason ?? "Budget exhausted",
      capability: result.capability,
      fromAgent: result.agentName,
      createdAt: Date.now(),
    });
    return {
      decision: "BLOCKED",
      reason: budgetState.reason ?? "Budget exhausted",
      updatedContext: updated,
    };
  }

  const evalResult = evaluateDelegation({
    result,
    classification,
    agents,
    budget,
    previousAgents,
    delegationDepth,
    alreadyDelegatedCapabilities: alreadyDelegated,
    chainCapabilities: input.chainCapabilities,
    activeByAgent: input.activeByAgent,
    plannedCapabilities: input.plannedCapabilities,
    proposer: input.proposer,
    planSubtasks: input.planSubtasks,
    writerByKey: input.writerByKey,
  });

  updated = addDecision(updated, {
    decision: evalResult.decision,
    reason: evalResult.reason,
    capability: evalResult.targetCapability,
    fromAgent: result.agentName,
    toAgent: evalResult.targetAgent?.name,
    createdAt: Date.now(),
  });

  return {
    decision: evalResult.decision,
    nextAgent: evalResult.targetAgent,
    nextCapability: evalResult.targetCapability,
    reason: evalResult.reason,
    updatedContext: updated,
  };
}

export interface AuthoritativePlanInput {
  taskId: string;
  projectId: string;
  command: string;
  title: string;
  agents: AgentDefinition[];
  /** Planner-only fallback CTO (see PlannerInput.plannerAgent). */
  plannerAgent?: AgentDefinition | null;
  plannerFallbackReason?: string | null;
  classification?: Classification;
  /** The runner's budget tracker — never a throwaway instance. */
  budget: BudgetTracker;
  /** The runner's shared context — the one execution keeps updating. */
  sharedContext: SharedTaskContext;
  policy: ExecutionPolicy;
  /**
   * A previously persisted plan for this task (validated by the caller).
   * When present it is adopted as-is — replans/restarts do not re-plan —
   * and the planner subroutine is not invoked.
   */
  storedPlan?: ExecutionPlan | null;
  storedCreatedBy?: "orchestrator" | "fallback";
  feedback?: string;
  llmConfig?: GlobalLLMConfig;
  llmResolver?: TaskLlmResolver;
  onTokenUsage?: PlannerInput["onTokenUsage"];
  /** Pre-call budget gate (Phase 5), forwarded to the planner subroutine. */
  assertBudgetForCall?: PlannerInput["assertBudgetForCall"];
  /**
   * Task cancellation/deadline signal (Phase 4 hardening): forwarded to
   * the planner subroutine. When aborted, planning throws instead of
   * producing a plan for a task that is already over.
   */
  signal?: AbortSignal;
  /** Per-task LLM gate (Phase 4 hardening), forwarded to the planner. */
  llmTaskGate?: LlmConcurrencyGate;
  /**
   * The project has a QA/dev URL (plan 013 step 3): forwarded to the
   * planner so the auto QA hint can fire on replans too. Callers that
   * know the project must pass it — the authoritative path previously
   * always planned as if there were no URL.
   */
  hasQaUrl?: boolean;
  /** Real workspace paths for the planner prompt (allowedPaths grounding). */
  workspaceLayout?: string[];
  /** R7: ranked repository map (execution/repoMap) for the planner prompt. */
  repoMap?: string;
  /** Plan 025: the user's own request (requirement extraction source). */
  request?: string;
  /** Plan 025: requirements already fixed for this task. */
  requirements?: Requirement[];
}

export interface AuthoritativePlanResult {
  orchestratorPlan: OrchestratorPlan;
  /** The plan that MUST be handed to the executor — the only plan. */
  plan: ExecutionPlan;
  createdBy: "orchestrator" | "fallback";
  degradedReason?: string;
  /**
   * Hints dropped because no enabled agent serves their capability,
   * forwarded from the planner subroutine (plan.hint_dropped bookkeeping).
   */
  droppedHintKeys?: string[];
  /** Plan 040: routing changes made to the plan (see PlannerResult). */
  routingAdjustments?: RoutingAdjustment[];
  /**
   * The primary agent, unified with per-subtask routing: the agent that
   * serves the first subtask of the executed plan. There is no separate
   * primary routing anymore.
   */
  primaryAgent: AgentDefinition | null;
  primaryCapability: string;
}

/**
 * The orchestrator as the single planning authority (Phase 3, spec §3).
 *
 * Runs the orchestrator's own decision pass over the runner's budget and
 * shared context, then obtains the execution plan from its planner
 * subroutine (planner.ts `createPlan` — LLM plan with deterministic
 * fallback; its output contract is unchanged). The returned plan is the
 * plan the runner executes: no second, discarded plan is produced, and
 * the `orchestrator.plan` event is emitted from this result.
 */
export async function createAuthoritativePlan(
  input: AuthoritativePlanInput
): Promise<AuthoritativePlanResult> {
  // A cancelled/timed-out task gets no plan — not even an adopted
  // stored one (Phase 4 hardening): planning is the first thing the
  // deadline signal gates, before any decision pass runs.
  if (input.signal?.aborted) {
    throw new Error("Planning aborted: the task was cancelled or timed out");
  }
  const classification = input.classification ?? classifyCommand(input.command);

  const orchestratorPlan = createOrchestratorPlan({
    taskId: input.taskId,
    projectId: input.projectId,
    command: input.command,
    title: input.title,
    agents: input.agents,
    classification,
    budget: input.budget,
    sharedContext: input.sharedContext,
    priorExecutions: input.sharedContext.agentExecutions,
  });

  let plan: ExecutionPlan;
  let createdBy: "orchestrator" | "fallback";
  let degradedReason: string | undefined;
  let droppedHintKeys: string[] | undefined;
  let routingAdjustments: RoutingAdjustment[] | undefined;

  if (input.storedPlan) {
    // Plan 025: a stored version that lost its requirement list (an older
    // payload) adopts the task's stored list; ids are unchanged.
    plan =
      !input.storedPlan.requirements && input.requirements && input.requirements.length > 0
        ? { ...input.storedPlan, requirements: input.requirements }
        : input.storedPlan;
    createdBy = input.storedCreatedBy ?? "orchestrator";
  } else {
    const created = await createPlan({
      command: input.command,
      classification,
      agents: input.agents,
      plannerAgent: input.plannerAgent,
      plannerFallbackReason: input.plannerFallbackReason,
      policy: input.policy,
      feedback: input.feedback,
      llmConfig: input.llmConfig,
      llmResolver: input.llmResolver,
      onTokenUsage: input.onTokenUsage,
      assertBudgetForCall: input.assertBudgetForCall,
      signal: input.signal,
      llmTaskGate: input.llmTaskGate,
      hasQaUrl: input.hasQaUrl,
      sharedInstructions: input.sharedContext.instructions,
      workspaceLayout: input.workspaceLayout,
      repoMap: input.repoMap,
      request: input.request,
      requirements: input.requirements,
    });
    plan = created.plan;
    createdBy = created.createdBy;
    degradedReason = created.degradedReason;
    droppedHintKeys = created.droppedHintKeys;
    routingAdjustments = created.routingAdjustments;
  }

  const firstSubtask = plan.subtasks[0];
  const primaryAgent = firstSubtask
    ? routeCapability(firstSubtask.capability, input.agents, {
        allowFallback: input.policy.allowFallback,
      })
    : null;

  return {
    orchestratorPlan,
    plan,
    createdBy,
    degradedReason,
    droppedHintKeys,
    routingAdjustments,
    primaryAgent,
    primaryCapability: firstSubtask?.capability ?? orchestratorPlan.primaryCapability,
  };
}
