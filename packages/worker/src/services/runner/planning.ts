import { runWithObservationScope } from "@/effects/observationContext";
import { unwrapSandboxBrief } from "@/orchestrator/classifier";
import { listWorkspaceLayout } from "@/utils/workspaceLayout";
import type { WorkerProject, WorkerTask } from "@/workerApi";
import type {
  AgentDefinition,
  Classification,
  ExecutionPlan,
  Requirement,
} from "@/types";
import { isBudgetExhaustedError, type BudgetTracker } from "@/orchestrator/budget";
import {
  createAuthoritativePlan,
  createOrchestratorPlan,
  type AuthoritativePlanResult,
} from "@/orchestrator/orchestrator";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import { pickOrchestrator } from "@/orchestrator/planner";
import type { GlobalLLMConfig } from "@/llm";
import type { LlmConcurrencyGate } from "@/effects/llmCall";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { RunnerDeps } from "./types";
import type { RecordUsageFn } from "./session";
import { resolveQaBaseUrl, resolveWorkspacePath } from "./setup";
import { failTaskWithError, finishBudgetExhaustedTask, finishCancelledTask } from "./terminal";
import { persistPlan } from "./finalize";
import { computePlanEstimate, type PlanCreator } from "./planReview";

export type { AuthoritativePlanResult };

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
  /**
   * Planner-only fallback CTO from getRunContext (the run's agents have no
   * enabled CTO). Never an executor.
   */
  plannerAgent?: AgentDefinition | null;
  plannerFallbackReason?: string | null;
  classification: Classification;
  budget: BudgetTracker;
  sharedContext: SharedTaskContext;
  llmConfig: GlobalLLMConfig;
  llmResolver: TaskLlmResolver;
  recordUsage: RecordUsageFn;
  assertBudgetForCall: () => void;
  signal: AbortSignal;
  llmTaskGate: LlmConcurrencyGate;
  /**
   * Plan 025: the task's requirements once known (stored on the task, or
   * extracted by the first plan). Replans keep them, so ids stay stable.
   */
  requirements?: Requirement[];
  /**
   * Bumps the task idle watchdog (armTaskAbort). Planning and replanning
   * calls take minutes on a slow model; while one is in flight the task is
   * busy, not idle (it is bounded by the planning watchdog instead).
   */
  bump?: () => void;
}

/** How often an in-flight planner call keeps the task idle watchdog alive. */
export const PLANNING_KEEPALIVE_MS = 30_000;

/**
 * Planning watchdog (e2e 2026-11-09, task B2): a planner call that has not
 * returned after `policy.planningStallMs` is a stall. The call is aborted
 * and this error ends the run; `finishOnPlanningError` fails the task with
 * a visible reason, so it never sits in planning/replanning forever.
 */
export class PlanningStalledError extends Error {
  readonly stage: "planning" | "replanning";
  readonly stallMs: number;
  constructor(stage: "planning" | "replanning", stallMs: number) {
    const minutes = Math.round((stallMs / 60_000) * 10) / 10;
    super(
      `${stage === "replanning" ? "Replanning" : "Planning"} stalled: the planner made no progress for ${minutes} min, ` +
        "so the task was stopped instead of staying in planning. Retry to plan again."
    );
    this.name = "PlanningStalledError";
    this.stage = stage;
    this.stallMs = stallMs;
  }
}

export function isPlanningStalledError(error: unknown): error is PlanningStalledError {
  return error instanceof PlanningStalledError;
}

/**
 * Run `call` under the planning watchdog. The call gets a signal that
 * aborts on the task signal OR the watchdog; the watchdog also rejects the
 * race itself, so a planner that ignores its signal still cannot hold the
 * task. `stallMs` <= 0 disables the watchdog (the call runs as is).
 */
