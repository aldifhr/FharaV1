import type { AgentDefinition, Classification } from "./types";
import { CAPABILITY } from "./types";
import { classifyCommand } from "./classifier";
import {
  routeCapability,
  capabilitiesOf,
  normalizeCapability,
  isAgentEnabled,
  isAgentAvailable,
} from "./capabilities";
import type { AgentResult, DelegationDecision } from "./taskContext";
import type { BudgetTracker } from "./budget";

/** DelegationDecision is defined once in taskContext.ts (plan 013 step 7
 *  dedupe) and re-exported here for the engine/evaluation layers. */
export type { DelegationDecision };

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

/**
 * Short role-ish names LLMs emit as targetCapability ("QA", "frontend")
 * are not the canonical capability strings ("browser-testing",
 * "frontend-development"). Compare in canonical form so a recommendation
 * for "QA" is still suppressed when the plan already schedules
 * browser-testing.
 */
const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  qa: CAPABILITY.BROWSER_TESTING,
  frontend: CAPABILITY.FRONTEND,
  backend: CAPABILITY.BACKEND,
  design: CAPABILITY.DESIGN,
  security: CAPABILITY.SECURITY,
  reviewer: CAPABILITY.CODE_REVIEW,
};

function canonicalCapability(value: string): string {
  const normalized = normalizeCapability(value);
  return CAPABILITY_ALIASES[normalized] ?? normalized;
}

