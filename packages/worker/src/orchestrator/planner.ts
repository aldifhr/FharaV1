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
import { routeCapability, capabilitiesOf, describeCapabilities, isAgentEnabled, normalizeCapability } from "./capabilities";
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
  /** Plan 015: durable shared instructions from the project record. */
  sharedInstructions?: string;
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

  // Apply the same CTO review/QA policy to fallback plans. Previously the
  // deterministic fallback bypassed applyPlanningHints, so a provider response
  // with empty/non-JSON content silently removed requested review and QA nodes.
  const fallback = applyPlanningHints(heuristicPlan(input), input.agents, {
    command: input.command,
    classification: input.classification,
    policy: input.policy,
    hasQaUrl: input.hasQaUrl,
  });
  const routedFallback = ensureRoutable(fallback, input.agents);
  return {
    plan: routedFallback?.plan ?? fallback,
    createdBy: "fallback",
    notes,
    degradedReason: notes.join("; "),
  };
}

export function pickOrchestrator(agents: AgentDefinition[]): AgentDefinition | null {
  const enabled = agents.filter(isAgentEnabled);
  if (enabled.length === 0) return null;
  // CTO is the sole decision authority (team is specialist-only since Lead removal).
  const cto = enabled.find((agent) => /^cto$/i.test(agent.role.trim()));
  if (cto) return cto;
  return enabled.find((agent) => /^orchestrator$/i.test(agent.role.trim())) ?? null;
}