export async function withPlanningWatchdog<T>(
  taskSignal: AbortSignal,
  stage: "planning" | "replanning",
  stallMs: number | undefined,
  call: (signal: AbortSignal, progress: () => void) => Promise<T>
): Promise<T> {
  if (!stallMs || stallMs <= 0) return call(taskSignal, () => undefined);
  const watchdog = new AbortController();
  const signal = AbortSignal.any([taskSignal, watchdog.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Progress-based: every LLM call start/finish inside the planner resets
  // the clock, so a planner that retries a slow call (e.g. a replan
  // rejected for missing_reasoning) is not a stall; one call that hangs
  // longer than stallMs still is.
  let lastProgress = Date.now();
  const progress = () => {
    lastProgress = Date.now();
  };
  const stalled = new Promise<never>((_, reject) => {
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        const remaining = lastProgress + stallMs - Date.now();
        if (remaining > 0) return arm(remaining);
        const error = new PlanningStalledError(stage, stallMs);
        // Settle the race first, then abort the in-flight call.
        reject(error);
        watchdog.abort(error);
      }, ms);
      timer.unref?.();
    };
    arm(stallMs);
  });
  const running = call(signal, progress);
  // The losing branch must never surface as an unhandled rejection.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One planner call (the orchestrator's authoritative planner subroutine)
 * over the run's wiring. `extra` carries what differs per call: the
 * stored plan to adopt (initial authoritative pass) or replan feedback.
 * Runs under the planning watchdog (policy.planningStallMs).
 */
export async function requestPlan(
  pctx: PlanningContext,
  extra: {
    storedPlan?: ExecutionPlan | null;
    storedCreatedBy?: "orchestrator" | "fallback";
    feedback?: string;
    /** "replanning" for replanOnce; default "planning". */
    stage?: "planning" | "replanning";
  } = {}
): Promise<AuthoritativePlanResult> {
  const { stage = "planning", ...planExtra } = extra;
  const bump = pctx.bump;
  // The planner is busy, not idle: keep the task idle watchdog alive while
  // the call is in flight (the planning watchdog bounds it), and bump it
  // on every LLM call start/finish inside the planner.
  bump?.();
  const keepAlive = bump ? setInterval(bump, PLANNING_KEEPALIVE_MS) : undefined;
  keepAlive?.unref?.();
  try {
    return await withPlanningWatchdog(pctx.signal, stage, pctx.deps.policy.planningStallMs, (signal, progress) =>
      runWithObservationScope(
        {
          progress: () => {
            progress();
            bump?.();
          },
        },
        () => callPlanner(pctx, planExtra, signal)
      )
    );
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    bump?.();
  }
}

async function callPlanner(
  pctx: PlanningContext,
  extra: {
    storedPlan?: ExecutionPlan | null;
    storedCreatedBy?: "orchestrator" | "fallback";
    feedback?: string;
  },
  signal: AbortSignal
): Promise<AuthoritativePlanResult> {
  const { deps, task, project } = pctx;
  return createAuthoritativePlan({
    taskId: task._id,
    projectId: project._id,
    command: pctx.command,
    title: task.title,
    agents: pctx.agents,
    plannerAgent: pctx.plannerAgent,
    plannerFallbackReason: pctx.plannerFallbackReason,
    classification: pctx.classification,
    budget: pctx.budget,
    sharedContext: pctx.sharedContext,
    policy: deps.policy,
    ...extra,
    llmConfig: pctx.llmConfig,
    llmResolver: pctx.llmResolver,
    onTokenUsage: pctx.recordUsage,
    assertBudgetForCall: pctx.assertBudgetForCall,
    signal,
    llmTaskGate: pctx.llmTaskGate,
    hasQaUrl: Boolean(resolveQaBaseUrl(project)),
    workspaceLayout: await listWorkspaceLayout(resolveWorkspacePath(deps.workspaceRoot, project.workspacePath)),
    // Requirements come from the user's own request: a Sandbox brief's
    // wrapper (header, guardrails, time box) is not a requirement.
    request: unwrapSandboxBrief(task.command),
    requirements: pctx.requirements,
  });
}

/**
 * Planner failure handling, shared by the initial plan and every replan.
 * Budget exhausted (Phase 5): the task ends with the explicit
 * budget.exhausted status. Planning aborted (cancel/deadline): the task
 * ends as cancelled and NO plan is executed. A stalled planner (planning
 * watchdog) fails the task with a visible reason. Either way this resolves
 * (the caller ends its invocation). Any other planning failure is
 * re-thrown — it propagates to the worker loop, which fails the task.
 */
