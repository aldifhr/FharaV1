/**
 * GOAT G13: answer open task_input decision turns — questions a direct
 * thread (or another MCP caller) asked through `question.ask` that
 * decisionTurns.ts routed to the CTO. One at a time, beside tasks.
 *
 * The turn runs on the task's own model chain with the same budget the task
 * runner keeps (seeded from usage already recorded, checked before the call,
 * AGENTS.md #6). The answer, the outbox signal and the audit row commit in
 * decisionTurns.answer; delivery into the task is decisionTurns.deliver.
 * A turn that cannot run is expired, never answered for the user.
 */
import { BudgetTracker } from "@/orchestrator/budget";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import { buildTaskLlmResolver, seedBudgetFromPersisted, toAgentDefinition } from "@/services/runner/setup";
import { createBudgetGate, createUsageRecorder } from "@/services/runner/session";
import type { RunnerDeps } from "@/services/runner/types";
import type { WorkerApi, WorkerRunAgent } from "@/workerApi";
import { CTO_QUESTION_SPEC } from "./ctoQuestion";
import type { DecisionTurnPort } from "./port";
import { runDecisionTurn } from "./runDecisionTurn";

export interface DecisionPollDeps {
  api: WorkerApi;
  port: DecisionTurnPort;
  workerId: string;
  policy: ExecutionPolicy;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
}

/** Process one open turn. Returns true when one was claimed (poll again soon). */
export async function processNextDecisionTurn(deps: DecisionPollDeps): Promise<boolean> {
  const claimed = await deps.port.claimNext({ workerId: deps.workerId });
  if (!claimed) return false;
  const turnId = String(claimed.turnId);
  try {
    const context = await deps.api.getContext({ taskId: claimed.taskId });
    if (!context?.task) {
      await deps.port.expire({ turnId, why: "task not found" });
      return true;
    }
    const agents = ((context.agents ?? []) as WorkerRunAgent[]).map(toAgentDefinition);
    const resolver = await buildTaskLlmResolver(context.llmProviders);
    const runnerDeps = { api: deps.api, workerId: deps.workerId, policy: deps.policy, workspaceRoot: deps.workspaceRoot, log: deps.log } as RunnerDeps;
    const budget = new BudgetTracker(deps.policy);
    await seedBudgetFromPersisted({ deps: runnerDeps, taskId: claimed.taskId, projectId: claimed.projectId, budget });
    const outcome = await runDecisionTurn(
      CTO_QUESTION_SPEC,
      {
        question: claimed.question,
        options: claimed.options,
        ...(claimed.kind ? { kind: claimed.kind } : {}),
        context: context.task.title ? `Task: ${String(context.task.title).slice(0, 500)}` : undefined,
      },
      {
        agents,
        llmResolver: resolver,
        assertBudgetForCall: createBudgetGate(runnerDeps, budget, String(claimed.taskId), String(claimed.projectId)),
        onTokenUsage: createUsageRecorder(runnerDeps, budget, String(claimed.taskId), String(claimed.projectId)),
        deadline: claimed.expiresAt,
      }
    );
    if (outcome.verdict === "expired" || outcome.verdict === "unavailable") {
      await deps.port.expire({ turnId, why: outcome.reason });
      return true;
    }
    await deps.port.answer({
      turnId,
      workerId: deps.workerId,
      verdict: outcome.verdict,
      ...(outcome.verdict === "answer" ? { answer: outcome.answer, ...(outcome.chosenOption ? { chosenOption: outcome.chosenOption } : {}) } : {}),
      rationale: outcome.rationale,
    });
  } catch (error) {
    deps.log("[decision-turn] failed", turnId, error instanceof Error ? error.message : String(error));
    await deps.port.expire({ turnId, why: "the decision turn failed" }).catch(() => undefined);
  }
  return true;
}