/** Builds the CTO planning prompt. Exported for prompt-shape tests. */
export function buildPlanningPrompt(input: PlannerInput): string {
  const { command, classification, agents, policy } = input;
  return [
    "You are the CTO decision-maker for the multi-agent software engineering workspace.",
    ...(input.sharedInstructions
      ? [`Durable shared instructions for this project (must follow): ${input.sharedInstructions}`]
      : []),
    "Your team consists of specialized agents: CTO, Designer, Frontend, Backend, QA, Support, DevOps, Reviewer, Researcher.",
    "Analyze the user task, identify which agents are strictly relevant, and produce an execution plan as STRICT JSON.",
    "Do NOT force all agents into every task. Only assign agents whose capabilities match the requirements.",
    "For simple or single-discipline tasks, use strategy 'single' with 1 subtask and empty dependencies [].",
    "For multi-agent work, independent subtasks must have empty dependencies [] so they can run concurrently in parallel.",
    "Dependent subtasks must declare dependencies on the earlier subtask keys they wait for.",
    "Role collaboration patterns:",
    "- When design, visual layout, or pricing directions are needed:",
    "  Designer (ui-ux-design) drafts layout options / proposals (Option A vs Option B).",
    "- Reviewer (code-review): independent code review of implementation diffs.",
    "- CTO (architecture, security-audit): technical architecture decisions, decomposition, and risk evaluation; oversees but does not perform code review itself.",
    "- CTO must verify before approval: frontend/backend boundaries are sensible; project-standard technologies are used consistently; database and API designs are correct; service-to-service communication is explicit; no duplicate implementation is introduced; the solution is scalable and maintainable; and architectural changes are justified, minimal, and reversible.",
    "- CTO must reject or request revision when any of those checks fail or when the plan lacks enough evidence to decide. Do not approve by default just because an agent completed.",
    "- Technical-debt findings must include evidence, root cause, impact, and a durable remediation owner. The CTO directs the implementer agent to coordinate cross-agent fixes; do not hide debt behind a local patch or add a second orchestration path.",
    "- Frontend (frontend-development): UI components, tokens, styling, client implementation, and Next.js app code including src/lib types and utils (lib/resume is frontend unless it contains Convex/api routes).",
    "- Backend (backend-development): Convex/API routes, database schema, server logic. A plain Next.js lib/ file with TypeScript types is frontend, not backend.",
    "- DevOps (github, shell-execution): repositories, issues/PRs, CI, infra commands.",
    "- QA (browser-testing): perform only the verification explicitly requested. Structural QA checks HTML, browser reachability, console, and network errors. Responsive viewport and screenshot-baseline checks are opt-in only; never add them when the user says not to.",
    "- Support (documentation-support): documentation, customer communication, release notes.",
    "- Researcher (research): technical research, evidence gathering, fact vs assumption separation.",
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
    "- code_change subtasks must declare allowedPaths: the tightest workspace-relative file/directory scope they may modify (e.g. [\"apps/web\"]). Omit only when the scope is genuinely unknown; the executor refuses files outside the declared scope.",
    "- kind is one of: analysis, code_change, review, qa, research, audit, shell.",
    "- kind shell is ONLY for git read-only commands. File creation/write and",
    "  running tests/build must use code_change, never shell.",
    "- Framework requests (React/Vue/Next.js) MUST scaffold a real project:",
    "  package.json, vite/next config, index.html, src/main + src/App (or equivalent).",
    "  Never return a single index.html with CDN <script> tags as a 'migration'.",
    "- Dependencies must reference earlier subtasks and must not form cycles.",
    // Plan 013 step 6: the prompt follows reviewMode/qaMode like the
    // hints layer does, instead of mandating a review for every change.
    ...(policy.reviewMode === "always"
      ? [
          "- Add a review node served by the Reviewer agent for every code change. (policy reviewMode=always).",
        ]
      : policy.reviewMode === "never"
        ? [
            "- Do NOT add a review node: policy reviewMode=never forbids it. The CTO quality gate still verifies the plan outcome, but the plan carries no review subtask.",
          ]
        : [
            "- Add a review node served by the Reviewer agent only for risky changes: auth, security, payments, migrations, concurrency, multi-domain, or multi-capability work. Simple single-capability changes get no review node. (policy reviewMode=auto: risk signal, not a mandate.)",
          ]),
    ...(policy.qaMode === "always"
      ? [
          "- Add a QA node for every code change: the app must be validated in the browser (policy qaMode=always).",
        ]
      : policy.qaMode === "never"
        ? [
            "- Do NOT add a QA node: policy qaMode=never forbids it. The plan carries no browser-validation subtask.",
          ]
        : [
            "- Add a QA node only when the change touches UI (frontend/design files) or the user explicitly asks for QA / e2e / browser testing (policy qaMode=auto). Backend-only, docs, config or unit-test-only changes get no QA node.",
          ]),
    "- Do NOT invent capabilities that are not listed above.",
    "- Keep the plan minimal; do not add decorative steps.",
    "",
    'Schema: {"goal":"...","strategy":"single"|"dag","requiresApproval":true,"maxConcurrency":1,"subtasks":[{"key":"implement","title":"...","description":"...","kind":"code_change","capability":"frontend-development","dependencies":[],"order":0,"allowedPaths":["apps/web"]}]}',
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
 * or QA node keeps it — EXCEPT under qaMode="never", which is enforced
 * here for every plan source (LLM, heuristic, fallback): qa nodes are
 * dropped and dependencies on them are removed.
 */
export function stripQaNodes(plan: ExecutionPlan): ExecutionPlan {
  const qaKeys = new Set(plan.subtasks.filter((s) => s.kind === "qa").map((s) => s.key));
  if (qaKeys.size === 0) return plan;
  return {
    ...plan,
    visualQa: undefined,
    subtasks: plan.subtasks
      .filter((s) => !qaKeys.has(s.key))
      .map((s, index) => ({
        ...s,
        dependencies: s.dependencies.filter((dep) => !qaKeys.has(dep)),
        order: index,
      })),
  };
}

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
  if (ctx.policy.qaMode === "never") {
    return applyPlanningHintsInner(stripQaNodes(plan), agents, ctx);
  }
  const hinted = applyPlanningHintsInner(plan, agents, ctx);
  // qaMode=auto is tightened (QA audit §5): browser QA only when the plan
  // touches UI or the user explicitly asked for browser verification. A QA
  // node the LLM emitted for backend/docs/test-only work is dropped.
  if (ctx.policy.qaMode !== "always" && !qaWarranted(hinted, ctx.command)) {
    return stripQaNodes(hinted);
  }
  return hinted;
}

const UI_CAPABILITIES = new Set<string>([CAPABILITY.FRONTEND, CAPABILITY.DESIGN]);
const UI_PATH = /(\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)\b|(^|\/)(app|pages|components|styles|public)(\/|$))/i;

/** Explicit browser-QA request. Plain "unit tests" does NOT count. */
export const BROWSER_QA_REQUESTED =
  /(@qa\b|\bqa\b|\be2e\b|end[- ]to[- ]end|playwright|browser[- ]?(test|testing|check|qa)|(test|verify|check)\s+(it\s+)?in\s+(the\s+)?browser|smoke[- ]?test)/i;

/**
 * True when browser QA is warranted under qaMode=auto: a code change that
 * touches UI (frontend/design capability, or UI-ish allowedPaths) or an
 * explicit browser-QA request. Runtime gates (changes applied, project
 * browser-runnable) are enforced by the QA stage itself.
 */
