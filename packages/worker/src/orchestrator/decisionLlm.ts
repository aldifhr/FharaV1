import { extractJson } from "@/utils/json";
import { decisionAdvisorPrompt } from "@/prompts/decision";
import { describeCapabilities } from "./capabilities";
import { pickPlanner } from "./planner";
import { withSnapshotScope } from "@/llm/snapshots";
import {
  runLlmCallWithFallback,
  usageMetaFor,
  type FallbackHandle,
  type LlmConcurrencyGate,
} from "@/effects/llmCall";
import type { TokenUsageFn } from "@/types/llm";
import { createProviderForAgent, type GlobalLLMConfig } from "@/llm";
import { providerHealth } from "@/llm/health";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { DecisionContext, DecisionObservation } from "./decision";
import type { AgentDefinition } from "@/types";

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
  onTokenUsage?: TokenUsageFn;
  /**
   * Planner-only fallback CTO (getRunContext.plannerAgent): the advisor
   * runs on it when the run's own agents have no CTO/orchestrator, the
   * same rule the planner follows (pickPlanner). Without either, the
   * advisor throws and `decide()` records the deterministic fallback.
   */
  plannerAgent?: AgentDefinition | null;
  /**
   * Injected provider call for tests (live calls are opt-in and never in
   * the default suite). When set, it replaces the real call.
   */
  ask?: (prompt: string) => Promise<string>;
}

/** The decision advisor's model source: the run's CTO, else the planner fallback CTO (no persona). */
export function pickDecisionAdvisor(
  agents: AgentDefinition[],
  plannerAgent?: AgentDefinition | null
): AgentDefinition | null {
  return pickPlanner(agents, plannerAgent);
}

export function buildDecisionPrompt(ctx: DecisionContext, observation: DecisionObservation): string {
  return decisionAdvisorPrompt({ ...ctx, capabilityList: describeCapabilities(ctx.agents) }, observation);
}

export async function decideWithLlm(input: DecisionAdvisorInput): Promise<unknown> {
  const { ctx, observation } = input;
  if (input.signal?.aborted) {
    throw new Error("Decision aborted: the task was cancelled or timed out");
  }
  // No CTO in the run and no planner fallback CTO: there is nobody to
  // advise. Fail fast (before the budget gate and prompt) so `decide()`
  // records the deterministic fallback with this reason.
  const advisor = input.ask ? null : pickDecisionAdvisor(ctx.agents, input.plannerAgent);
  if (!input.ask && !advisor) {
    throw new Error("no orchestrator-capable agent available for the decision advisor");
  }
  // Pre-call budget gate, before any request is issued.
  input.assertBudgetForCall?.();

  const prompt = buildDecisionPrompt(ctx, observation);
  const text = input.ask
    ? await input.ask(prompt)
    : await runRealCall(input, prompt, advisor!);
  const parsed = extractJson(text);
  if (parsed === null) {
    throw new Error("decision advisor returned unparseable JSON");
  }
  return parsed;
}

async function runRealCall(input: DecisionAdvisorInput, prompt: string, orchestrator: AgentDefinition): Promise<string> {
  // The advisor runs on the task's own chain ONLY (plan 013): an
  // env-only config with a hardcoded model would spend quota on a
  // provider/model the user never picked, unmetered. `decide()` turns
  // this throw into a recorded deterministic fallback.
  const handles: FallbackHandle[] = input.llmResolver
    ? input.llmResolver.handlesFor(orchestrator, {
        callRole: "decision",
      })
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
  const { result: response, servedBy } = await withSnapshotScope({ callRole: "decision", agentId: orchestrator._id, agentRole: orchestrator.role }, () => runLlmCallWithFallback(
    handles,
    // O1: no persona. The CTO (or fallback) is only the model source; the
    // advisor prompt itself is neutral system code.
    [{ role: "user", content: prompt }],
    {
      health: input.llmResolver ? providerHealth : undefined,
      signal: input.signal,
      taskGate: input.llmTaskGate,
    }
  ));
  if (input.onTokenUsage) {
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedBy.config.model,
      orchestrator.name,
      orchestrator._id,
      usageMetaFor(servedBy, response, "decision")
    );
  }
  return response.content;
}
