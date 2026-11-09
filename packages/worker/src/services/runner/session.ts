import type { WorkerAgent, WorkerApi } from "@/workerApi";
import type { BudgetTracker } from "@/orchestrator/budget";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { TokenUsageMeta } from "@/effects/llmCall";
import type { ExecutePlanInput, RunnerDeps } from "./types";

/**
 * Per-run wiring shared by `processTask` and `resumeTask`: the budget
 * gate closure, the token-usage sink, the MCP status reporter, the
 * dynamic-subtask persister, and the ask_user answer threading. Each
 * helper is a pure factory over (deps, taskId, projectId) so both entry
 * points build byte-identical closures.
 */

type TaskId = string;
type ProjectId = string;

/** The usage sink signature threaded to the planner and every subtask. */
export type RecordUsageFn = (
  inputTokens: number,
  outputTokens: number,
  model: string,
  agentName: string,
  agentId?: string,
  meta?: TokenUsageMeta
) => Promise<void>;

/**
 * Pre-call budget gate closure (Phase 5): warn mode emits ONE
 * budget.warning event per distinct exhaustion reason (the tracker
 * dedupes); enforce mode throws out of this closure.
 */
export function createBudgetGate(
  deps: RunnerDeps,
  budget: BudgetTracker,
  taskId: TaskId,
  projectId: ProjectId
): () => void {
  return () =>
    budget.assertLlmCallAllowed((reason) => {
      void deps.api
        .logEvent({
          taskId,
          projectId,
          type: "budget.warning",
          payload: { reason, budget: budget.snapshot() },
          level: "warn",
        })
        .catch(() => undefined);
    });
}

/**
 * Single usage sink: feeds the budget tracker AND the persisted
 * tokenUsage table, used by the planner and every subtask callback.
 */
export function createUsageRecorder(
  deps: RunnerDeps,
  budget: BudgetTracker,
  taskId: TaskId,
  projectId: ProjectId
): RecordUsageFn {
  return async (inputTokens, outputTokens, model, agentName, agentId, meta) => {
    budget.recordLLMCall({ inputTokens, outputTokens, model, agentName, agentId });
    if (inputTokens > 0 || outputTokens > 0) {
      await deps.api.recordTokenUsage({
        projectId,
        taskId,
        agentId: agentId as WorkerAgent["_id"] | undefined,
        agentName,
        model,
        inputTokens,
        outputTokens,
        // Phase 5 attribution: serving connection + registry model +
        // estimated cost, when the serving handle carried them.
        providerId: meta?.providerId as
          | Parameters<WorkerApi["recordTokenUsage"]>[0]["providerId"]
          | undefined,
        modelId: meta?.modelRowId as
          | Parameters<WorkerApi["recordTokenUsage"]>[0]["modelId"]
          | undefined,
        estimatedCost: meta?.estimatedCost,
      });
    }
  };
}

/**
 * Plan 009: MCP server status reporter. Status reports are best-effort;
 * the task runs on regardless.
 */
export function mcpStatusReporter(deps: RunnerDeps) {
  return (serverId: string, status: "connected" | "disconnected" | "error", errorMessage?: string) =>
    deps.api
      .updateMcpServerStatus({
        serverId: serverId as Parameters<WorkerApi["updateMcpServerStatus"]>[0]["serverId"],
        status,
        errorMessage,
      })
      .catch(() => undefined);
}

/**
 * Persist dynamically spawned subtasks (Phase 4 hardening) through the
 * backend checkpoint mutation.
 */
export function dynamicSubtaskPersister(
  deps: RunnerDeps,
  taskId: TaskId,
  projectId: ProjectId
): NonNullable<ExecutePlanInput["onDynamicSubtasks"]> {
  return async ({ added, origin, plan: currentPlan, version }) => {
    await deps.api.saveDynamicSubtasks?.({
      taskId,
      projectId,
      version,
      payload: currentPlan,
      subtasks: added.map((subtask) => ({
        key: subtask.key,
        title: subtask.title,
        description: subtask.description,
        kind: subtask.kind,
        capability: subtask.capability,
        dependencies: subtask.dependencies,
        order: subtask.order,
        allowedPaths: subtask.allowedPaths,
        reviewRound: subtask.reviewRound,
        origin,
      })),
    });
  };
}

/**
 * Thread the user's ask_user answers into the run's shared context
 * (plan 013 step 4). The answer mutation in the backend persists a
 * `user_answer` decision onto the task context; this run folds any it
 * does not already know (by createdAt) into sharedContext.decisions —
 * deduplicated so a worker restart never double-threads one answer.
 * Never throws: a context read failure is logged and the run continues.
 */
export async function threadUserAnswers(
  deps: RunnerDeps,
  taskId: string,
  sharedContext: SharedTaskContext
): Promise<void> {
  // Capability check: legacy / test harnesses may not model getTaskContext.
  if (typeof deps.api.getTaskContext !== "function") return;
  const persisted = await deps.api.getTaskContext({ taskId }).catch(() => null);
  const answers = (persisted?.decisions ?? []) as Array<{
    decision?: string;
    reason?: string;
    createdAt?: number;
  }>;
  const seen = new Set(
    sharedContext.decisions.map((entry) => `${entry.createdAt}:${entry.reason ?? ""}`)
  );
  for (const answer of answers) {
    if (answer.decision !== "user_answer" || !answer.reason) continue;
    const key = `${answer.createdAt}:${answer.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sharedContext.decisions = [
      ...sharedContext.decisions,
      {
        decision: "user_answer",
        reason: answer.reason,
        fromAgent: "user",
        createdAt: answer.createdAt ?? Date.now(),
      },
    ];
  }
}