export async function finishOnPlanningError(pctx: PlanningContext, error: unknown): Promise<void> {
  const { deps, task, project } = pctx;
  if (isPlanningStalledError(error) && !pctx.signal.aborted) {
    await deps.api
      .logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "task.planning_stalled",
        payload: { stage: error.stage, stallMs: error.stallMs },
        level: "error",
      })
      .catch(() => undefined);
    await failTaskWithError({ deps, taskId: task._id, projectId: project._id, message: error.message });
    return;
  }
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
  /** "user": a version edited on the Plan card (Plan Inspector). */
  createdBy: PlanCreator;
}

export interface InitialPlan {
  plan: ExecutionPlan;
  createdBy: PlanCreator;
  planVersion: number;
}

/** The planner contract knows orchestrator | fallback; a user edit adopts as orchestrator-made. */
const plannerCreator = (createdBy: PlanCreator): "orchestrator" | "fallback" =>
  createdBy === "fallback" ? "fallback" : "orchestrator";

/** Estimate for a fresh plan (best-effort; null never blocks the run). */
async function estimateFor(pctx: PlanningContext, plan: ExecutionPlan) {
  return computePlanEstimate({
    deps: pctx.deps,
    taskId: pctx.task._id,
    projectId: pctx.project._id,
    plan,
    agents: pctx.agents,
    llmResolver: pctx.llmResolver,
    multipliers: pctx.project.estimatorMultipliers,
    complexity: pctx.classification.complexity ?? null,
  });
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
  storedRow: StoredPlanRow | null | undefined,
  /** Plan Inspector "Replan with note": planner feedback for a fresh plan. */
  feedback?: string
): Promise<InitialPlan | null> {
  const { deps, task, project, classification } = pctx;
  if (!storedPlan) await logPlannerFallback(pctx);
  if (deps.policy.orchestratorAuthoritative === true) {
    let authoritative: AuthoritativePlanResult;
    try {
      authoritative = await requestPlan(pctx, {
        storedPlan,
        storedCreatedBy: storedPlan ? plannerCreator(storedRow!.createdBy) : undefined,
        ...(!storedPlan && feedback ? { feedback } : {}),
      });
    } catch (error) {
      await finishOnPlanningError(pctx, error);
      return null;
    }
    const plan = authoritative.plan;
    // An adopted user-edited version keeps its creator.
    const createdBy: PlanCreator = storedPlan ? storedRow!.createdBy : authoritative.createdBy;
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
        createdBy: authoritative.createdBy,
        classification: classification.kind,
        degradedReason: authoritative.degradedReason,
        estimate: (await estimateFor(pctx, plan)) ?? undefined,
      });
    }
    if (plan.requirements?.length) pctx.requirements = plan.requirements;
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
    created = await requestPlan(pctx, feedback ? { feedback } : {});
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
  // Plan 040: nothing leaves or changes in the plan silently. Each routing
  // change (dropped helper, BLOCKED work node, read-only conversion) is a
  // visible warn event with its reason.
  for (const adjustment of created.routingAdjustments ?? []) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: adjustment.action === "dropped" ? "plan.hint_dropped" : "plan.routing_adjusted",
      payload: { ...adjustment },
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
    degradedReason: created.degradedReason,
    estimate: (await estimateFor(pctx, plan)) ?? undefined,
  });
  if (plan.requirements?.length) pctx.requirements = plan.requirements;
  return { plan, createdBy, planVersion };
}

/**
 * plan.planner_fallback: the run's agents have no enabled CTO, so the
 * global CTO plans this run (planner only, never an executor). Logged
 * once per fresh plan.
 */
async function logPlannerFallback(pctx: PlanningContext): Promise<void> {
  if (!pctx.plannerFallbackReason || pickOrchestrator(pctx.agents)) return;
  const usable = Boolean(pctx.plannerAgent);
  await pctx.deps.api.logEvent({
    taskId: pctx.task._id,
    projectId: pctx.project._id,
    type: "plan.planner_fallback",
    payload: {
      reason: pctx.plannerFallbackReason,
      planner: usable ? pctx.plannerAgent!.name : null,
      plannerAgentId: usable ? pctx.plannerAgent!._id : null,
      role: "planner-only",
    },
    level: usable ? "info" : "warn",
  });
}
