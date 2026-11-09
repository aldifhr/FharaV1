import type { WorkerProject, WorkerTask } from "@/workerApi";
import type { AgentDefinition, Classification, ExecutionPlan } from "@/types";
import { routeCapability } from "@/orchestrator/capabilities";
import type { TaskLlmResolver } from "@/llm/resolver";
import {
  estimatePlan,
  type EstimateMultiplier,
  type EstimateModel,
  type EstimateSample,
  type PlanEstimate,
} from "@/api/convex/lib/estimate";
import { planReviewApplies } from "@/api/convex/lib/planReviewPolicy";
import type { RunnerDeps } from "./types";

/**
 * Plan Inspector (pause after plan.created for the user's review) and the
 * Task Estimator (pure estimate stored on the plan), worker side.
 */

export type PlanCreator = "orchestrator" | "fallback" | "user";

/**
 * Pure part of the estimate wiring: route each subtask the way the
 * scheduler will (routeCapability over the run's agents), take the
 * resolver's expected model per role, and run the shared estimator.
 */
export function buildPlanEstimate(input: {
  plan: ExecutionPlan;
  agents: AgentDefinition[];
  samples: EstimateSample[];
  expectedModel: (agent: AgentDefinition) => EstimateModel | null;
  allowFallback?: boolean;
  now: number;
  /** Decision Outcome Calibration: the project's estimator multipliers and the task complexity. */
  multipliers?: EstimateMultiplier[];
  complexity?: string | null;
}): PlanEstimate {
  const models: Record<string, EstimateModel | undefined> = {};
  const subtasks = input.plan.subtasks.map((subtask) => {
    const agent = routeCapability(subtask.capability, input.agents, { allowFallback: input.allowFallback });
    const role = agent ? agent.role.trim().toLowerCase() : null;
    if (agent && role && !(role in models)) models[role] = input.expectedModel(agent) ?? undefined;
    return { key: subtask.key, kind: subtask.kind, role, dependencies: subtask.dependencies };
  });
  return estimatePlan({
    subtasks,
    samples: input.samples,
    models,
    maxConcurrency: input.plan.maxConcurrency,
    now: input.now,
    multipliers: input.multipliers,
    complexity: input.complexity ?? null,
  });
}

/**
 * Compute the estimate for a fresh plan. Best-effort: history that cannot
 * be read falls back to the defaults; any other failure returns null with a
 * warn event (the run never fails because of its estimate).
 */
export async function computePlanEstimate(input: {
  deps: RunnerDeps;
  taskId: string;
  projectId: string;
  plan: ExecutionPlan;
  agents: AgentDefinition[];
  llmResolver: TaskLlmResolver;
  multipliers?: EstimateMultiplier[];
  complexity?: string | null;
}): Promise<PlanEstimate | null> {
  const { deps } = input;
  try {
    let samples: EstimateSample[] = [];
    try {
      samples = ((await deps.api.getEstimateSamples?.({ projectId: input.projectId })) ?? []) as EstimateSample[];
    } catch {
      samples = [];
    }
    return buildPlanEstimate({
      plan: input.plan,
      agents: input.agents,
      samples,
      expectedModel: (agent) => input.llmResolver.expectedModelFor?.(agent) ?? null,
      allowFallback: deps.policy.allowFallback,
      now: Date.now(),
      multipliers: input.multipliers,
      complexity: input.complexity ?? null,
    });
  } catch (error) {
    await deps.api
      .logEvent({
        taskId: input.taskId,
        projectId: input.projectId,
        type: "plan.estimate_failed",
        payload: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
        level: "warn",
      })
      .catch(() => undefined);
    return null;
  }
}

/**
 * Gate between plan.created and execution. Returns "paused" when the run
 * must stop here and wait for the user (the backend now holds a pending
 * `plan` approval and the task is needs_approval), "proceed" otherwise.
 *
 * Proceeds when: the setting does not apply (off / below threshold / Full
 * access without "always"), execution already started (recovery of a run
 * that was approved or predates the setting), or this exact plan version
 * was approved. Anything that cannot open the review fails CLOSED
 * ("paused") — an unreviewed plan never runs when review applies.
 */
export async function planReviewGate(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  planVersion: number;
  classification: Classification;
  executionStarted: boolean;
}): Promise<"proceed" | "paused"> {
  const { deps, task, project } = input;
  const decision = planReviewApplies({
    setting: (project as { planReview?: unknown }).planReview,
    complexity: input.classification.complexity ?? null,
    permissionMode: (task as { permissionMode?: unknown }).permissionMode,
  });
  if (!decision.applies) {
    if (decision.reason === "full_access") {
      await deps.api
        .logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "plan.review_skipped",
          payload: { reason: "full_access", planVersion: input.planVersion },
          level: "info",
        })
        .catch(() => undefined);
    }
    return "proceed";
  }
  if (input.executionStarted) return "proceed";
  const approvals = await deps.api.getApprovals({ taskId: task._id });
  const approved = approvals.some(
    (approval) => approval.kind === "plan" && approval.status === "approved" && approval.planVersion === input.planVersion
  );
  if (approved) return "proceed";
  let result: { applied: boolean; reason?: string } | undefined;
  try {
    result = (await deps.api.requestPlanReview({
      taskId: task._id,
      projectId: project._id,
      planVersion: input.planVersion,
      reason: decision.reason,
    })) as { applied: boolean; reason?: string };
  } catch (error) {
    result = { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!result?.applied) {
    const reason = result?.reason ?? "unknown";
    deps.log(`plan review could not be opened for ${task._id}: ${reason}; not executing`);
    // Displaced or already over: another owner / the terminal state wins.
    // Anything else would leave the task running with no one on it.
    if (reason !== "lease_lost" && reason !== "task_already_terminal") {
      await deps.api
        .completeTask({ taskId: task._id, status: "failed", errorMessage: `Plan review could not be opened: ${reason}` })
        .catch(() => undefined);
    }
  }
  return "paused";
}
