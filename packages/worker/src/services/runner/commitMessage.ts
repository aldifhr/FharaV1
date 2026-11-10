/**
 * R9: a Conventional Commits message for the worktree commit, generated
 * from the staged diff (prompt copied from Aider, see prompts/commit.ts).
 *
 * Rule 6: the pre-call budget gate runs BEFORE the request; a refused gate
 * (budget spent), a missing LLM chain, an LLM failure or a reply that is not
 * one `<type>: <description>` line all keep the fallback message
 * (`Fhara: <task title>`). The commit never waits on this beyond one call.
 * `FHARA_COMMIT_MESSAGE_LLM=0` turns it off.
 */
import { runLlmCallWithFallback, usageMetaFor, type FallbackHandle } from "@/effects/llmCall";
import { providerHealth } from "@/llm/health";
import { withSnapshotScope } from "@/llm/snapshots";
import { COMMIT_SYSTEM_PROMPT, buildCommitMessagePrompt, normalizeCommitMessage } from "@/prompts/commit";
import type { AgentDefinition } from "@/types";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { LlmConcurrencyGate } from "@/effects/llmCall";
import type { TokenUsageFn } from "@/types/llm";

export interface CommitMessageDeps {
  /** The agent whose chain pays for the call (the implementer). */
  agent: AgentDefinition | null;
  llmResolver?: TaskLlmResolver;
  /** Pre-call budget gate (throws when the budget is spent). */
  assertBudgetForCall?: () => void;
  llmTaskGate?: LlmConcurrencyGate;
  onTokenUsage?: TokenUsageFn;
  signal?: AbortSignal;
  /** Context line(s) for the model, e.g. the task title. */
  context?: string;
  env?: Record<string, string | undefined>;
  /** Test seam: replaces the provider call. */
  ask?: (system: string, user: string) => Promise<string>;
  /** Called with the reason whenever the fallback is used. */
  onFallback?: (reason: string) => void;
}

/** Generated message, or null to keep the caller's fallback. Never throws. */
export async function generateCommitMessage(diff: string, deps: CommitMessageDeps): Promise<string | null> {
  const env = deps.env ?? process.env;
  const fallback = (reason: string) => {
    deps.onFallback?.(reason);
    return null;
  };
  if (env.FHARA_COMMIT_MESSAGE_LLM === "0") return fallback("disabled");
  if (!diff.trim()) return fallback("empty diff");
  if (deps.signal?.aborted) return fallback("aborted");
  let handles: FallbackHandle[] = [];
  if (!deps.ask) {
    if (!deps.agent || !deps.llmResolver) return fallback("no LLM chain");
    handles = deps.llmResolver.handlesFor(deps.agent, { callRole: "commit" });
    if (handles.length === 0) return fallback("no LLM chain");
  }
  try {
    // Rule 6: before the request, never after.
    deps.assertBudgetForCall?.();
  } catch (error) {
    return fallback(`budget: ${error instanceof Error ? error.message : String(error)}`);
  }
  const user = buildCommitMessagePrompt(diff, deps.context);
  try {
    let reply: string;
    if (deps.ask) {
      reply = await deps.ask(COMMIT_SYSTEM_PROMPT, user);
    } else {
      const agent = deps.agent!;
      const { result, servedBy } = await withSnapshotScope({ callRole: "commit", agentId: agent._id, agentRole: agent.role }, () =>
        runLlmCallWithFallback(
          handles,
          [
            { role: "system" as const, content: COMMIT_SYSTEM_PROMPT },
            { role: "user" as const, content: user },
          ],
          { health: providerHealth, signal: deps.signal, taskGate: deps.llmTaskGate }
        )
      );
      if (deps.onTokenUsage) {
        await deps.onTokenUsage(
          result.inputTokens ?? 0,
          result.outputTokens ?? 0,
          servedBy.config.model,
          agent.name,
          agent._id,
          usageMetaFor(servedBy, result, "commit")
        );
      }
      reply = result.content;
    }
    const message = normalizeCommitMessage(reply);
    return message ?? fallback("reply is not a one-line conventional commit");
  } catch (error) {
    return fallback(`llm: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
}
