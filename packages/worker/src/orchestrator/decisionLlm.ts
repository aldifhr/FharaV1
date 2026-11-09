import { extractJson } from "@/utils/json";
import { describeCapabilities } from "./capabilities";
import { pickOrchestrator } from "./planner";
import {
  runLlmCallWithFallback,
  type FallbackHandle,
  type LlmConcurrencyGate,
  type TokenUsageMeta,
} from "@/effects/llmCall";
import { createProviderForAgent, getGlobalLLMConfig, type GlobalLLMConfig } from "@/llm";
import { providerHealth } from "@/llm/health";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { DecisionContext, DecisionObservation } from "./decision";

/**
 * Plan 005 Step 2.3: the optional LLM advisor.
 *
 * It is consulted ONLY when the deterministic engine returns "ambiguous"
 * (policy.decisionLlmMode: "ambiguous") or unconditionally when
 * "always" (A/B comparison). Its output is validated by `validateDecision`
 * in the caller; a parse failure, a validation failure, a timeout, or a
 * thrown error falls back to the deterministic decision, which the runner
 * records as `orchestrator.decision_fallback`.
 *
 * The prompt carries the objective, the plan goal, summarized results
 * (last 6, findings only), open issues, available agents + capabilities,
 * and the remaining budget. It never carries raw agent outputs, prompts,
 * or credential material.
 */
export interface DecisionAdvisorInput {
  ctx: DecisionContext;
  observation: DecisionObservation;
  /** Explicit per-task LLM config (resolved by the runner). Part of the
   *  task chain; never falls back to environment config. */
  llmConfig?: GlobalLLMConfig;
  llmResolver?: TaskLlmResolver;
  /** Pre-call budget gate. Runs BEFORE the request, never after. */
  assertBudgetForCall?: () => void;
  /** Task cancellation/deadline signal. */
  signal?: AbortSignal;
  llmTaskGate?: LlmConcurrencyGate;
  onTokenUsage?: (inputTokens: number, outputTokens: number, model: string, agentName: string, agentId?: string, meta?: TokenUsageMeta) => Promise<void>;
  /**
   * Injected provider call for tests (live calls are opt-in and never in
   * the default suite). When set, it replaces the real call.
   */
  ask?: (prompt: string) => Promise<string>;
}

const ACTION_LIST = [
  "execute — run the selected agent on one node",
  "delegate — add work for another capability",
  "call_agent — invoke an agent once (ephemeral, no new subtask)",
  "parallel — add independent nodes in one batch",
  "replan — replace the remaining graph, keep completed work",
  "complete — objective evidence satisfied (requires expectedOutcome)",
  "ask_user — blocked on missing information/approval (requires question)",
].join("\n");

