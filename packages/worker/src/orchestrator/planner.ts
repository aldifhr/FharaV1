import { createProviderForAgent, getGlobalLLMConfig, type GlobalLLMConfig } from "@/llm";
import {
  runLlmCallWithFallback,
  usageMetaFor,
  type FallbackHandle,
  type LlmConcurrencyGate,
  type TokenUsageMeta,
} from "@/effects/llmCall";
import { providerHealth } from "@/llm/health";
import type { TaskLlmResolver } from "@/llm/resolver";
import { CAPABILITY, type AgentDefinition, type Classification, type ExecutionPlan } from "./types";
import { routeCapability, capabilitiesOf, describeCapabilities, isAgentEnabled } from "./capabilities";
import { validatePlan } from "./planValidator";
import { extractJson } from "@/utils/json";
import type { ExecutionPolicy } from "./policy";

export interface PlannerInput {
  command: string;
  classification: Classification;
  agents: AgentDefinition[];
  policy: ExecutionPolicy;
  feedback?: string;
  /** Explicit per-task LLM config (resolved by the runner); env is the fallback. */
  llmConfig?: GlobalLLMConfig;
  /**
   * Per-agent resolver (Phase 2): when present, the planner agent's own
   * assignment/pool resolution decides its provider + model, with in-task
   * fallback across its chain. Takes precedence over `llmConfig`.
   */
  llmResolver?: TaskLlmResolver;
  onTokenUsage?: (inputTokens: number, outputTokens: number, model: string, agentName: string, agentId?: string, meta?: TokenUsageMeta) => Promise<void>;
  /**
   * Pre-call budget gate (Phase 5): invoked BEFORE the planner's LLM
   * call. Enforce mode throws BudgetExhaustedError — deliberately NOT
   * swallowed by createPlan's planner-unavailable catch (a budget stop
   * is not planner unavailability, and degrading to the heuristic plan
   * would still be wrong when replans would spend more calls).
   */
  assertBudgetForCall?: () => void;
  /**
   * Task cancellation/deadline signal (Phase 4 hardening): forwarded to
   * the planner's LLM call. When it fires, planning ABORTS by throwing —
   * a cancelled task must never silently degrade to the heuristic plan
   * and keep executing (see createPlan).
   */
  signal?: AbortSignal;
  /** Per-task LLM gate (Phase 4 hardening), forwarded to the planner's call. */
  llmTaskGate?: LlmConcurrencyGate;
  /**
   * Progressive planning (plan 005 Phase 3): the project has a QA/dev URL
   * (resolveQaBaseUrl(project) returned a value). Feeds the auto QA hint
   * in applyPlanningHints. Optional: callers that do not thread project
   * config behave as if the project had no URL.
   */
  hasQaUrl?: boolean;
}

export interface PlannerResult {
  plan: ExecutionPlan;
  createdBy: "orchestrator" | "fallback";
  notes: string[];
  degradedReason?: string;
  /**
   * Hints dropped because no enabled agent serves their capability
   * (plan.hint_dropped). The runner logs one event per key.
   */
  droppedHintKeys?: string[];
}

