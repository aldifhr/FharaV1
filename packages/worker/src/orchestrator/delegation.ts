import type { AgentDefinition, Classification } from "./types";
import { classifyCommand } from "./classifier";
import { routeCapability, capabilitiesOf, isAgentEnabled } from "./capabilities";
import type { AgentResult } from "./taskContext";
import type { BudgetTracker } from "./budget";

export type DelegationDecision = "APPROVE" | "REJECT" | "REVISE" | "COMPLETE" | "BLOCKED";

export interface DelegationEvaluation {
  decision: DelegationDecision;
  targetAgent?: AgentDefinition;
  targetCapability?: string;
  reason: string;
  shouldCallLLM: boolean; // true only if deterministic can't decide
}

export interface RoutingResult {
  primaryAgent: AgentDefinition | null;
  primaryCapability: string;
  strategy: "single" | "dag" | "direct";
  needsAdditionalAgents: boolean;
  reasoning: string[];
  unavailableReason?: string;
}

export function routePrimaryAgent(
  command: string,
  classification: Classification,
  agents: AgentDefinition[]
): RoutingResult {
  const enabled = agents.filter(isAgentEnabled);
  if (enabled.length === 0) {
    return {
      primaryAgent: null,
      primaryCapability: "general",
      strategy: "single",
      needsAdditionalAgents: false,
      reasoning: ["No enabled agents"],
      unavailableReason: "No enabled agents available",
    };
  }

  const capabilities = classification.suggestedCapabilities;
  const primaryCapability = capabilities[0] ?? "general";

  const agent = routeCapability(primaryCapability, enabled);
  if (!agent) {
    return {
      primaryAgent: null,
      primaryCapability,
      strategy: "single",
      needsAdditionalAgents: false,
      reasoning: [`No agent can serve capability ${primaryCapability}`],
      unavailableReason: `No agent for capability ${primaryCapability}`,
    };
  }

  const reasoning: string[] = [
    `Classification: ${classification.kind} (${classification.reasons.join("; ")})`,
    `Selected ${agent.name} for capability ${primaryCapability}`,
  ];

  const needsAdditionalAgents =
    classification.kind === "multi" ||
    classification.kind === "code_change" && capabilities.length > 1 ||
    capabilities.includes("browser-testing") ||
    capabilities.includes("code-review");

  return {
    primaryAgent: agent,
    primaryCapability,
    strategy: classification.strategy === "direct" ? "single" : classification.strategy as "single" | "dag",
    needsAdditionalAgents,
    reasoning,
  };
}

export function evaluateDelegation(input: {
  result: AgentResult;
  classification: Classification;
  agents: AgentDefinition[];
  budget: BudgetTracker;
  previousAgents: string[]; // agent names already used
  delegationDepth: number;
  alreadyDelegatedCapabilities: string[];
}): DelegationEvaluation {
  const { result, agents, budget, delegationDepth, alreadyDelegatedCapabilities } = input;
  const enabled = agents.filter(isAgentEnabled);

  // If execution failed and no findings, retry same agent? orchestrator caller handles retry.
  if (!result.success) {
    return {
      decision: "REVISE",
      reason: `Agent ${result.agentName} failed: ${result.delegationRecommendation?.reason ?? result.summary}`,
      shouldCallLLM: false,
    };
  }

  // Agent recommended delegation
  if (result.delegationRecommendation?.targetCapability) {
    const targetCap = result.delegationRecommendation.targetCapability;

    // Check budget
    const maxDepth = (budget as any).policy?.maxDelegationDepth ?? 2;
    if (!budget.canDelegate() || delegationDepth >= maxDepth) {
      return {
        decision: "REJECT",
        reason: "Delegation depth or agent budget exhausted",
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Circular delegation check
    if (alreadyDelegatedCapabilities.includes(targetCap)) {
      return {
        decision: "REJECT",
        reason: `Circular delegation prevented for capability ${targetCap}`,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    const targetAgent = routeCapability(targetCap, enabled);
    if (!targetAgent) {
      return {
        decision: "BLOCKED",
        reason: `No available agent for capability ${targetCap}` + (enabled.length === 0 ? " (no enabled agents)" : ""),
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Check if agent is available
    if (targetAgent.isEnabled === false) {
      return {
        decision: "BLOCKED",
        reason: `Agent ${targetAgent.name} is unavailable`,
        targetAgent,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    return {
      decision: "APPROVE",
      targetAgent,
      targetCapability: targetCap,
      reason: result.delegationRecommendation.reason,
      shouldCallLLM: false,
    };
  }

  // No recommendation — deterministic heuristic
  // If QA-like capability needed but not yet run, delegate
  const needsQa = input.classification.suggestedCapabilities.includes("browser-testing");
  const hasQaAgent = enabled.some((a) => capabilitiesOf(a).includes("browser-testing"));
  const hasRunQa = input.previousAgents.some((name) =>
    enabled.find((a) => a.name === name && capabilitiesOf(a).includes("browser-testing"))
  );

  if (needsQa && hasQaAgent && !hasRunQa && budget.canDelegate()) {
    const qaAgent = routeCapability("browser-testing", enabled);
    if (qaAgent) {
      return {
        decision: "APPROVE",
        targetAgent: qaAgent,
        targetCapability: "browser-testing",
        reason: "QA validation needed for code change task",
        shouldCallLLM: false,
      };
    }
  }

  // Outstanding findings with severity critical/high -> REVISE back to implementer.
  // Uses the structured severity (ReviewFinding), not substring matching on
  // free text, so wording like "no failures found" can no longer trigger it.
  const hasCriticalFindings = result.findings?.some(
    (f) => f.severity === "critical" || f.severity === "high"
  );
  if (hasCriticalFindings && result.capability === "browser-testing") {
    // Find original implementer
    const implementer = agents.find((a) =>
      capabilitiesOf(a).includes("frontend-development") || capabilitiesOf(a).includes("backend-development")
    );
    if (implementer) {
      return {
        decision: "REVISE",
        targetAgent: implementer,
        targetCapability: capabilitiesOf(implementer)[0],
        reason: "QA found critical failures that require developer fix",
        shouldCallLLM: false,
      };
    }
  }

  // Default: complete if success and no special needs
  return {
    decision: "COMPLETE",
    reason: "Task completed successfully, no further delegation needed",
    shouldCallLLM: false,
  };
}

export function preventCircularDelegation(
  chain: string[],
  nextCapability: string
): boolean {
  return chain.includes(nextCapability);
}