export function buildDecisionPrompt(ctx: DecisionContext, observation: DecisionObservation): string {
  const lastResults = ctx.results.slice(-6).map((entry) => {
    const findings = entry.findings?.map((finding) => `${finding.severity}:${finding.description}`).join("; ") ?? "";
    return `- ${entry.subtaskKey} [${entry.status}] ${entry.summary ?? ""}${findings ? ` findings: ${findings}` : ""}`;
  });
  const issues = ctx.openIssues
    .filter((issue) => issue.status === "open")
    .slice(-6)
    .map((issue) => `- [${issue.severity}] ${issue.description}`);
  const proposal = observation.delegationRecommendation
    ? `Proposal: agent delegated to capability "${observation.delegationRecommendation.targetCapability}" — reason: ${observation.delegationRecommendation.reason}`
    : "Proposal: none (no delegation was proposed)";
  const remaining = ctx.budget.llmCalls < ctx.budget.maxLLMCalls
    ? `${ctx.budget.llmCalls}/${ctx.budget.maxLLMCalls} LLM calls spent`
    : "LLM call budget exhausted";
  const tokens = `${ctx.budget.totalTokens}/${ctx.budget.maxTokenBudget} tokens spent`;

  return [
    "You are the decision advisor of a multi-agent software engineering orchestrator.",
    "Reply with a single STRICT JSON object and nothing else.",
    "",
    `Objective: ${ctx.objective}`,
    `Plan goal: ${ctx.plan.goal}`,
    `Decision step: ${ctx.step}`,
    `Remaining budget: ${remaining}; ${tokens}; agents ${ctx.budget.agentCount}/${ctx.budget.maxAgents}; delegations ${ctx.budget.delegationDepth}`,
    "",
    "Agents available (only use capabilities listed here):",
    describeCapabilities(ctx.agents),
    "",
    "Last results (summary only):",
    ...(lastResults.length > 0 ? lastResults : ["- (none)"]),
    "",
    "Open issues:",
    ...(issues.length > 0 ? issues : ["- (none)"]),
    "",
    proposal,
    "",
    `Latest observation: ${observation.outcome}; ${observation.decision}; ${observation.reason}`,
    "",
    "Choose exactly one action:",
    ACTION_LIST,
    "",
    'Schema: {"action":"delegate","reasoning":"<=500 chars","target":{"capability":"..."},"task":{"key":"...","title":"...","description":"...","kind":"...","capability":"..."},"dependencies":["..."],"expectedOutcome":"..."}',
    "Rules:",
    `- reasoning must be <= 500 characters.`,
    "- for execute/delegate/parallel: task is required, capability must be in the agent list, dependencies must reference existing subtask keys or keys in the same decision.",
    "- for call_agent: target.capability is required, capability must be in the agent list. No subtask is created.",
    "- for complete: expectedOutcome is required.",
    "- for ask_user: question is required. Add `options` (2-6 short strings) when the answer is a choice between known alternatives — the UI then offers A/B/C buttons instead of a text box.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function decideWithLlm(input: DecisionAdvisorInput): Promise<unknown> {
  const { ctx, observation } = input;
  if (input.signal?.aborted) {
    throw new Error("Decision aborted: the task was cancelled or timed out");
  }
  // Pre-call budget gate, before any request is issued.
  input.assertBudgetForCall?.();

  const prompt = buildDecisionPrompt(ctx, observation);
  const text = input.ask
    ? await input.ask(prompt)
    : await runRealCall(input, prompt);
  const parsed = extractJson(text);
  if (parsed === null) {
    throw new Error("decision advisor returned unparseable JSON");
  }
  return parsed;
}

async function runRealCall(input: DecisionAdvisorInput, prompt: string): Promise<string> {
  const { ctx } = input;
  const orchestrator = pickOrchestrator(ctx.agents);
  if (!orchestrator) {
    throw new Error("no orchestrator-capable agent available for the decision advisor");
  }
  // The advisor runs on the task's own chain ONLY (plan 013): an
  // env-only config with a hardcoded model would spend quota on a
  // provider/model the user never picked, unmetered. `decide()` turns
  // this throw into a recorded deterministic fallback.
  const handles: FallbackHandle[] = input.llmResolver
    ? input.llmResolver.handlesFor(orchestrator)
    : input.llmConfig
      ? [
          {
            connectionId: "",
            connectionName: "(task config)",
            config: input.llmConfig,
            provider: createProviderForAgent(orchestrator, input.llmConfig),
          },
        ]
      : (() => {
          throw new Error("decision advisor has no task LLM chain");
        })();
  const { result: response, servedBy } = await runLlmCallWithFallback(
    handles,
    [
      ...(orchestrator.systemPrompt
        ? [{ role: "system" as const, content: orchestrator.systemPrompt }]
        : []),
      { role: "user", content: prompt },
    ],
    {
      health: input.llmResolver ? providerHealth : undefined,
      signal: input.signal,
      taskGate: input.llmTaskGate,
    }
  );
  if (input.onTokenUsage && response.inputTokens !== undefined) {
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedBy.config.model,
      orchestrator.name,
      orchestrator._id
    );
  }
  return response.content;
}
