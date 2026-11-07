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
}

export interface PlannerResult {
  plan: ExecutionPlan;
  createdBy: "orchestrator" | "fallback";
  notes: string[];
  degradedReason?: string;
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
        const enforced = ensureRequiredSubtasks(validation.plan, input.agents);
        const routed = ensureRoutable(enforced, input.agents);
        if (routed) return { plan: routed, createdBy: "orchestrator", notes };
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
    "- kind is one of: analysis, code_change, review, qa, research, audit.",
    "- Dependencies must reference earlier subtasks and must not form cycles.",
    "- code_change subtasks must be reviewed by a code-review capable agent when one exists.",
    "- qa must depend on the implementation and run AFTER approval/apply.",
    "- Do NOT invent capabilities that are not listed above.",
    "- Keep the plan minimal; do not add decorative steps.",
    "",
    'Schema: {"goal":"...","strategy":"single"|"dag","requiresApproval":true,"maxConcurrency":2,"subtasks":[{"key":"implement","title":"...","description":"...","kind":"code_change","capability":"frontend-development","dependencies":[],"order":0}]}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function ensureRequiredSubtasks(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): ExecutionPlan {
  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  if (!hasCodeChange) return plan;

  const subtasks = plan.subtasks.slice();
  const codeChangeKeys = subtasks
    .filter((subtask) => subtask.kind === "code_change")
    .map((subtask) => subtask.key);

  let review = subtasks.find((subtask) => subtask.kind === "review");
  if (!review) {
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

  const hasQaAgent = agents.some(
    (agent) => isAgentEnabled(agent) && capabilitiesOf(agent).includes(CAPABILITY.BROWSER_TESTING)
  );
  if (hasQaAgent && !subtasks.some((subtask) => subtask.kind === "qa")) {
    subtasks.push({
      key: uniqueKey("qa", subtasks),
      title: "Verify in a browser",
      description:
        "Run the app after changes are applied and verify responsiveness, console errors and network failures.",
      kind: "qa",
      capability: CAPABILITY.BROWSER_TESTING,
      dependencies: [review.key],
      order: subtasks.length,
    });
  }

  return {
    ...plan,
    strategy: subtasks.length > 1 ? "dag" : plan.strategy,
    subtasks: subtasks.map((subtask, index) => ({ ...subtask, order: index })),
  };
}

function uniqueKey(base: string, subtasks: ExecutionPlan["subtasks"]): string {
  const used = new Set(subtasks.map((subtask) => subtask.key));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function ensureRoutable(plan: ExecutionPlan, agents: AgentDefinition[]): ExecutionPlan | null {
  const missing: string[] = [];
  for (const subtask of plan.subtasks) {
    const agent = routeCapability(subtask.capability, agents);
    if (!agent) missing.push(subtask.capability);
  }
  if (missing.length > 0) return null;
  return plan;
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

  const subtasks: ExecutionPlan["subtasks"] = [];
  if (classification.kind === "multi") {
    subtasks.push({
      key: "implement_frontend",
      title: "Implement frontend changes",
      description: `Implement the frontend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.FRONTEND,
      dependencies: [],
      order: 0,
    });
    subtasks.push({
      key: "implement_backend",
      title: "Implement backend changes",
      description: `Implement the backend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.BACKEND,
      dependencies: [],
      order: 1,
    });
    subtasks.push({
      key: "review",
      title: "Review the implementation",
      description: "Review all prepared diffs for correctness, regressions and missing cases.",
      kind: "review",
      capability: CAPABILITY.CODE_REVIEW,
      dependencies: ["implement_frontend", "implement_backend"],
      order: 2,
    });
  } else {
    subtasks.push({
      key: "implement",
      title: "Implement the change",
      description: command,
      kind: "code_change",
      capability: classification.suggestedCapabilities[0] ?? CAPABILITY.FRONTEND,
      dependencies: [],
      order: 0,
    });
    subtasks.push({
      key: "review",
      title: "Review the change",
      description: "Review the prepared diff for correctness, regressions and missing cases.",
      kind: "review",
      capability: CAPABILITY.CODE_REVIEW,
      dependencies: ["implement"],
      order: 1,
    });
  }

  if (hasCapability(CAPABILITY.BROWSER_TESTING)) {
    subtasks.push({
      key: "qa",
      title: "Verify in a browser",
      description:
        "Run the app after changes are applied and verify responsiveness, console errors and network failures.",
      kind: "qa",
      capability: CAPABILITY.BROWSER_TESTING,
      dependencies: ["review"],
      order: subtasks.length,
    });
  }

  return {
    version: 1,
    goal,
    strategy: subtasks.length > 1 ? "dag" : "single",
    requiresApproval: true,
    maxConcurrency: 2,
    subtasks,
  };
}
