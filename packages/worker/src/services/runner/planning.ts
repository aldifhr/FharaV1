import { listWorkspaceLayout } from "@/utils/workspaceLayout";
import type { WorkerProject, WorkerTask } from "@/workerApi";
import type {
  AgentDefinition,
  Classification,
  ExecutionPlan,
} from "@/orchestrator/types";
import { isBudgetExhaustedError, type BudgetTracker } from "@/orchestrator/budget";
import {
  createAuthoritativePlan,
  createOrchestratorPlan,
} from "@/orchestrator/orchestrator";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { GlobalLLMConfig } from "@/llm";
import type { LlmConcurrencyGate } from "@/effects/llmCall";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { RunnerDeps } from "./types";
import type { RecordUsageFn } from "./session";
import { resolveQaBaseUrl, resolveWorkspacePath } from "./setup";
import { finishBudgetExhaustedTask, finishCancelledTask } from "./terminal";
import { persistPlan } from "./finalize";

export type AuthoritativePlanResult = Awaited<ReturnType<typeof createAuthoritativePlan>>;

/**
 * Everything one planner call needs for a task run. Built once by
 * `processTask` and shared by the initial plan and every replan, so the
 * planner always receives the same wiring.
 */
export interface PlanningContext {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  command: string;
  agents: AgentDefinition[];
  classification: Classification;
  budget: BudgetTracker;
  sharedContext: SharedTaskContext;
  llmConfig: GlobalLLMConfig;
  llmResolver: TaskLlmResolver;
  recordUsage: RecordUsageFn;
  assertBudgetForCall: () => void;
  signal: AbortSignal;
  llmTaskGate: LlmConcurrencyGate;
}

/**
 * One planner call (the orchestrator's authoritative planner subroutine)
 * over the run's wiring. `extra` carries what differs per call: the
 * stored plan to adopt (initial authoritative pass) or replan feedback.
 */
export async function requestPlan(
  pctx: PlanningContext,
  extra: {
    storedPlan?: ExecutionPlan | null;
    storedCreatedBy?: "orchestrator" | "fallback";
    feedback?: string;
  } = {}
): Promise<AuthoritativePlanResult> {
  const { deps, task, project } = pctx;
  return createAuthoritativePlan({
    taskId: task._id,
    projectId: project._id,
    command: pctx.command,
    title: task.title,
    agents: pctx.agents,
    classification: pctx.classification,
    budget: pctx.budget,
    sharedContext: pctx.sharedContext,
    policy: deps.policy,
    ...extra,
    llmConfig: pctx.llmConfig,
    llmResolver: pctx.llmResolver,
    onTokenUsage: pctx.recordUsage,
    assertBudgetForCall: pctx.assertBudgetForCall,
    signal: pctx.signal,
    llmTaskGate: pctx.llmTaskGate,
    hasQaUrl: Boolean(resolveQaBaseUrl(project)),
    workspaceLayout: await listWorkspaceLayout(resolveWorkspacePath(deps.workspaceRoot, project.workspacePath)),
  });
}

/**
 * Planner failure handling, shared by the initial plan and every replan.
 * Budget exhausted (Phase 5): the task ends with the explicit
 * budget.exhausted status. Planning aborted (cancel/deadline): the task
 * ends as cancelled and NO plan is executed. Either way this resolves
 * (the caller ends its invocation). Any other planning failure is
 * re-thrown — it propagates to the worker loop, which fails the task.
 */
export async function finishOnPlanningError(pctx: PlanningContext, error: unknown): Promise<void> {
  const { deps, task, project } = pctx;
  if (isBudgetExhaustedError(error)) {
    await finishBudgetExhaustedTask({
      deps,
      task,
      project,
      budget: pctx.budget,
      reason: error.reason,
    });
    return;
  }
  if (pctx.signal.aborted) {
    await finishCancelledTask({
      deps,
      task,
      project,
      signal: pctx.signal,
    });
    return;
  }
  throw error;
}

/** Stored plan row as returned by `getContext`. */
export interface StoredPlanRow {
  version: number;
  createdBy: "orchestrator" | "fallback";
}

