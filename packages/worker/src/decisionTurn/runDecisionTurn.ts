/**
 * GOAT G13: one decision turn — a single LLM call made as a fixed role
 * (the CTO for G13) to decide a question, with a deadline.
 *
 * Generic on purpose: D7 (auto review) plugs in
 * its own `DecisionTurnSpec` (role, prompt, parser) and reuses the role
 * pick, the budget gate, the deadline, the model chain and the usage
 * metering here, plus the Convex side (apps/api/convex/decisionTurns.ts:
 * the turn row, the `taskSignals` answer outbox and the audit row).
 *
 * Outcomes:
 *  - answer:      the role decided (an option, when the question had options);
 *  - escalate:    the role declined, or its output did not parse — the
 *                 question goes to the user;
 *  - unavailable: nobody can take the turn (no such role in the team, no
 *                 model chain, the budget gate refused, the call failed);
 *  - expired:     the deadline passed. Expiry never picks an option.
 */
import { withSnapshotScope } from "@/llm/snapshots";
import { runLlmCallWithFallback, usageMetaFor, type FallbackHandle, type LlmConcurrencyGate } from "@/effects/llmCall";
import { createProviderForAgent, type GlobalLLMConfig } from "@/llm";
import { providerHealth } from "@/llm/health";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { TokenUsageFn } from "@/types/llm";
import type { AgentDefinition } from "@/types";
import { isAgentEnabled } from "@/orchestrator/capabilities";
import { combineSignals } from "@/services/runner/abort";

export type DecisionVerdict =
  | { verdict: "answer"; answer: string; chosenOption?: string; rationale: string }
  | { verdict: "escalate"; rationale: string };

export type DecisionTurnOutcome =
  | (DecisionVerdict & { agent: AgentDefinition })
  | { verdict: "unavailable"; reason: string }
  | { verdict: "expired"; reason: string };

/** What a reusing lane supplies: who decides, how to ask, how to read the reply. */
export interface DecisionTurnSpec<Q> {
  /** Role key of the deciding agent ("cto"). */
  role: string;
  buildPrompt(question: Q): string;
  parse(text: string, question: Q): DecisionVerdict;
}

export interface DecisionTurnEnv {
  agents: AgentDefinition[];
  llmResolver?: TaskLlmResolver;
  llmConfig?: GlobalLLMConfig;
  /** Pre-call budget gate (AGENTS.md #6): runs BEFORE the request. */
  assertBudgetForCall?: () => void;
  onTokenUsage?: TokenUsageFn;
  llmTaskGate?: LlmConcurrencyGate;
  /** Task cancellation. */
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms); past it the turn is `expired`. */
  deadline: number;
  /** Test seam: replaces the provider call. */
  ask?: (prompt: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
}

/** The enabled agent playing `role` in this run, or null. */
export function pickRoleAgent(agents: AgentDefinition[], role: string): AgentDefinition | null {
  return agents.find((agent) => isAgentEnabled(agent) && agent.role.trim().toLowerCase() === role) ?? null;
}

class DeadlineError extends Error {}

export async function runDecisionTurn<Q>(spec: DecisionTurnSpec<Q>, question: Q, env: DecisionTurnEnv): Promise<DecisionTurnOutcome> {
  const now = env.now ?? Date.now;
  const agent = pickRoleAgent(env.agents, spec.role);
  if (!agent) return { verdict: "unavailable", reason: `No ${spec.role.toUpperCase()} in this run's team` };
  const remaining = env.deadline - now();
  if (remaining <= 0) return { verdict: "expired", reason: "The deadline passed before the turn started" };
  try {
    env.assertBudgetForCall?.();
  } catch (error) {
    return { verdict: "unavailable", reason: `Budget gate: ${error instanceof Error ? error.message : String(error)}` };
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DeadlineError("decision turn deadline")), remaining);
  const signal = combineSignals(env.signal, deadline.signal);
  try {
    const prompt = spec.buildPrompt(question);
    const raceDeadline = new Promise<never>((_, reject) => {
      const stop = () => reject(deadline.signal.aborted ? new DeadlineError("deadline") : new Error("aborted"));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
    raceDeadline.catch(() => undefined);
    const text = await Promise.race([env.ask ? env.ask(prompt, signal) : realCall(env, agent, prompt, signal), raceDeadline]);
    return { ...spec.parse(text, question), agent };
  } catch (error) {
    if (deadline.signal.aborted || error instanceof DeadlineError) return { verdict: "expired", reason: "The decision turn ran past its deadline" };
    return { verdict: "unavailable", reason: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function realCall(env: DecisionTurnEnv, agent: AgentDefinition, prompt: string, signal: AbortSignal): Promise<string> {
  // The task's own chain only (plan 013): never an env-only config.
  const handles: FallbackHandle[] = env.llmResolver
    ? env.llmResolver.handlesFor(agent, { callRole: "decision" })
    : env.llmConfig
      ? [{ connectionId: "", connectionName: "(task config)", config: env.llmConfig, provider: createProviderForAgent(agent, env.llmConfig) }]
      : (() => {
          throw new Error("No task LLM chain for the decision turn");
        })();
  const { result, servedBy } = await withSnapshotScope({ callRole: "decision", agentId: agent._id, agentRole: agent.role }, () =>
    runLlmCallWithFallback(handles, [{ role: "user", content: prompt }], {
      health: env.llmResolver ? providerHealth : undefined,
      signal,
      taskGate: env.llmTaskGate,
    })
  );
  if (env.onTokenUsage) {
    await env.onTokenUsage(
      result.inputTokens ?? 0,
      result.outputTokens ?? 0,
      servedBy.config.model,
      agent.name,
      agent._id,
      usageMetaFor(servedBy, result, "decision")
    );
  }
  return result.content;
}
