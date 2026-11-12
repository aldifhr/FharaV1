import type { WorkerProject, WorkerTask } from "@/workerApi";
import type { AgentDefinition, EvaluationVerdict } from "@/types";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { LlmConcurrencyGate } from "@/effects/llmCall";
import type { RoleSubtask } from "./roleLearnings";
import type { RunnerDeps, RunState } from "./types";
import { reconcileTaskMemory, summarizeRun } from "./memoryReconcile";
import { collectRoleLearnings } from "./roleLearnings";

/**
 * The tail of a run that finalized and will not be re-planned (moved out
 * of taskRunner with P1b phase 2): memory suggestions, role learnings and
 * the lifecycle transition. finalize() already completed the task row;
 * nothing here changes its status, and every step is best-effort.
 */
export async function settleCompletedRun(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  state: RunState;
  verdict: EvaluationVerdict;
  agents: AgentDefinition[];
  subtasks: RoleSubtask[];
  llmResolver: TaskLlmResolver;
  assertBudgetForCall: () => void;
  llmTaskGate: LlmConcurrencyGate;
  recordUsage: NonNullable<Parameters<typeof reconcileTaskMemory>[0]["onTokenUsage"]>;
  signal: AbortSignal;
}): Promise<void> {
  const { deps, task, project, state, verdict, agents, llmResolver, assertBudgetForCall, llmTaskGate, signal } = input;
  const status = verdict === "failed" || verdict === "inconclusive" ? "failed" : "done";
  // Plan L5: memory suggestions from the finished task (best-effort,
  // budget-gated, idempotent per task; never changes its status).
  await reconcileTaskMemory({
    deps,
    taskId: task._id,
    projectId: project._id,
    task: {
      title: task.title,
      request: task.command,
      status,
      filesChanged: Array.from(state.fileChanges.keys()),
      blockers: [...state.feedback],
      summary: summarizeRun(state),
    },
    agent: agents.find((candidate) => /^cto$/i.test(candidate.role)) ?? agents[0] ?? null,
    llmResolver,
    assertBudgetForCall,
    llmTaskGate,
    onTokenUsage: input.recordUsage,
    signal,
  }).catch(() => undefined);
  // Role memory: each role that finished work here writes its own
  // notes for this project (one budget-gated call per role, no
  // approval; off when the project turned "Role memory" off).
  await collectRoleLearnings({
    deps,
    taskId: task._id,
    projectId: project._id,
    project: project as { roleMemoryDisabled?: boolean },
    task: { title: task.title, request: task.command, status },
    agents,
    subtasks: input.subtasks,
    outputs: state.priorOutputs,
    llmResolver,
    assertBudgetForCall,
    llmTaskGate,
    onTokenUsage: input.recordUsage,
    signal,
  }).catch(() => undefined);
  await deps.api
    .recordLifecycle?.({
      taskId: task._id,
      projectId: project._id,
      state: verdict === "failed" ? "FAILED" : "COMPLETED",
      prevState: "RUNNING",
    })
    ?.catch(() => undefined);
}