export function routePrimaryAgent(
  command: string,
  classification: Classification,
  agents: AgentDefinition[],
  options: { allowFallback?: boolean } = {}
): RoutingResult {
  const enabled = agents.filter(isAgentAvailable);
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

  const agent = routeCapability(primaryCapability, enabled, {
    allowFallback: options.allowFallback,
  });
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
  /**
   * The agent that is proposing the delegation (the one that just finished
   * and reported `result`). Plan 005 Phase 4 Step 4.1: when its own
   * normalized capabilities already include the proposed capability, the
   * proposal is REJECTed — the proposer can serve it itself, so delegating
   * is unnecessary work.
   */
  proposer?: AgentDefinition;
  /**
   * Per-branch capability chain of the subtask that produced this result:
   * the capabilities of its delegation ancestry, root first, ending with
   * the subtask's own capability. When provided, this chain — not the
   * task-global counters — decides depth and circularity (Phase 3): depth
   * is `chain.length - 1`, and delegating to a capability already in the
   * chain is circular for THIS branch (a sibling branch may still use it).
   * When omitted, `alreadyDelegatedCapabilities` + `delegationDepth` keep
   * their legacy task-global meaning.
   */
  chainCapabilities?: string[];
  /**
   * Live per-agent execution counts (runner-provided). When the routing
   * target is already running at its maxConcurrency, delegation is
   * rejected instead of piling more work onto it. Full concurrency
   * enforcement at dispatch time is Phase 4; this is the delegation gate.
   */
  activeByAgent?: ReadonlyMap<string, number>;
  /**
   * Capabilities the stored plan already schedules (planned nodes only).
   * The deterministic QA heuristic uses this to avoid spawning a dynamic QA
   * node that duplicates a planned one.
   */
  plannedCapabilities?: string[];
}): DelegationEvaluation {
  const { result, agents, budget } = input;
  const enabled = agents.filter(isAgentEnabled);
  const policy = budget.getPolicy();
  const allowFallback = policy.allowFallback !== false;

  // The one living chain mechanism: per-branch chain when the caller
  // supplies it, legacy task-global list otherwise.
  const chain = input.chainCapabilities ?? input.alreadyDelegatedCapabilities;
  const branchDepth = input.chainCapabilities
    ? Math.max(0, input.chainCapabilities.length - 1)
    : input.delegationDepth;
  const maxDepth = policy.maxDelegationDepth;

  /**
   * Plan 005 Phase 4 Step 4.1: if the proposing agent can already serve the
   * proposed capability, delegation is unnecessary work — reject before any
   * other gate. `normalizeCapability` is the same normalization the
   * `selfServe` check and `validateDecision`'s routing use.
   */
  const proposerCanServe = (capability: string): boolean => {
    if (!input.proposer) return false;
    const wanted = canonicalCapability(capability);
    return capabilitiesOf(input.proposer).some((own) => canonicalCapability(own) === wanted);
  };

  // If execution failed and no findings, retry same agent? orchestrator caller handles retry.
  if (!result.success) {
    return {
      decision: "REVISE",
      reason: `Agent ${result.agentName} failed: ${result.delegationRecommendation?.reason ?? result.summary}`,
      shouldCallLLM: false,
    };
  }

  // Critical/high findings on a completed result -> REVISE back to an
  // implementer. Checked BEFORE the QA heuristic below: a result carrying
  // serious findings needs a fix, not another validation pass. Uses the
  // structured severity (ReviewFinding), not substring matching on free
  // text, so wording like "no failures found" can no longer trigger it.
  // (Generalized in Phase 3 from browser-testing sources to any finder —
  // the spec's own example is a security audit delegating a fix.)
  const hasCriticalFindings = result.findings?.some(
    (f) => f.severity === "critical" || f.severity === "high"
  );
  if (hasCriticalFindings) {
    // Find original implementer
    const implementer = agents.find((a) =>
      capabilitiesOf(a).includes(CAPABILITY.FRONTEND) || capabilitiesOf(a).includes(CAPABILITY.BACKEND)
    );
    if (implementer) {
      return {
        decision: "REVISE",
        targetAgent: implementer,
        targetCapability: capabilitiesOf(implementer)[0],
        reason: `${result.agentName} reported critical/high findings that require a developer fix`,
        shouldCallLLM: false,
      };
    }
  }

  // Agent recommended delegation
  if (result.delegationRecommendation?.targetCapability) {
    const targetCap = result.delegationRecommendation.targetCapability;

    // qaMode=never is absolute: no browser-testing delegation may bring
    // QA back in through the side door (QA audit P0-3).
    if (policy.qaMode === "never" && canonicalCapability(targetCap) === canonicalCapability("browser-testing")) {
      return {
        decision: "REJECT",
        reason: "browser QA is disabled by policy (qaMode=never)",
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Phase 4 Step 4.1: the proposer can serve it itself → no delegation.
    if (proposerCanServe(targetCap)) {
      return {
        decision: "REJECT",
        reason: "proposing agent can serve this capability",
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // The stored plan already schedules this capability: running it again as
    // a dynamic node duplicates the work and reports a second verdict for
    // the same objective. Suppress it regardless of who proposed it (agent
    // recommendation here, deterministic heuristic below).
    if (
      (input.plannedCapabilities ?? []).some(
        (planned) => canonicalCapability(planned) === canonicalCapability(targetCap)
      )
    ) {
      return {
        decision: "REJECT",
        reason: `plan already schedules ${targetCap}`,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Depth is a property of this branch's chain, not a task-global counter.
    if (branchDepth >= maxDepth) {
      return {
        decision: "REJECT",
        reason: `Delegation depth exhausted for this branch (${branchDepth}/${maxDepth})`,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }
    // Task-wide delegation COUNT (spec §7 maxDelegations, Phase 5): a
    // separate bound from branch depth — a task may stay shallow yet
    // still delegate unboundedly often without it.
    if (
      policy.maxDelegations !== undefined &&
      budget.delegationCount >= policy.maxDelegations
    ) {
      return {
        decision: "REJECT",
        reason: `Delegation budget exhausted (${budget.delegationCount}/${policy.maxDelegations})`,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }
    if (!budget.canAddAgent()) {
      return {
        decision: "REJECT",
        reason: "Agent budget exhausted",
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Circular delegation check — the branch chain is the authority:
    // A -> B -> A is rejected because A is already in B's ancestry.
    if (preventCircularDelegation(chain, targetCap)) {
      return {
        decision: "REJECT",
        reason: `Circular delegation prevented for capability ${targetCap}`,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    const targetAgent = routeCapability(targetCap, enabled, { allowFallback });
    if (!targetAgent) {
      return {
        decision: "BLOCKED",
        reason: `No available agent for capability ${targetCap}` + (enabled.length === 0 ? " (no enabled agents)" : ""),
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Check if agent is available (enabled + status)
    if (!isAgentAvailable(targetAgent)) {
      return {
        decision: "BLOCKED",
        reason: `Agent ${targetAgent.name} is unavailable`,
        targetAgent,
        targetCapability: targetCap,
        shouldCallLLM: false,
      };
    }

    // Do not delegate to an agent that is already at its concurrency
    // limit when the runner can report live execution counts.
    const activeCount = input.activeByAgent?.get(targetAgent._id) ?? 0;
    const concurrencyLimit = targetAgent.maxConcurrency ?? 1;
    if (input.activeByAgent && activeCount >= concurrencyLimit) {
      return {
        decision: "REJECT",
        reason: `Agent ${targetAgent.name} is at its concurrency limit (${activeCount}/${concurrencyLimit})`,
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
  // qaMode=auto mirrors the planner's qaWarranted gate: the classifier
  // suggests browser-testing for any "test" word (plain unit tests too),
  // so under auto the dynamic QA heuristic only fires after UI work
  // (frontend/design). An explicit browser-QA request is already a planned
  // QA node, which plannedCapabilities below excludes. Without this a
  // backend-only "helper + unit test" task got browser QA (e2e MEDIUM).
  const finishedUiWork = [CAPABILITY.FRONTEND, CAPABILITY.DESIGN].includes(
    normalizeCapability(result.capability ?? "") as typeof CAPABILITY.FRONTEND
  );
  const needsQa =
    input.classification.suggestedCapabilities.includes("browser-testing") &&
    (policy.qaMode === "always" || finishedUiWork);
  const hasQaAgent = enabled.some((a) => capabilitiesOf(a).includes("browser-testing"));
  const hasRunQa = input.previousAgents.some((name) =>
    enabled.find((a) => a.name === name && capabilitiesOf(a).includes("browser-testing"))
  );

  if (
    policy.qaMode !== "never" &&
    needsQa &&
    hasQaAgent &&
    !hasRunQa &&
    !input.plannedCapabilities?.includes("browser-testing") &&
    branchDepth < maxDepth &&
    (policy.maxDelegations === undefined ||
      budget.delegationCount < policy.maxDelegations) &&
    budget.canAddAgent() &&
    !preventCircularDelegation(chain, "browser-testing")
  ) {
    const qaAgent = routeCapability("browser-testing", enabled, { allowFallback });
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

  // Default: complete if success and no special needs
  return {
    decision: "COMPLETE",
    reason: "Task completed successfully, no further delegation needed",
    shouldCallLLM: false,
  };
}

/**
 * The single living circular-delegation mechanism (Phase 3): `chain` is
 * the per-branch capability ancestry of the delegating subtask (root
 * first, including its own capability). Delegating to a capability that
 * already appears in the chain would loop this branch (A -> B -> A), so
 * it is rejected. Other branches are unaffected — the check is per
 * branch, not task-global.
 */
export function preventCircularDelegation(
  chain: string[],
  nextCapability: string
): boolean {
  return chain.includes(nextCapability);
}