export async function createPlan(input: PlannerInput): Promise<PlannerResult> {
  const notes: string[] = [];
  // Cancellation is terminal for planning (Phase 4 hardening): an
  // already-aborted task gets NO plan at all — not even the
  // deterministic fallback — so a cancelled task can never proceed
  // into execution on a plan built after its cancellation.
  if (input.signal?.aborted) {
    throw new Error("Planning aborted: the task was cancelled or timed out");
  }
  const orchestrator = pickOrchestrator(input.agents);
  if (orchestrator) {
    // Pre-call budget gate (Phase 5) — OUTSIDE the try below on purpose:
    // the catch treats call errors as planner unavailability and degrades
    // to the heuristic plan, which would hide a budget stop.
    input.assertBudgetForCall?.();
    try {
      // The planner is an agent like any other: its LLM comes from its own
      // resolver chain (assignment → fallback assignment → pool), not from
      // a single task-wide config, unless no resolver was threaded in.
      const handles: FallbackHandle[] = input.llmResolver
        ? input.llmResolver.handlesFor(orchestrator)
        : [{
            connectionId: "",
            connectionName: "(task config)",
            config: input.llmConfig ?? getGlobalLLMConfig(),
            provider: createProviderForAgent(orchestrator, input.llmConfig),
          }];
      const { result: response, servedBy } = await runLlmCallWithFallback(handles, [
        ...(orchestrator.systemPrompt
          ? [{ role: "system" as const, content: orchestrator.systemPrompt }]
          : []),
        { role: "user", content: buildPlanningPrompt(input) },
      ], {
        health: input.llmResolver ? providerHealth : undefined,
        signal: input.signal,
        taskGate: input.llmTaskGate,
      });
      if (input.onTokenUsage && response.inputTokens !== undefined) {
        const model = servedBy.config.model;
        await input.onTokenUsage(
          response.inputTokens ?? 0,
          response.outputTokens ?? 0,
          model,
          orchestrator.name,
          orchestrator._id,
          usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
        );
      }
      const parsed = extractJson(response.content);
      const validation = validatePlan(
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? {
              ...(parsed as Record<string, unknown>),
              goal:
                (parsed as Record<string, unknown>).goal ??
                (parsed as Record<string, unknown>).summary ??
                input.command,
            }
          : parsed,
        input.policy.maxSubtasks
      );
      if (validation.ok && validation.plan) {
        const hinted = applyPlanningHints(validation.plan, input.agents, {
          command: input.command,
          classification: input.classification,
          policy: input.policy,
          hasQaUrl: input.hasQaUrl,
        });
        const routed = ensureRoutable(hinted, input.agents);
        if (routed) {
          return {
            plan: routed.plan,
            createdBy: "orchestrator",
            notes,
            droppedHintKeys: routed.dropped,
          };
        }
        notes.push("planner output references capabilities that no enabled agent can serve");
      } else {
        notes.push(...validation.errors);
      }
    } catch (error) {
      // An abort is NOT planner unavailability: rethrow so the caller
      // ends the cancelled task instead of executing the fallback plan
      // the catch would otherwise degrade to (Phase 4 hardening).
      if (input.signal?.aborted) {
        throw error instanceof Error
          ? error
          : new Error("Planning aborted: the task was cancelled or timed out");
      }
      notes.push(
        `LLM planner unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    notes.push("no planner-capable agent found; using deterministic plan");
  }
  // The abort may have landed while a successful response was being
  // processed: the plan it produced must not be used either.
  if (input.signal?.aborted) {
    throw new Error("Planning aborted: the task was cancelled or timed out");
  }

  return {
    plan: heuristicPlan(input),
    createdBy: "fallback",
    notes,
    degradedReason: notes.join("; "),
  };
}

export function pickOrchestrator(agents: AgentDefinition[]): AgentDefinition | null {
  const enabled = agents.filter(isAgentEnabled);
  if (enabled.length === 0) return null;
  const explicit = enabled.find((agent) =>
    capabilitiesOf(agent).includes(CAPABILITY.ARCHITECTURE)
  );
  if (explicit) return explicit;
  const byRole = enabled.find((agent) => /orchestrator|planner|manager|cto|lead/i.test(agent.role));
  return byRole ?? enabled[0];
}

function buildPlanningPrompt(input: PlannerInput): string {
  const { command, classification, agents, policy } = input;
  return [
    "You are the orchestrator of a multi-agent software engineering system.",
    "Produce an execution plan as STRICT JSON and nothing else.",
    "Agents available (only use capabilities listed here):",
    describeCapabilities(agents),
    "",
    `User task: ${command}`,
    `Classification: ${classification.kind} (${classification.reasons.join("; ")})`,
    `Suggested capabilities: ${classification.suggestedCapabilities.join(", ")}`,
    policy.maxReplans > 0 && input.feedback
      ? `A previous attempt failed. Feedback to address:\n${input.feedback}`
      : "",
    "",
    "Rules:",
    `- 1 to ${policy.maxSubtasks} subtasks.`,
    "- Each subtask: key (lowercase slug), title, description, kind, capability, dependencies (keys), order.",
    "- kind is one of: analysis, code_change, review, qa, research, audit, shell.",
    "- Dependencies must reference earlier subtasks and must not form cycles.",
    "- Add a review node only when the change is risky (auth, security, payments, migrations, cross-domain, concurrency); add QA only when the change is user-visible or the request asks for verification.",
    "- Do NOT invent capabilities that are not listed above.",
    "- Keep the plan minimal; do not add decorative steps.",
    "",
    'Schema: {"goal":"...","strategy":"single"|"dag","requiresApproval":true,"maxConcurrency":2,"subtasks":[{"key":"implement","title":"...","description":"...","kind":"code_change","capability":"frontend-development","dependencies":[],"order":0}]}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Plan 005 Phase 3 Step 3.1: hints instead of mandates.
 *
 * Review and QA are added by the orchestrator only when the policy says so
 * (reviewMode/qaMode) AND a signal fires. "always" reproduces the legacy
 * behaviour of ensureRequiredSubtasks; "never" adds nothing; "auto" (the
 * default) adds the hint only on the risk/verification signals below.
 *
 * Hints never REMOVE plan nodes: an LLM plan that already carries a review
 * or QA node keeps it.
 */
export function applyPlanningHints(
  plan: ExecutionPlan,
  agents: AgentDefinition[],
  ctx: {
    command: string;
    classification: Classification;
    policy: Pick<ExecutionPolicy, "reviewMode" | "qaMode">;
    /** Project has a QA/dev URL (resolveQaBaseUrl). */
    hasQaUrl?: boolean;
  }
): ExecutionPlan {
  const subtasks = plan.subtasks.slice();
  const hasCodeChange = subtasks.some((subtask) => subtask.kind === "code_change");
  if (!hasCodeChange) return plan;

  const codeChangeKeys = subtasks
    .filter((subtask) => subtask.kind === "code_change")
    .map((subtask) => subtask.key);

  const riskSignal =
    RISK_SIGNAL.test(ctx.command) ||
    ctx.classification.kind === "multi" ||
    (() => {
      const capabilities = new Set(
        subtasks
          .filter((subtask) => subtask.kind === "code_change")
          .map((subtask) => subtask.capability)
      );
      return capabilities.size >= 2;
    })();

  let review = subtasks.find((subtask) => subtask.kind === "review");
  if (!review) {
    const hasReviewer = agents.some(
      (agent) => isAgentEnabled(agent) && capabilitiesOf(agent).includes(CAPABILITY.CODE_REVIEW)
    );
    // An agent that EXPLICITLY offers review capability counts as a signal
    // (it declared review as a capability it wants to perform), distinct
    // from merely having it in the capability list.
    const explicitReviewOffer = agents.some(
      (agent) =>
        isAgentEnabled(agent) &&
        agent.skills?.some((skill) => /review/i.test(skill))
    );
    const addReview =
      ctx.policy.reviewMode === "always" ||
      (ctx.policy.reviewMode !== "never" && (riskSignal || explicitReviewOffer));
    // "always" is the legacy mandate: review is added even when no enabled
    // agent serves code-review (ensureRoutable drops it afterwards if
    // unroutable). "auto" only adds when a reviewer actually exists.
    if (addReview && (hasReviewer || ctx.policy.reviewMode === "always")) {
      review = {
        key: uniqueKey("review", subtasks),
        title: "Review the change",
        description: "Review the prepared diff for correctness, regressions and missing cases.",
        kind: "review",
        capability: CAPABILITY.CODE_REVIEW,
        dependencies: codeChangeKeys,
        order: subtasks.length,
      };
      subtasks.push(review);
    }
  }

  const hasQaAgent = agents.some(
    (agent) => isAgentEnabled(agent) && capabilitiesOf(agent).includes(CAPABILITY.BROWSER_TESTING)
  );
  if (hasQaAgent && !subtasks.some((subtask) => subtask.kind === "qa")) {
    const verificationAsked = VERIFICATION_REQUESTED.test(ctx.command);
    const addQa =
      ctx.policy.qaMode === "always" ||
      (ctx.policy.qaMode !== "never" &&
        (riskSignal || verificationAsked || ctx.hasQaUrl === true));
    if (addQa) {
      subtasks.push({
        key: uniqueKey("qa", subtasks),
        title: "Verify in a browser",
        description:
          "Run the app after changes are applied and verify responsiveness, console errors and network failures.",
        kind: "qa",
        capability: CAPABILITY.BROWSER_TESTING,
        dependencies: [review?.key ?? codeChangeKeys.at(-1) ?? ""].filter(Boolean),
        order: subtasks.length,
      });
    }
  }

  return {
    ...plan,
    strategy: subtasks.length > 1 ? "dag" : plan.strategy,
    subtasks: subtasks.map((subtask, index) => ({ ...subtask, order: index })),
  };
}

const RISK_SIGNAL =
  /\b(auth(?:entication|orization|entication)?|login|sign-?in|password|token|session|oauth|jwt|permission|rbac|acl|security|vulnerab|xss|csrf|injection|secret|payment|billing|checkout|stripe|invoice|migrat(?:e|ion)|schema|concurr(?:ent|ency)|race|lock|transaction|balance)\b/i;

const VERIFICATION_REQUESTED =
  /\b(test|tests|qa|e2e|playwright|vitest|coverage|verify|verification|verify in browser|manual check|smoke)\b/i;

/**
 * Legacy entry point: every code change gets a review node, and QA when a
 * QA agent exists. Kept for the callers/tests that still express the old
 * mandate; createPlan now goes through applyPlanningHints instead.
 */
export function ensureRequiredSubtasks(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): ExecutionPlan {
  const policy: Pick<ExecutionPolicy, "reviewMode" | "qaMode"> = {
    reviewMode: "always",
    qaMode: "always",
  };
  return applyPlanningHints(plan, agents, {
    command: "",
    classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] },
    policy,
  });
}

function uniqueKey(base: string, subtasks: ExecutionPlan["subtasks"]): string {
  const used = new Set(subtasks.map((subtask) => subtask.key));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/**
 * Plan 005 Phase 3 Step 3.2: drop unroutable nodes instead of discarding
 * the whole LLM plan. The returned `dropped` keys are logged by the caller
 * as `plan.hint_dropped` events. Degrades (null) only when NO subtask
 * routes to an enabled agent.
 */
function ensureRoutable(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): { plan: ExecutionPlan; dropped: string[] } | null {
  const kept: ExecutionPlan["subtasks"] = [];
  const dropped: string[] = [];
  for (const subtask of plan.subtasks) {
    if (routeCapability(subtask.capability, agents)) kept.push(subtask);
    else dropped.push(subtask.key);
  }
  if (kept.length === 0) return null;
  if (kept.length === plan.subtasks.length) return { plan, dropped: [] };
  return {
    plan: {
      ...plan,
      strategy: kept.length > 1 ? "dag" : plan.strategy,
      subtasks: kept.map((subtask, index) => ({ ...subtask, order: index })),
    },
    dropped,
  };
}

export function heuristicPlan(input: PlannerInput): ExecutionPlan {
  const { classification, command, agents } = input;
  const goal = command.slice(0, 500);
  const hasCapability = (capability: string) =>
    agents.some(
      (agent) => isAgentEnabled(agent) && capabilitiesOf(agent).includes(capability)
    );

  if (classification.kind === "conversation") {
    return {
      version: 1,
      goal,
      strategy: "direct",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "reply",
          title: "Reply to the user",
          description:
            "Respond briefly and ask for the concrete change the user wants. Do not modify files.",
          kind: "analysis",
          capability: CAPABILITY.GENERAL,
          dependencies: [],
          order: 0,
        },
      ],
    };
  }

  if (classification.kind === "audit") {
    // Codebase audit: split into frontend/backend/security lanes when capable agents exist.
    const lanes: Array<{ key: string; title: string; capability: string; description: string }> = [];
    if (hasCapability(CAPABILITY.FRONTEND)) lanes.push({ key: "audit-frontend", title: "Audit frontend", capability: CAPABILITY.FRONTEND, description: "Read-only audit of frontend (components, pages, styles, a11y, state). Report findings with file refs. No code changes." });
    if (hasCapability(CAPABILITY.BACKEND)) lanes.push({ key: "audit-backend", title: "Audit backend", capability: CAPABILITY.BACKEND, description: "Read-only audit of backend (API routes, Convex/DB, auth, validation, errors). Report findings with file refs. No code changes." });
    if (hasCapability(CAPABILITY.SECURITY)) lanes.push({ key: "audit-security", title: "Security audit", capability: CAPABILITY.SECURITY, description: "Read-only security audit (auth, secrets, injection, CORS, deps). Report findings with severity + file refs. No code changes." });
    if (hasCapability(CAPABILITY.CODE_REVIEW)) lanes.push({ key: "audit-consolidate", title: "Consolidate audit findings", capability: CAPABILITY.CODE_REVIEW, description: "Consolidate frontend/backend/security findings into prioritized report with severity, impact, recommendation. No code changes." });

    if (lanes.length > 1) {
      const subtasks = lanes.map((lane, i) => ({
        key: lane.key,
        title: lane.title,
        description: lane.description,
        kind: "audit" as const,
        capability: lane.capability,
        dependencies: lane.key === "audit-consolidate" ? lanes.filter((l) => l.key !== "audit-consolidate").map((l) => l.key) : [],
        order: i,
      }));
      return {
        version: 1,
        goal,
        strategy: "dag",
        requiresApproval: false,
        maxConcurrency: 3,
        subtasks,
      };
    }

    const capability = hasCapability(CAPABILITY.SECURITY)
      ? CAPABILITY.SECURITY
      : CAPABILITY.CODE_REVIEW;
    return {
      version: 1,
      goal,
      strategy: "single",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "audit",
          title: "Repository audit",
          description: "Read-only audit. Report concrete findings with file references. Do not modify files.",
          kind: "audit",
          capability,
          dependencies: [],
          order: 0,
        },
      ],
    };
  }

  if (classification.kind === "research") {
    return {
      version: 1,
      goal,
      strategy: "single",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "research",
          title: "Answer the question",
          description: "Read the repository and answer the question with evidence. Do not modify files.",
          kind: "research",
          capability: hasCapability(CAPABILITY.RESEARCH)
            ? CAPABILITY.RESEARCH
            : CAPABILITY.CODE_REVIEW,
          dependencies: [],
          order: 0,
        },
      ],
    };
  }

  if (classification.kind === "multi") {
    const frontendTask: ExecutionPlan["subtasks"][number] = {
      key: "implement_frontend",
      title: "Implement frontend changes",
      description: `Implement the frontend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.FRONTEND,
      dependencies: [],
      order: 0,
    };
    const backendTask: ExecutionPlan["subtasks"][number] = {
      key: "implement_backend",
      title: "Implement backend changes",
      description: `Implement the backend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.BACKEND,
      dependencies: [],
      order: 1,
    };
    // Multi-domain: the two implementation lanes only, plus the hints
    // applyPlanningHints adds from the policy (review on the risk signal,
    // QA when a QA agent exists and a signal fires).
    const multiSubtasks = [frontendTask, backendTask];
    const hinted = applyPlanningHints(
      { version: 1, goal, strategy: "dag", requiresApproval: true, maxConcurrency: 2, subtasks: multiSubtasks },
      agents,
      {
        command,
        classification,
        policy: input.policy,
        hasQaUrl: input.hasQaUrl,
      }
    );
    return hinted;
  }

  const single: ExecutionPlan = {
    version: 1,
    goal,
    // Single-domain code change: one code_change node, direct strategy.
    // Hints (review/QA) are added only on the risk signal or when the
    // policy says "always".
    strategy: "direct",
    requiresApproval: true,
    maxConcurrency: 1,
    subtasks: [
      {
        key: "implement",
        title: "Implement the change",
        description: command,
        kind: "code_change",
        capability: classification.suggestedCapabilities[0] ?? CAPABILITY.FRONTEND,
        dependencies: [],
        order: 0,
      },
    ],
  };
  return applyPlanningHints(single, agents, {
    command,
    classification,
    policy: input.policy,
    hasQaUrl: input.hasQaUrl,
  });
}