export interface InitialPlan {
  plan: ExecutionPlan;
  createdBy: "orchestrator" | "fallback";
  planVersion: number;
}

/**
 * Produce the plan this run executes (and persist it when new). Returns
 * null when planning ended the task (budget exhausted / cancelled).
 *
 * Authoritative mode (Phase 3): the orchestrator is the single planning
 * authority; its planner subroutine produces the one plan that will be
 * executed — the orchestrator.plan event describes that executed plan.
 * Legacy mode (flag off): an advisory orchestrator plan for the event
 * log; the planner's plan is created and executed independently.
 */
export async function createInitialPlan(
  pctx: PlanningContext,
  storedPlan: ExecutionPlan | null,
  storedRow: StoredPlanRow | null | undefined
): Promise<InitialPlan | null> {
  const { deps, task, project, classification } = pctx;
  if (deps.policy.orchestratorAuthoritative === true) {
    let authoritative: AuthoritativePlanResult;
    try {
      authoritative = await requestPlan(pctx, {
        storedPlan,
        storedCreatedBy: storedPlan ? storedRow!.createdBy : undefined,
      });
    } catch (error) {
      await finishOnPlanningError(pctx, error);
      return null;
    }
    const plan = authoritative.plan;
    const createdBy = authoritative.createdBy;
    const planVersion = storedPlan
      ? storedRow!.version
      : (storedRow?.version ?? 0) + 1;
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "orchestrator.plan",
      payload: {
        strategy: authoritative.orchestratorPlan.strategy,
        reasoning: authoritative.orchestratorPlan.reasoning,
        primary: authoritative.primaryAgent?.name ?? null,
        primaryCapability: authoritative.primaryCapability,
        selectedAgents: authoritative.plan.subtasks.map((subtask) => ({
          key: subtask.key,
          title: subtask.title,
          capability: subtask.capability,
          kind: subtask.kind,
        })),
        authoritative: true,
      },
    });
    if (!storedPlan) {
      // No chat message about the plan here: the CTO posts ONE
      // consolidated summary when the task completes (see finalize).
      // The plan itself is recorded via orchestrator.plan / plan.created.
      if (authoritative.degradedReason) {
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "plan.degraded",
          payload: { reason: authoritative.degradedReason.slice(0, 1000) },
          level: "warn",
        });
      }
      await persistPlan(deps, {
        taskId: task._id,
        projectId: project._id,
        plan,
        version: planVersion,
        createdBy,
        classification: classification.kind,
      });
    }
    return { plan, createdBy, planVersion };
  }

  const orchestratorPlan = createOrchestratorPlan({
    taskId: task._id,
    projectId: project._id,
    command: pctx.command,
    title: task.title,
    agents: pctx.agents,
    classification,
  });
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "orchestrator.plan",
    payload: {
      strategy: orchestratorPlan.strategy,
      reasoning: orchestratorPlan.reasoning,
      primary: orchestratorPlan.primary?.name ?? null,
    },
  });

  if (storedPlan) {
    return {
      plan: storedPlan,
      createdBy: storedRow!.createdBy,
      planVersion: storedRow!.version,
    };
  }
  let created: AuthoritativePlanResult;
  try {
    created = await requestPlan(pctx);
  } catch (error) {
    await finishOnPlanningError(pctx, error);
    return null;
  }
  const plan = created.plan;
  const createdBy = created.createdBy;
  const planVersion = (storedRow?.version ?? 0) + 1;
  if (created.degradedReason) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "plan.degraded",
      payload: { reason: created.degradedReason.slice(0, 1000) },
      level: "warn",
    });
  }
  for (const key of created.droppedHintKeys ?? []) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "plan.hint_dropped",
      payload: { key, reason: "no enabled agent serves the capability" },
      level: "info",
    });
  }
  await persistPlan(deps, {
    taskId: task._id,
    projectId: project._id,
    plan,
    version: planVersion,
    createdBy,
    classification: classification.kind,
  });
  return { plan, createdBy, planVersion };
}