export function qaWarranted(plan: ExecutionPlan, command: string): boolean {
  const codeChanges = plan.subtasks.filter((s) => s.kind === "code_change");
  if (codeChanges.length === 0) return false;
  if (BROWSER_QA_REQUESTED.test(command)) return true;
  return codeChanges.some(
    (s) =>
      UI_CAPABILITIES.has(normalizeCapability(s.capability)) ||
      (s.allowedPaths ?? []).some((p) => UI_PATH.test(p))
  );
}

function applyPlanningHintsInner(
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
    // CTO decides when a review is needed. Risky or explicitly reviewable work
    // gets the quality gate; trivial changes stay minimal.
    const addReview =
      ctx.policy.reviewMode === "always" ||
      (ctx.policy.reviewMode !== "never" && (riskSignal || explicitReviewOffer));
    // "always" is the legacy mandate: review is added even when no enabled
    // agent serves code-review (ensureRoutable drops it afterwards if
    // unroutable). "auto" only adds when a reviewer actually exists.
    if (addReview && (hasReviewer || ctx.policy.reviewMode === "always")) {
      review = {
        key: uniqueKey("review", subtasks),
        title: "Review implementation diff for regressions",
        description: "Reviewer must inspect the completed implementation diff and either approve it or request revision. Check code quality, security, regression risk, performance, contract compatibility, project conventions, duplication, scalability, maintainability, and whether architectural changes are justified. Do NOT run verification commands (tsc, lint, test, build) — those are executed by the runtime verification loop, not by the reviewer (read-only). For every finding, identify the root cause, define the smallest durable fix, and direct the implementer agent to coordinate the remediation when it spans agents or subsystems.",
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
    // Tightened auto (QA audit §5): UI-touching change or an explicit
    // browser-QA request. Risk words, plain "tests" and a configured QA
    // URL alone no longer add browser QA.
    const addQa =
      ctx.policy.qaMode === "always" ||
      (ctx.policy.qaMode !== "never" && qaWarranted({ ...plan, subtasks }, ctx.command));
    if (addQa) {
      const visualQa = wantsVisualQa(ctx.command);
      subtasks.push({
        key: uniqueKey("qa", subtasks),
        title: visualQa ? "Verify responsive visuals" : "Validate HTML and browser reachability",
        description: visualQa
          ? "Run the app after changes are applied and verify responsive visuals, console errors and network failures."
          : "Validate the HTML structure, open the page in a browser, and check console and network errors; do not compare visual baselines.", 
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
    // Record the visual-QA decision on the plan itself: the executor reads
    // this instead of re-parsing the command, so the two can never disagree.
    visualQa: subtasks.some((subtask) => subtask.kind === "qa")
      ? wantsVisualQa(ctx.command)
      : plan.visualQa,
    subtasks: subtasks.map((subtask, index) => ({ ...subtask, order: index })),
  };
}

/**
 * Single source of truth for "does this request want visual QA?".
 * A negated prohibition anywhere in the request wins over the positive
 * signal, which is what makes "@QA must not run screenshots/viewports"
 * authoritative rather than advisory.
 */
export function wantsVisualQa(command: string): boolean {
  const prohibited =
    /\b(?:no|not|without|don't|do\s+not|jangan|tanpa)\b[\s\S]{0,160}\b(?:visual|screenshots?|baselines?|pixels?|responsive|viewports?|desktop|tablet|mobile)\b/i.test(
      command
    );
  if (prohibited) return false;
  return /\b(?:visual\s+regression|screenshots?|baselines?|pixel(?:-diff)?|responsive\s+(?:layout|viewports?)|(?:desktop|tablet|mobile)\s+(?:and\s+\w+\s+)?viewports?|viewport\s+testing)\b/i.test(
    command
  );
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
    const routable = routeCapability(subtask.capability, agents, {
      allowFallback: subtask.kind !== "qa" && subtask.capability !== CAPABILITY.BROWSER_TESTING,
    });
    if (routable) kept.push(subtask);
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
        maxConcurrency: 1,
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
    const isPricingOrDesign = /\b(pricing|tier|grid|layout|redesign)\b/i.test(command);
    const frontendTask: ExecutionPlan["subtasks"][number] = {
      key: "implement_frontend",
      title: isPricingOrDesign ? "Design token sync & responsive layout" : "Implement frontend changes",
      description: `Implement the frontend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.FRONTEND,
      dependencies: [],
      order: 0,
    };
    const backendTask: ExecutionPlan["subtasks"][number] = {
      key: "implement_backend",
      title: isPricingOrDesign ? "Integrate Stripe checkout links" : "Implement backend changes",
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
      { version: 1, goal, strategy: "dag", requiresApproval: true, maxConcurrency: 1, subtasks: multiSubtasks },
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
