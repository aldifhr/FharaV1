import type { WorkerAgent, WorkerApi } from "@/workerApi";
import type { BudgetTracker } from "@/orchestrator/budget";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { TokenUsageFn, TokenUsageMeta } from "@/types/llm";
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
export type RecordUsageFn = TokenUsageFn;

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
        ...(meta?.estimated ? { estimated: true } : {}),
        ...usageLedgerArgs(meta),
      });
    }
  };
}

/**
 * Plan 040 P3 ledger fields of one call, as recordTokenUsage args. Only
 * what the call actually reported is sent (all optional on tokenUsage).
 */
export function usageLedgerArgs(meta: TokenUsageMeta | undefined): {
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  providerKind?: string;
  callRole?: string;
  source: "worker";
} {
  return {
    ...(meta?.cachedInputTokens !== undefined ? { cachedInputTokens: meta.cachedInputTokens } : {}),
    ...(meta?.cacheWriteTokens !== undefined ? { cacheWriteTokens: meta.cacheWriteTokens } : {}),
    ...(meta?.reasoningTokens !== undefined ? { reasoningTokens: meta.reasoningTokens } : {}),
    ...(meta?.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(meta.durationMs)) } : {}),
    ...(meta?.providerKind ? { providerKind: meta.providerKind } : {}),
    ...(meta?.callRole ? { callRole: meta.callRole } : {}),
    source: "worker",
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
 * Thread the user's input into the run's shared context.
 *
 * Two sources: legacy `user_answer` decisions persisted on the task
 * context (rows written before the input guard existed, and the run's own
 * persisted context on resume), and undelivered `taskInputs` rows (steer /
 * answer, single input guard). Both fold into sharedContext.decisions,
 * deduplicated, so a worker restart never double-threads one input.
 * Folding does NOT mark an input delivered: that happens only when an
 * agent prompt actually renders it (see `createInputDeliveryAck`).
 * Never throws: a read failure is logged by omission and the run continues.
 */
export async function threadUserAnswers(
  deps: RunnerDeps,
  taskId: string,
  sharedContext: SharedTaskContext
): Promise<void> {
  // Capability check: legacy / test harnesses may not model getTaskContext.
  if (typeof deps.api.getTaskContext === "function") {
    const persisted = await deps.api.getTaskContext({ taskId: taskId as never }).catch(() => null);
    const answers = (persisted?.decisions ?? []) as Array<{
      decision?: string;
      reason?: string;
      createdAt?: number;
      inputId?: string;
    }>;
    for (const answer of answers) {
      if (answer.decision !== "user_answer" || !answer.reason) continue;
      foldUserInput(sharedContext, {
        reason: answer.reason,
        createdAt: answer.createdAt ?? Date.now(),
        inputId: answer.inputId,
      });
    }
  }
  await pullTaskInputs(deps, taskId, sharedContext);
}

/**
 * Fold undelivered steer/answer inputs into the shared context. Called at
 * run start and before every subtask, so a steer sent mid-run reaches the
 * next agent prompt instead of waiting for a restart.
 */
export async function pullTaskInputs(
  deps: RunnerDeps,
  taskId: string,
  sharedContext: SharedTaskContext
): Promise<void> {
  if (typeof deps.api.listPendingTaskInputs !== "function") return;
  const pending = await deps.api.listPendingTaskInputs({ taskId: taskId as never }).catch(() => []);
  for (const input of pending ?? []) {
    if (!input?.text) continue;
    foldUserInput(sharedContext, { reason: input.text, createdAt: input.createdAt, inputId: input._id });
  }
}

function foldUserInput(
  sharedContext: SharedTaskContext,
  input: { reason: string; createdAt: number; inputId?: string }
): void {
  const duplicate = sharedContext.decisions.some(
    (entry) =>
      entry.decision === "user_answer" &&
      ((input.inputId !== undefined && entry.inputId === input.inputId) ||
        (entry.createdAt === input.createdAt && entry.reason === input.reason))
  );
  if (duplicate) return;
  sharedContext.decisions = [
    ...sharedContext.decisions,
    {
      decision: "user_answer",
      reason: input.reason,
      fromAgent: "user",
      createdAt: input.createdAt,
      ...(input.inputId ? { inputId: input.inputId } : {}),
    },
  ];
}

/**
 * The delivery acknowledgement handed to the subtask executor: called with
 * the input ids a prompt actually rendered, it marks each one delivered
 * once per run (the backend mutation is idempotent too). Best-effort: a
 * failed ack leaves the row undelivered, so the input is re-offered rather
 * than lost.
 */
export function createInputDeliveryAck(deps: RunnerDeps): (inputIds: string[]) => void {
  const acked = new Set<string>();
  return (inputIds) => {
    if (typeof deps.api.markTaskInputsDelivered !== "function") return;
    const fresh = inputIds.filter((id) => !acked.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) acked.add(id);
    void deps.api
      .markTaskInputsDelivered({ inputIds: fresh as never })
      .catch(() => {
        for (const id of fresh) acked.delete(id);
      });
  };
}
