import type { AgentDefinition, Classification, ExecutionPlan, PlanSubtask } from "./types";
import { classifyCommand } from "./classifier";
import { routeCapability, capabilitiesOf, isAgentEnabled } from "./capabilities";
import { BudgetTracker } from "./budget";
import { loadPolicy } from "./policy";
import {
  createSharedTaskContext,
  appendExecution,
  addDecision,
  extractDecisionsAndArtifactsFromResult,
  type SharedTaskContext,
  type AgentResult,
  type ExecutionHistoryEntry,
} from "./taskContext";
import { buildAgentExecutionContext, formatAgentContextForPrompt } from "./agentContext";
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
}

export interface OrchestratorDecision {
  step: number;
  action: "EXECUTE_PRIMARY" | "DELEGATE" | "REVISE" | "COMPLETE" | "BLOCKED" | "BUDGET_EXHAUSTED";
  agent?: AgentDefinition;
  capability?: string;
  reason: string;
  sharedContext: SharedTaskContext;
  agentContextPrompt?: string;
  budgetSnapshot: ReturnType<BudgetTracker["snapshot"]>;
}

export interface OrchestratorPlan {
  primary: AgentDefinition | null;
  primaryCapability: string;
  strategy: "single" | "dag";
  steps: OrchestratorDecision[];
  sharedContext: SharedTaskContext;
  reasoning: string[];
  budgetLimitations?: string;
}

/**
 * Intelligent orchestrator — decides primary agent, evaluates budget,
 * and produces a deterministic execution sequence.
 * This does NOT execute agents itself; taskRunner still executes the plan.
 * Orchestrator provides the intelligent routing + delegation decisions.
 */
export function createOrchestratorPlan(input: OrchestratorInput): OrchestratorPlan {
  const classification = input.classification ?? classifyCommand(input.command);
  const policy = loadPolicy();
  const budget = input.budget ?? new BudgetTracker(policy);

  const routing = routePrimaryAgent(input.command, classification, input.agents);
  const sharedContext = createSharedTaskContext({
    taskId: input.taskId,
    projectId: input.projectId,
    originalRequest: input.command,
    title: input.title,
    classification,
    priorExecutions: input.priorExecutions ?? [],
  });

  const steps: OrchestratorDecision[] = [];

  if (!routing.primaryAgent) {
    steps.push({
      step: 1,
      action: "BLOCKED",
      reason: routing.unavailableReason ?? "No agent available",
      sharedContext,
      budgetSnapshot: budget.snapshot(),
    });
    return {
      primary: null,
      primaryCapability: routing.primaryCapability,
      strategy: routing.strategy === "direct" ? "single" : routing.strategy,
      steps,
      sharedContext,
      reasoning: routing.reasoning,
      budgetLimitations: routing.unavailableReason,
    };
  }

  // Primary execution step
  const primaryCtx = buildAgentExecutionContext({
    taskContext: sharedContext,
    agent: routing.primaryAgent,
    assignment: input.command,
  });

  steps.push({
    step: 1,
    action: "EXECUTE_PRIMARY",
    agent: routing.primaryAgent,
    capability: routing.primaryCapability,
    reason: `Selected ${routing.primaryAgent.name} for ${routing.primaryCapability} — ${classification.kind}`,
    sharedContext,
    agentContextPrompt: formatAgentContextForPrompt(primaryCtx),
    budgetSnapshot: budget.snapshot(),
  });

  // Determine if additional agents needed (orchestrator evaluates after primary)
  const needsAdditional = routing.needsAdditionalAgents;
  if (needsAdditional) {
    const budgetCheck = budget.isBudgetExhausted();
    if (budgetCheck.exhausted) {
      steps.push({
        step: 2,
        action: "BUDGET_EXHAUSTED",
        reason: budgetCheck.reason ?? "Budget exhausted",
        sharedContext,
        budgetSnapshot: budget.snapshot(),
      });
    } else {
      // Suggest delegations based on classification
      const extraCaps = classification.suggestedCapabilities.slice(1);
      for (const cap of extraCaps) {
        const extraAgent = routeCapability(cap, input.agents.filter(isAgentEnabled));
        if (extraAgent && extraAgent._id !== routing.primaryAgent._id) {
          const extraCtx = buildAgentExecutionContext({
            taskContext: sharedContext,
            agent: extraAgent,
            assignment: `Validate ${cap} for ${input.command}`,
          });
          steps.push({
            step: steps.length + 1,
            action: "DELEGATE",
            agent: extraAgent,
            capability: cap,
            reason: `Additional agent needed for ${cap} after primary`,
            sharedContext,
            agentContextPrompt: formatAgentContextForPrompt(extraCtx),
            budgetSnapshot: budget.snapshot(),
          });
        }
      }
    }
  } else {
    steps.push({
      step: 2,
      action: "COMPLETE",
      reason: "Single-agent task, no delegation needed",
      sharedContext,
      budgetSnapshot: budget.snapshot(),
    });
  }

  return {
    primary: routing.primaryAgent,
    primaryCapability: routing.primaryCapability,
    strategy: routing.strategy === "direct" ? "single" : routing.strategy,
    steps,
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
