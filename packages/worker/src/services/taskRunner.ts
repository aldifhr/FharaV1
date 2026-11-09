import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerExecutionId,
  WorkerProject,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";
import {
  CAPABILITY,
  type AgentDefinition,
  type ExecutionPlan,
  type PlanSubtask,
  type SubtaskKind,
} from "@/orchestrator/types";
import { classifyCommand } from "@/orchestrator/classifier";
import { wantsVisualQa } from "@/orchestrator/planner";
import { validatePlan } from "@/orchestrator/planValidator";
import { BudgetTracker, isBudgetExhaustedError } from "@/orchestrator/budget";
import type { TokenUsageMeta } from "@/effects/llmCall";
import {
  createAuthoritativePlan,
  createOrchestratorPlan,
  evaluateAfterExecution,
} from "@/orchestrator/orchestrator";
import {
  createSharedTaskContext,
  resolveIssuesForApproval,
  resolveIssuesForQaPass,
  type SharedTaskContext,
} from "@/orchestrator/taskContext";
import type { Classification } from "@/orchestrator/types";
import type { GlobalLLMConfig } from "@/llm";
import { LlmConcurrencyGate, type FallbackHandle } from "@/effects/llmCall";
import { TaskLlmResolver } from "@/llm/resolver";
import { routeCapability, capabilitiesOf } from "@/orchestrator/capabilities";
import {
  buildFixSubtask,
  buildReviewFixSubtask,
  collectRequestedChanges,
  formatReviewFindings,
} from "@/orchestrator/reviewLoop";
import {
  decide,
  applyDecision,
  evaluateObjective,
  type DecisionContext,
  type DecisionObservation,
} from "@/orchestrator/decision";
import { decideWithLlm } from "@/orchestrator/decisionLlm";
import type { ReviewFinding, ReviewResult } from "@/utils/json";
import { executeSubtask } from "@/execution/agentExecutor";
import type { McpSession } from "@/mcp/registry";
import { WebClient } from "@/tools/webClient";
import { runVerification } from "@/execution/verification";
import {
  runScheduler,
  type NodeOutcome,
  type SchedulerNode,
  type SchedulerResult,
} from "@/scheduler/dagScheduler";
import { evaluateTask } from "@/orchestrator/evaluator";
import {
  applyFileChange,
  hashContent,
  snapshotIdForChanges,
  type FileDiff,
} from "@/tools/gitDiff";
import { commitWorktree, describeCommit } from "@/tools/gitWorktree";
import type { RunnerDeps, RunState } from "./runner/types";
import {
  buildStateFromDb,
  carryForwardState,
} from "./runner/state";
import {
  armTaskAbort,
  buildReplanFeedback,
  completedSubtasksFor,
  buildTaskLlmResolver,
  budgetReasonFromSummary,
  combineSignals,
  dryRunPolicy,
  finishBudgetExhaustedTask,
  finishCancelledTask,
  implementerAgent,
  isForbiddenFilePath,
  isTerminalTaskStatus,
  mcpForTask,
  normalizeFileChangePath,
  qaFindings,
  resolveQaBaseUrl,
  resolveWorkspacePath,
  seedBudgetFromPersisted,
  stagehandConfigFrom,
  summaryHasBudgetFailure,
  toAgentDefinition,
  toAgentResult,
  withFileContexts,
} from "./runner/setup";
import { finalize, persistPlan } from "./runner/finalize";
import { handleNodeOutcome } from "./runner/decision";
import { runNodes as runNodesImpl } from "./runner/runNodes";
import { runReviewLoop as runReviewLoopImpl } from "./runner/reviewLoop";
import { runQaLoop as runQaLoopImpl } from "./runner/qaLoop";
import { runVerificationLoop } from "./runner/verifyLoop";
import type { RunContext } from "./runner/types";


// Re-exports keep the public surface of `@/services/taskRunner` stable:
// tests import `buildStateFromDb`, `carryForwardState`, and
// `resolveQaBaseUrl`, and `src/index.ts` imports the `RunnerDeps` type.
// The implementations live in `./runner/*`; this module is the lifecycle
// entry point (processTask / resumeTask) plus executePlan's orchestration.
export { buildStateFromDb, carryForwardState } from "./runner/state";
export { resolveQaBaseUrl } from "./runner/setup";
export type { RunnerDeps, RunState } from "./runner/types";

/**
 * Thread the user's ask_user answers into the run's shared context
 * (plan 013 step 4). The answer mutation in the backend persists a
 * `user_answer` decision onto the task context; this run folds any it
 * does not already know (by createdAt) into sharedContext.decisions —
 * deduplicated so a worker restart never double-threads one answer.
 * Never throws: a context read failure is logged and the run continues.
 */
async function threadUserAnswers(
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

export async function processTask(task: WorkerTask, deps: RunnerDeps): Promise<void> {
  const context = await deps.api.getContext({ taskId: task._id });
  if (!context?.project) {
    await deps.api.completeTask({
      taskId: task._id,
      status: "failed",
      errorMessage: "Project not found for task",
    });
    return;
  }
  const { project, agents, approvalMode, llmProviders } = context;
  if (agents.length === 0) {
    await deps.api.completeTask({
      taskId: task._id,
      status: "failed",
      errorMessage: "No agents are assigned to this project",
    });
    return;
  }
  // LLM resolution is per agent (Phase 2 resolver): the pool is
  // materialized once per task (keys decrypted here, never via process.env
  // mutation), and each planner/executor call resolves its own agent's
  // assignment → fallback → pool chain. `llmConfig` remains as the
  // task-level default for agent-less consumers.
  let llmResolver: TaskLlmResolver;
  let llmConfig: GlobalLLMConfig;
  try {
    llmResolver = await buildTaskLlmResolver(llmProviders);
    llmConfig = llmResolver.defaultConfig();
  } catch (error) {
    await deps.api.completeTask({
      taskId: task._id,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // QA base URL is resolved once per task (project.qaUrl > project.devUrl >
  // worker-start env fallback) and threaded explicitly to the QA executor.
  // It is never written to process.env: with concurrent tasks the shared
  // variable raced, so one project's QA could run against another's URL,
  // and projects without a URL silently inherited the previous task's.
  const qaBaseUrl = resolveQaBaseUrl(project);

  let workspacePath = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
  await fs.mkdir(workspacePath, { recursive: true });

  // Plan 009: seed the shared MCP registry for this workspace. Status
  // reports are best-effort; the task runs on regardless.
  const mcp = mcpForTask(context.mcpServers, workspacePath, deps.policy, (serverId, status, errorMessage) =>
    deps.api
      .updateMcpServerStatus({
        serverId: serverId as Parameters<WorkerApi["updateMcpServerStatus"]>[0]["serverId"],
        status,
        errorMessage,
      })
      .catch(() => undefined)
  );

  let branchName: string | undefined;
  let worktreePath: string | undefined;
  if (deps.policy.worktreeIsolation) {
    try {
      const created = await deps.api.createBranch({
        taskId: task._id,
        projectId: project._id,
      });
      branchName = created.branchName;
      worktreePath = resolveWorkspacePath(deps.workspaceRoot, created.worktreePath);
      workspacePath = worktreePath;
      await fs.mkdir(workspacePath, { recursive: true });
    } catch (error) {
      await deps.api.completeTask({
        taskId: task._id,
        status: "failed",
        errorMessage: `Worktree isolation requested but unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }
  }

  // When the CTO assigned this task from chat, the backend already narrows
  // the pool to task.assignedAgentIds ([CTO, assignees, Reviewer, QA]).
  // Keep the assignment ORDER (assignees before any other agent serving
  // the same capability) so routing ties go to the assigned implementers.
  const assignedOrder = ((task as { assignedAgentIds?: string[] }).assignedAgentIds ?? []).map(String);
  const runAgents = (agents as WorkerAgent[])
    .map(toAgentDefinition)
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => {
      const ra = assignedOrder.indexOf(String(a.agent._id));
      const rb = assignedOrder.indexOf(String(b.agent._id));
      if (ra === -1 && rb === -1) return a.index - b.index;
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    })
    .map(({ agent }) => agent);
  const command = await withFileContexts(deps.workspaceRoot, project.workspacePath, task.command);
  const classification = classifyCommand(command);
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.classified",
    payload: {
      kind: classification.kind,
      strategy: classification.strategy,
      reasons: classification.reasons,
    },
  });

  // Intelligent orchestrator: shared context + budget
  const budget = new BudgetTracker(deps.policy);
  // Seed the tracker with usage already persisted for this task (e.g. calls
  // made before a worker restart) so limits apply to the task as a whole —
  // the FULL state (agents/delegations/retries from the budget snapshot),
  // with failures surfaced as events (Phase 5; see seedBudgetFromPersisted).
  await seedBudgetFromPersisted({
    deps,
    taskId: task._id,
    projectId: project._id,
    budget,
  });
  // Pre-call budget gate closure (Phase 5): warn mode emits ONE
  // budget.warning event per distinct exhaustion reason (the tracker
  // dedupes); enforce mode throws out of this closure.
  const assertBudgetForCall = () =>
    budget.assertLlmCallAllowed((reason) => {
      void deps.api
        .logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "budget.warning",
          payload: { reason, budget: budget.snapshot() },
          level: "warn",
        })
        .catch(() => undefined);
    });
  // Single usage sink: feeds the budget tracker AND the persisted
  // tokenUsage table, used by the planner and every subtask callback.
  const recordUsage = async (
    inputTokens: number,
    outputTokens: number,
    model: string,
    agentName: string,
    agentId?: string,
    meta?: TokenUsageMeta
  ) => {
    budget.recordLLMCall({ inputTokens, outputTokens, model, agentName, agentId });
    if (inputTokens > 0 || outputTokens > 0) {
      await deps.api.recordTokenUsage({
        projectId: project._id,
        taskId: task._id,
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
  const sharedContext = createSharedTaskContext({
    taskId: task._id,
    projectId: project._id,
    originalRequest: command,
    title: task.title,
    classification,
    instructions: (project as { instructions?: string }).instructions,
  });
  // Plan 013 step 4: a re-queued run threads the user's answer(s) into
  // the shared context before planning/execution reads it.
  await threadUserAnswers(deps, task._id, sharedContext);
  await deps.api
    .upsertTaskContext?.({
      taskId: task._id,
      projectId: project._id,
      originalRequest: command,
      objective: command.slice(0, 500),
      status: (task.status as any) || "running",
      decisions: [],
      artifacts: [],
      outstandingIssues: [],
      // Phase 5: persist the seeded budget state alongside the context
      // so the next resume/recovery restores the full tracker.
      budgetSnapshot: budget.snapshot(),
    })
    ?.catch(() => undefined);
  await deps.api.recordLifecycle?.({ taskId: task._id, projectId: project._id, state: "RUNNING" })?.catch(() => undefined);

  // Phase 4 hardening: ONE per-task LLM gate for this whole run, sized
  // by THIS task's policy and owned by this run alone — concurrent
  // tasks never share it and never resize each other's bound (the
  // worker-wide gate is separate worker configuration, set once at
  // process start). The task deadline is armed NOW, before planning:
  // it used to be armed only after the plan existed, so a slow planner
  // ran with no deadline at all, and a task cancelled during planning
  // still received (and executed) a fresh plan.
  const llmTaskGate = new LlmConcurrencyGate(deps.policy.maxConcurrentLLMCalls);
  const taskAbort = armTaskAbort(deps.policy, deps.shutdownSignal);

  try {
  let plan: ExecutionPlan;
  let createdBy: "orchestrator" | "fallback" = "fallback";
  let planVersion: number;

  const stored = context.plan ? validatePlan(context.plan.payload, deps.policy.maxSubtasks) : null;
  const storedPlan = stored?.ok && stored.plan ? stored.plan : null;

  if (deps.policy.orchestratorAuthoritative === true) {
    // Phase 3: the orchestrator is the single planning authority. It runs
    // its decision pass over THIS task's budget + shared context and its
    // planner subroutine produces the one plan that will be executed —
    // the orchestrator.plan event describes that executed plan and the
    // primary agent is the agent serving its first subtask.
    let authoritative: Awaited<ReturnType<typeof createAuthoritativePlan>>;
    try {
      authoritative = await createAuthoritativePlan({
        taskId: task._id,
        projectId: project._id,
        command,
        title: task.title,
        agents: runAgents,
        classification,
        budget,
        sharedContext,
        policy: deps.policy,
        storedPlan,
        storedCreatedBy: storedPlan ? context.plan!.createdBy : undefined,
        llmConfig,
        llmResolver,
        onTokenUsage: recordUsage,
        assertBudgetForCall,
        signal: taskAbort.controller.signal,
        llmTaskGate,
        hasQaUrl: Boolean(resolveQaBaseUrl(project)),
      });
    } catch (error) {
      // Budget exhausted before planning (Phase 5): the task ends with
      // the explicit budget.exhausted status; no plan is executed.
      if (isBudgetExhaustedError(error)) {
        await finishBudgetExhaustedTask({
          deps,
          task,
          project,
          budget,
          reason: error.reason,
        });
        return;
      }
      // Planning aborted (cancel/deadline): the task ends as cancelled
      // and NO plan is executed. Any other planning failure keeps the
      // historical behavior — it propagates to the worker loop, which
      // fails the task.
      if (taskAbort.controller.signal.aborted) {
        await finishCancelledTask({
          deps,
          task,
          project,
          signal: taskAbort.controller.signal,
        });
        return;
      }
      throw error;
    }
    plan = authoritative.plan;
    createdBy = authoritative.createdBy;
    planVersion = storedPlan
      ? context.plan!.version
      : (context.plan?.version ?? 0) + 1;
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
  } else {
    // Legacy path (flag off): advisory orchestrator plan for the event
    // log; the planner's plan is created and executed independently.
    const orchestratorPlan = createOrchestratorPlan({
      taskId: task._id,
      projectId: project._id,
      command,
      title: task.title,
      agents: runAgents,
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
      plan = storedPlan;
      createdBy = context.plan!.createdBy;
      planVersion = context.plan!.version;
    } else {
      let created: Awaited<ReturnType<typeof createAuthoritativePlan>>;
      try {
        created = await createAuthoritativePlan({
          taskId: task._id,
          projectId: project._id,
          command,
          title: task.title,
          agents: runAgents,
          classification,
          budget,
          sharedContext,
          policy: deps.policy,
          llmConfig,
          llmResolver,
          onTokenUsage: recordUsage,
          assertBudgetForCall,
          signal: taskAbort.controller.signal,
          llmTaskGate,
          hasQaUrl: Boolean(resolveQaBaseUrl(project)),
        });
      } catch (error) {
        if (isBudgetExhaustedError(error)) {
          await finishBudgetExhaustedTask({
            deps,
            task,
            project,
            budget,
            reason: error.reason,
          });
          return;
        }
        if (taskAbort.controller.signal.aborted) {
          await finishCancelledTask({
            deps,
            task,
            project,
            signal: taskAbort.controller.signal,
          });
          return;
        }
        throw error;
      }
      plan = created.plan;
      createdBy = created.createdBy;
      planVersion = (context.plan?.version ?? 0) + 1;
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
    }
  }

  // Recovery (Phase 4): when the stored plan was adopted, this run
  // continues work a previous worker already persisted — seed the
  // execution state from the DB via the ONE builder shared with
  // resumeTask, so completed subtasks are not re-executed and their
  // staged file changes are not lost. A freshly created plan (and every
  // replan below) starts from an empty state.
  const seeded = storedPlan
    ? buildStateFromDb({
        subtasks: context.subtasks,
        executions: context.executions,
        fileChanges: await deps.api.getFileChanges({ taskId: task._id }),
      })
    : null;
  const state: RunState = seeded?.state ?? {
    priorOutputs: new Map(),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(),
    appliedFilesBySubtask: new Map(),
    feedback: [],
  };
  let completedKeys: Set<string> = seeded?.completedKeys ?? new Set<string>();

  // (The run's abort controller was armed before planning, above:
  // executePlan's cancel polling fires it when the task row turns
  // terminal, and its policy.taskTimeoutMs deadline fires on overrun.)

  let replans = task.replanCount ?? 0;
  let feedback: string | undefined;
  // Spec §7 vocabulary: maxPlanningIterations is the single bound on
  // planning iterations; it aliases maxReplans in loadPolicy and falls
  // back to it for hand-built policies that omit the alias.
  const maxPlanningIterations =
    deps.policy.maxPlanningIterations ?? deps.policy.maxReplans;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "executing", planVersion },
      });

      const outcome = await executePlan({
        deps,
        task,
        project,
        workspacePath,
        agents: runAgents,
        plan,
        planVersion,
        state,
        feedback,
        approvalMode,
        completedKeys,
        taskAbort: Object.assign(taskAbort.controller, { bump: taskAbort.bump }),
        budget,
        assertBudgetForCall,
        sharedContext,
        classification,
        llmConfig,
        llmResolver,
        llmTaskGate,
        onTokenUsage: recordUsage,
        qaBaseUrl,
        mcp,
        worktree:
          branchName && worktreePath ? { branchName, worktreePath } : undefined,
        onDynamicSubtasks: async ({ added, origin, plan: currentPlan, version }) => {
          await deps.api.saveDynamicSubtasks?.({
            taskId: task._id,
            projectId: project._id,
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
        },
      });

      if (outcome.status === "waiting_approval") return;
      // ask_user pause (plan 013 step 4): the backend already holds the
      // question in `waiting_input`; this invocation just ends. The
      // user's answer re-queues the task for a fresh worker claim.
      if (outcome.status === "waiting_input") return;

      // Plan 005 Step 5.4: the decision step bound is terminal — fail
      // the task explicitly, never mark it done or replan it.
      if (outcome.status === "step_limit") {
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "orchestrator.step_limit",
          payload: { maxDecisionSteps: deps.policy.maxDecisionSteps },
          level: "error",
        });
        await deps.api
          .recordLifecycle?.({
            taskId: task._id,
            projectId: project._id,
            state: "FAILED",
            prevState: "RUNNING",
          })
          ?.catch(() => undefined);
        await deps.api.completeTask({
          taskId: task._id,
          status: "failed",
          errorMessage: "Decision step limit reached",
        });
        return;
      }

      // Cancellation is terminal (Phase 4 hardening): a cancelled or
      // timed-out task ends here — it is never replanned, never
      // finalized, and never marked done.
      if (outcome.status === "cancelled") {
        await finishCancelledTask({
          deps,
          task,
          project,
          signal: taskAbort.controller.signal,
        });
        return;
      }

      // Engine replan (plan 013 step 3): the decision engine requested a
      // re-plan with the objective missing list as feedback. Bounded by
      // the same replans budget as the verification/execution replans;
      // exhaustion fails the task with the missing list, never a
      // silent done. Cancellation still wins (checked above).
      if (outcome.status === "replan") {
        const missing = outcome.replanFeedback ?? "objective not satisfied";
        if (replans < maxPlanningIterations) {
          replans += 1;
          feedback = buildReplanFeedback(
            `Objective not satisfied: ${missing}`,
            sharedContext,
            completedSubtasksFor(plan, state)
          );
          let replanned: Awaited<ReturnType<typeof createAuthoritativePlan>>;
          try {
            replanned = await createAuthoritativePlan({
              taskId: task._id,
              projectId: project._id,
              command,
              title: task.title,
              agents: runAgents,
              classification,
              budget,
              sharedContext,
              policy: deps.policy,
              feedback,
              llmConfig,
              llmResolver,
              onTokenUsage: recordUsage,
              assertBudgetForCall,
              signal: taskAbort.controller.signal,
              llmTaskGate,
              hasQaUrl: Boolean(resolveQaBaseUrl(project)),
            });
          } catch (error) {
            if (isBudgetExhaustedError(error)) {
              await finishBudgetExhaustedTask({
                deps,
                task,
                project,
                budget,
                reason: error.reason,
              });
              return;
            }
            if (taskAbort.controller.signal.aborted) {
              await finishCancelledTask({
                deps,
                task,
                project,
                signal: taskAbort.controller.signal,
              });
              return;
            }
            throw error;
          }
          const previousPlan = plan;
          plan = replanned.plan;
          planVersion += 1;
          await persistPlan(deps, {
            taskId: task._id,
            projectId: project._id,
            plan,
            version: planVersion,
            createdBy: replanned.createdBy,
            classification: classification.kind,
          });
          const carried = carryForwardState(previousPlan, state, plan);
          completedKeys = carried.completedKeys;
          await deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "plan.replanned",
            payload: { replans, feedback: feedback.slice(0, 1000) },
            level: "warn",
          });
          continue;
        }
        const failureMessage = `Objective not satisfied after ${replans} replan(s): ${missing}`;
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "task.error",
          payload: { message: failureMessage.slice(0, 2000) },
          level: "error",
        });
        await deps.api
          .recordLifecycle?.({
            taskId: task._id,
            projectId: project._id,
            state: "FAILED",
            prevState: "RUNNING",
          })
          ?.catch(() => undefined);
        await deps.api.completeTask({
          taskId: task._id,
          status: "failed",
          errorMessage: failureMessage,
        });
        return;
      }

      if (outcome.status === "completed") {
        const after = await deps.api.getContext({ taskId: task._id });
        // Terminal guard (Phase 4 hardening): the cancellation may
        // have landed while the scheduler was finishing its last node
        // (or the task row already turned terminal by another path).
        // A cancelled task must not be finalized into "done" — the
        // backend completeTask guard is the second line of defense;
        // this check keeps finalize from running at all.
        if (
          taskAbort.controller.signal.aborted ||
          isTerminalTaskStatus(after?.task.status)
        ) {
          await finishCancelledTask({
            deps,
            task,
            project,
            signal: taskAbort.controller.signal,
          });
          return;
        }
        const verification = await finalize({
          deps,
          task,
          project,
          // Apply writes to the main workspace (line 2139); verify where
          // the files actually landed. runVerification + evaluateTask both
          // read input.workspacePath, so this single change aligns both.
          workspacePath: resolveWorkspacePath(deps.workspaceRoot, project.workspacePath),
          plan,
          planVersion,
          agents: runAgents,
          subtasks: after?.subtasks ?? [],
          state,
          openIssues: sharedContext.outstandingIssues,
          signal: taskAbort.controller.signal,
        });
        if (verification.verdict === "failed" && replans < maxPlanningIterations) {
          // No replan after cancellation/deadline (Phase 4 hardening).
          if (taskAbort.controller.signal.aborted) {
            await finishCancelledTask({
              deps,
              task,
              project,
              signal: taskAbort.controller.signal,
            });
            return;
          }
          replans += 1;
          feedback = buildReplanFeedback(
            `Verification failed: ${verification.checks
              .filter((check) => check.status === "failed")
              .map((check) => `${check.name}: ${check.details ?? ""}`)
              .join("; ")}`,
            sharedContext,
            completedSubtasksFor(plan, state)
          );
          let replanned: Awaited<ReturnType<typeof createAuthoritativePlan>>;
          try {
            replanned = await createAuthoritativePlan({
              taskId: task._id,
              projectId: project._id,
              command,
              title: task.title,
              agents: runAgents,
              classification,
              budget,
              sharedContext,
              policy: deps.policy,
              feedback,
              llmConfig,
              llmResolver,
              onTokenUsage: recordUsage,
              assertBudgetForCall,
              signal: taskAbort.controller.signal,
              llmTaskGate,
              hasQaUrl: Boolean(resolveQaBaseUrl(project)),
            });
          } catch (error) {
            if (isBudgetExhaustedError(error)) {
              await finishBudgetExhaustedTask({
                deps,
                task,
                project,
                budget,
                reason: error.reason,
              });
              return;
            }
            if (taskAbort.controller.signal.aborted) {
              await finishCancelledTask({
                deps,
                task,
                project,
                signal: taskAbort.controller.signal,
              });
              return;
            }
            throw error;
          }
          const previousPlan = plan;
          plan = replanned.plan;
          planVersion += 1;
          await persistPlan(deps, {
            taskId: task._id,
            projectId: project._id,
            plan,
            version: planVersion,
            createdBy: replanned.createdBy,
            classification: classification.kind,
          });
          // Step 5.3: keep completed work that matches the new plan —
          // the previous code cleared priorOutputs/fileChanges, which
          // forced carried-over subtasks to re-execute.
          const carried = carryForwardState(previousPlan, state, plan);
          completedKeys = carried.completedKeys;
          await deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "plan.replanned",
            payload: { replans, feedback: feedback.slice(0, 1000) },
            level: "warn",
          });
          continue;
        }
        await deps.api
          .recordLifecycle?.({
            taskId: task._id,
            projectId: project._id,
            state: verification.verdict === "failed" ? "FAILED" : "COMPLETED",
            prevState: "RUNNING",
          })
          ?.catch(() => undefined);
        return;
      }

      // Execution failed before any approval. A failure that is really
      // a cancellation (the deadline fired mid-run and the scheduler
      // settled as failed) ends as cancelled instead — and is never
      // replanned (Phase 4 hardening).
      if (taskAbort.controller.signal.aborted) {
        await finishCancelledTask({
          deps,
          task,
          project,
          signal: taskAbort.controller.signal,
        });
        return;
      }
      const failureSummary =
        state.feedback.filter(Boolean).join("; ") ||
        "Execution failed without a detailed error. Check the task events for the failing subtask.";
      // Budget exhausted mid-execution (Phase 5): a budget stop is
      // terminal — it is never replanned (a replan would spend even
      // more calls) and never reported as a generic failure.
      if (summaryHasBudgetFailure(failureSummary)) {
        await finishBudgetExhaustedTask({
          deps,
          task,
          project,
          budget,
          reason: budgetReasonFromSummary(failureSummary),
        });
        return;
      }
      if (replans < maxPlanningIterations) {
        replans += 1;
        feedback = buildReplanFeedback(failureSummary, sharedContext, completedSubtasksFor(plan, state));
        let replanned: Awaited<ReturnType<typeof createAuthoritativePlan>>;
        try {
          replanned = await createAuthoritativePlan({
            taskId: task._id,
            projectId: project._id,
            command,
            title: task.title,
            agents: runAgents,
            classification,
            budget,
            sharedContext,
            policy: deps.policy,
            feedback,
            llmConfig,
            llmResolver,
            onTokenUsage: recordUsage,
            assertBudgetForCall,
            signal: taskAbort.controller.signal,
            llmTaskGate,
            hasQaUrl: Boolean(resolveQaBaseUrl(project)),
          });
        } catch (error) {
          if (isBudgetExhaustedError(error)) {
            await finishBudgetExhaustedTask({
              deps,
              task,
              project,
              budget,
              reason: error.reason,
            });
            return;
          }
          if (taskAbort.controller.signal.aborted) {
            await finishCancelledTask({
              deps,
              task,
              project,
              signal: taskAbort.controller.signal,
            });
            return;
          }
          throw error;
        }
        const previousPlan = plan;
        plan = replanned.plan;
        planVersion += 1;
        await persistPlan(deps, {
          taskId: task._id,
          projectId: project._id,
          plan,
          version: planVersion,
          createdBy: replanned.createdBy,
          classification: classification.kind,
        });
        // Step 5.3: keep completed work that matches the new plan.
        const carried = carryForwardState(previousPlan, state, plan);
        completedKeys = carried.completedKeys;
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "plan.replanned",
          payload: { replans, feedback: failureSummary.slice(0, 1000) },
          level: "warn",
        });
        continue;
      }

      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "task.error",
        payload: { message: failureSummary.slice(0, 2000) },
        level: "error",
      });
      await deps.api
        .recordLifecycle?.({
          taskId: task._id,
          projectId: project._id,
          state: "FAILED",
          prevState: "RUNNING",
        })
        ?.catch(() => undefined);
      await deps.api.completeTask({
        taskId: task._id,
        status: "failed",
        errorMessage: failureSummary,
      });
      return;
    }
  } finally {
    taskAbort.dispose();
  }
}

// Interpretation of one `executePlan` invocation. `replan` carries the
// objective-missing feedback processTask's bounded re-plan consumes,
// and `waiting_input` means the task was paused by the backend
// `pauseForInput` mutation (plan 013 step 4) — the caller simply ends
// the invocation; the answer re-queues the task.
export interface ExecutePlanResult {
  status: "completed" | "failed" | "waiting_approval" | "cancelled" | "step_limit" | "replan" | "waiting_input";
  replanFeedback?: string;
}

async function executePlan(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  workspacePath: string;
  agents: AgentDefinition[];
  plan: ExecutionPlan;
  state: RunState;
  feedback?: string;
  approvalResolved?: boolean;
  approvalMode: "ask" | "auto";
  completedKeys: Set<string>;
  /**
   * Per-task abort controller (Phase 4): armed by the caller
   * (processTask / resumeTask) with the policy.taskTimeoutMs deadline;
   * the cancel polling below fires it when the task row turns terminal,
   * and its signal is combined into every subtask execution.
   */
  taskAbort?: AbortController;
  /** Orchestrator wiring: budget + shared context + classification (both processTask and resumeTask pass them since Phase 4). */
  budget?: BudgetTracker;
  /**
   * Pre-call budget gate closure (Phase 5): forwarded into every
   * subtask execution; enforce mode throws BudgetExhaustedError before
   * the call, warn mode emits the runner's budget.warning event.
   */
  assertBudgetForCall?: () => void;
  sharedContext?: SharedTaskContext;
  classification?: Classification;
  llmConfig?: GlobalLLMConfig;
  /** Per-agent LLM resolver (Phase 2); executors resolve their own agent's chain from it. */
  llmResolver?: TaskLlmResolver;
  /** Per-task QA base URL (project qaUrl > devUrl > env fallback), threaded to the QA executor. */
  qaBaseUrl?: string;
  /** The plan version the executed plan was persisted under; dynamic-subtask checkpoints are written against it. */
  planVersion?: number;
  /** Per-task LLM gate (Phase 4 hardening), threaded into every subtask LLM call. */
  llmTaskGate?: LlmConcurrencyGate;
  /** Plan 009: MCP tool provider for this run; absent means "no MCP tools". */
  mcp?: {
    sessions: McpSession[];
    writeTools: boolean;
    maxIterations: number;
  };
  worktree?: { branchName: string; worktreePath: string };
  /**
   * Usage sink for plan-level LLM calls (the decision advisor). Threaded
   * from the caller's recorder so advisor spend is metered in the same
   * BudgetTracker and tokenUsage table as subtask calls.
   */
  onTokenUsage?: (
    inputTokens: number,
    outputTokens: number,
    model: string,
    agentName: string,
    agentId?: string,
    meta?: TokenUsageMeta
  ) => Promise<void>;
  /**
   * Persist dynamically spawned subtasks (Phase 4 hardening): called
   * the moment a delegation/fix/review-fix subtask is added to the
   * plan, with the full updated plan, so a worker restart recovers the
   * whole DAG instead of only the initial plan.
   */
  onDynamicSubtasks?: (request: {
    added: PlanSubtask[];
    origin: "delegation" | "fix" | "review_fix";
    plan: ExecutionPlan;
    version: number;
  }) => Promise<void>;
}): Promise<ExecutePlanResult> {
  const { deps, task, project, plan, state } = input;
  const browser = new WebClient({
    headless: true,
    ...stagehandConfigFrom(input.llmConfig),
  });

  try {
  const implementationNodes = plan.subtasks.filter(
    (subtask) => subtask.kind !== "qa" && subtask.kind !== "review"
  );
  const reviewNodes = plan.subtasks.filter((subtask) => subtask.kind === "review");
  const qaNodes = plan.subtasks.filter((subtask) => subtask.kind === "qa");
  // Capabilities the STORED plan already schedules (computed before any
  // dynamic node is added). Delegation heuristics consult this so they never
  // spawn a duplicate of work the plan will run anyway.
  const plannedCapabilities = plan.subtasks.map((subtask) => subtask.capability);
  if (implementationNodes.length === 0 && reviewNodes.length === 0 && qaNodes.length === 0) {
    return { status: "failed" };
  }

  const executionIds = new Map<string, WorkerExecutionId>();
  // Last posted chat text per agent+subtask (for duplicate suppression).
  const lastPostedMessage = new Map<string, string>();
  const agentByKey = new Map<string, AgentDefinition>();
  const taskId = task._id;

  /**
   * Durable dynamic DAG (Phase 4 hardening): persist a freshly spawned
   * subtask (and the plan payload containing it) at the moment it is
   * added, so recovery after a worker restart sees the whole DAG.
   * Fail-closed: if persistence fails we log then re-throw, so the
   * scheduler never runs a node that isn't in the durable DAG.
   */
  const persistDynamic = async (
    added: PlanSubtask[],
    origin: "delegation" | "fix" | "review_fix"
  ): Promise<void> => {
    if (!input.onDynamicSubtasks || added.length === 0) return;
    try {
      await input.onDynamicSubtasks({
        added,
        origin,
        plan,
        version: input.planVersion ?? plan.version,
      });
    } catch (error) {
      await deps.api
        .logEvent({
          taskId,
          projectId: project._id,
          type: "plan.dynamic_persist_failed",
          payload: {
            keys: added.map((subtask) => subtask.key),
            origin,
            message: error instanceof Error ? error.message : String(error),
          },
          level: "error",
        })
        .catch(() => undefined);
      throw error;
    }
  };

  // --- Phase 3 orchestrator bookkeeping ---------------------------------
  // Authoritative mode is active only when the policy flag is on AND the
  // orchestrator wiring (budget/context/classification) is present.
  // Since Phase 4 both processTask and resumeTask pass the wiring (the
  // resume path builds its state from the DB via buildStateFromDb), so
  // authoritative evaluation applies on resumed runs too.
  const authoritative =
    deps.policy.orchestratorAuthoritative === true &&
    Boolean(input.budget && input.sharedContext && input.classification);
  // (Plan 006 Phase 2: the decision engine is the only orchestrator
  // path — the advisory legacy branch and its flag were deleted in
  // plan 013 step 7; the suite is green forced-on.)
  let decisionStep = 0;
  /** Plan 005 Step 5.4: latched when the decision step bound is hit. */
  let stepLimitHit = false;
  // Per-branch capability chain per subtask key (root first, ending with
  // the subtask's own capability). Delegation depth and circularity are
  // derived from this chain — never from a task-global counter.
  const chainByKey = new Map<string, string[]>();
  // How many orchestrator fix rounds a subtask already sits in (0 = plan
  // or delegation subtask, 1 = fix subtask). Fix subtasks do not spawn
  // further fixes from evaluations; the review loop owns its iterations.
  const fixDepthByKey = new Map<string, number>();
  // Completion state for THIS run. The persisted set only describes what a
  // previous process finished; a node that completes mid-run must land here
  // immediately or objective evaluation keeps reporting it as pending and
  // the decision engine spawns recovery work for finished nodes.
  const runCompleted = new Set<string>(input.completedKeys);
  // Nodes added after planning (delegation / fix / recovery). They are
  // execution details, never objective requirements.
  const dynamicKeys = new Set<string>();
  // Live per-agent execution counts, fed to the delegation gate so an
  // agent already at its concurrency limit is not delegated more work,
  // and to the scheduler's per-agent start gate (Phase 4), which defers
  // a node whose agent is at AgentDefinition.maxConcurrency.
  const activeByAgent = new Map<string, number>();
  // Latched when an evaluation returns BLOCKED (budget), unless the
  // policy is in warn mode: the scheduler stops starting new nodes and
  // blocks the pending ones gracefully. Warn mode (the Phase 5
  // default from loadPolicy) is the explicit opt-out for this release
  // cycle: a BLOCKED evaluation is advisory only — it never halts
  // scheduling; the budget.warning event from the pre-call gate is the
  // visible signal and the run continues to completion. Policies that
  // predate budgetMode (field unset) keep the historical halt.
  const budgetEnforced = deps.policy.budgetMode !== "warn";
  let budgetHalt = false;
  // Latched when a decision-terminal outcome (complete or replan) ends
  // scheduling for this invocation (plan 013 step 3). Unlike `budgetHalt`
  // it carries no budget semantics: the scheduled drain finishes, then
  // executePlan returns "completed" (complete) or "replan".
  let decisionTerminal = false;
  // The objective missing list carried by the first `replan` outcome of
  // this invocation; processTask turns it into bounded re-plan feedback.
  let replanFeedback: string | null = null;
  // True while a review/QA staged loop owns the remaining work: its open
  // findings are EXPECTED and the objective is not judgeable until the
  // loop returns a final verdict (plan 013 step 5). The loop spans its
  // own fix runs too, so a fix's settle never judges the objective
  // mid-fix.
  let inStageLoop = false;
  // The question this invocation paused for (plan 013 step 4). Set only
  // when the backend pause was applied; the re-queued run continues with
  // the user's answer threaded into the shared context.
  let waitingForInput: string | null = null;
  for (const subtask of plan.subtasks) {
    chainByKey.set(subtask.key, [subtask.capability]);
    fixDepthByKey.set(subtask.key, 0);
  }
  const nextOrder = (): number =>
    plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1;
  const uniqueSubtaskKey = (base: string): string => {
    let key = base;
    let suffix = 2;
    while (plan.subtasks.some((candidate) => candidate.key === key)) {
      key = `${base}_${suffix}`;
      suffix += 1;
    }
    return key;
  };

  const assign = (key: string): AgentDefinition | null => {
    const existing = agentByKey.get(key);
    if (existing) return existing;
    const subtask = plan.subtasks.find((candidate) => candidate.key === key);
    if (!subtask) return null;
    // QA must never fall back to an unrelated engineering agent. A fallback
    // would misattribute the verdict and can run browser checks as Backend.
    // Review is routed by capability (code-review → the Reviewer). The CTO
    // oversees but does not review; it is used only as a last resort when
    // the team has no code-review agent at all.
    let agent = routeCapability(subtask.capability, input.agents, {
      allowFallback:
        subtask.kind !== "qa" &&
        subtask.kind !== "review" &&
        subtask.capability !== CAPABILITY.BROWSER_TESTING,
    });
    if (!agent && subtask.kind === "review") {
      agent =
        input.agents.find((candidate) => /^cto$/i.test(candidate.role)) ??
        // Teams with neither a reviewer nor a CTO keep the historical
        // capability fallback rather than leaving the review unassigned.
        routeCapability(subtask.capability, input.agents, { allowFallback: true });
    }
    if (agent) agentByKey.set(key, agent);
    return agent;
  };

  let lastStatusCheck = 0;
  let cancelled = false;
  /** True once this run is cancelled — by the status poll or by the deadline signal. */
  const taskCancelled = (): boolean =>
    cancelled || input.taskAbort?.signal.aborted === true;
  // Decision-terminal exits at stage boundaries, never mid-node:
  // `waiting_input` (plan 013 step 4) wins over `replan` (step 3) — a
  // question the user can still answer is worth more than re-planning
  // the same gap. Cancellation always wins over replan.
  const terminalExit = (): ExecutePlanResult | null => {
    if (waitingForInput !== null) return { status: "waiting_input" };
    if (replanFeedback !== null && !taskCancelled()) {
      return { status: "replan", replanFeedback };
    }
    return null;
  };

  // Extracted (plan 012 step 2) into services/runner/runNodes.ts; the
  // adapter keeps the stage-driver call sites unchanged.
  const runNodes = (nodes: PlanSubtask[]): Promise<SchedulerResult> =>
    runNodesImpl(ctx, nodes);

  const reviewNodeKeys = reviewNodes.map((node) => node.key);

  /**
   * Plan 005 Step 5.2: the ONE place staged file changes reach the
   * workspace. Shared by the main apply phase and the QA-fix loop so a QA
   * correction actually lands before QA re-runs against the running app.
   * A stop result maps to the caller's terminal outcome — a cancellation
   * or an apply failure is never retried or replanned here.
   */
  const applyStaged = async (
    changes: FileDiff[],
    actor: "user" | "orchestrator"
  ): Promise<{ applied: string[] } | { stop: "cancelled" | "failed" }> => {
    if (changes.length === 0) return { applied: [] };
    const wp = input.workspacePath;
    const appliedPaths: string[] = [];
    for (const change of changes) {
      // A cancel/deadline that landed while the scheduler was running
      // stops the apply phase too: no further files are written.
      if (input.taskAbort?.signal.aborted) {
        state.feedback.push("Apply aborted: the task was cancelled or timed out");
        return { stop: "cancelled" };
      }
      try {
        await applyFileChange(wp, change);
        const verified = await fs.readFile(path.join(wp, change.filePath), "utf-8");
        if (hashContent(verified) !== hashContent(change.newContent ?? "")) {
          throw new Error(`${change.filePath}: content mismatch after apply`);
        }
        appliedPaths.push(change.filePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "fileChanges.apply_failed",
          payload: { message },
          level: "error",
        });
        state.feedback.push(`Apply failed: ${message}`);
        return { stop: "failed" };
      }
    }
    if (appliedPaths.length > 0) {
      await deps.api.markFilesApplied({
        taskId,
        filePaths: appliedPaths,
        workerId: deps.workerId,
      });
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "fileChanges.applied",
        payload: { filePaths: appliedPaths },
      });
      await deps.api.recordAudit({
        taskId,
        projectId: project._id,
        workerId: deps.workerId,
        actor,
        tool: "apply_changes",
        action: "apply",
        decision: "allowed",
        target: appliedPaths.join(","),
        details: { filePaths: appliedPaths, planVersion: plan.version },
      });
    }
    return { applied: appliedPaths };
  };

  // RunContext (plan 012 step 3): built once per executePlan so the
  // extracted handleNodeOutcome shares the run's state. Reference-type
  // containers are shared by reference; scalar latches live in the
  // closure `let`s below and stay synced onto ctx via accessors, so
  // executePlan's stage driver (which reads the closure locals) and the
  // extracted outcome handler (which reads/writes ctx.*) always observe
  // the same latch values.
  const ctx: RunContext = {
    input,
    deps,
    task,
    project,
    plan,
    state,
    agents: input.agents,
    browser,
    taskId,
    implementationNodes,
    reviewNodes,
    qaNodes,
    reviewNodeKeys,
    plannedCapabilities,
    budgetEnforced,
    authoritative,
    decisionEngine: true,
    decisionStep: 0,
    stepLimitHit: false,
    budgetHalt: false,
    cancelled: false,
    decisionTerminal: false,
    replanFeedback: null,
    waitingForInput: null,
    pendingApproval: false,
    delegationSeq: 0,
    fixSeq: 0,
    lastStatusCheck: 0,
    inStageLoop: false,
    runCompleted,
    dynamicKeys,
    chainByKey,
    fixDepthByKey,
    activeByAgent,
    executionIds,
    lastPostedMessage,
    agentByKey,
    assign,
    nextOrder,
    uniqueSubtaskKey,
    persistDynamic,
    taskCancelled,
    applyStaged,
    runNodes,
  };
  // Scalars stay synced onto ctx via accessors over the closure `let`s,
  // so the stage driver and the extracted outcome handler observe one
  // latch state.
  const syncScalar = <K extends keyof RunContext>(
    key: K,
    get: () => RunContext[K],
    set: (value: RunContext[K]) => void
  ) => {
    Object.defineProperty(ctx, key, {
      get,
      set,
      enumerable: true,
      configurable: true,
    });
  };
  syncScalar("decisionStep", () => decisionStep, (value: number) => { decisionStep = value; });
  syncScalar("stepLimitHit", () => stepLimitHit, (value: boolean) => { stepLimitHit = value; });
  syncScalar("budgetHalt", () => budgetHalt, (value: boolean) => { budgetHalt = value; });
  syncScalar("cancelled", () => cancelled, (value: boolean) => { cancelled = value; });
  syncScalar("decisionTerminal", () => decisionTerminal, (value: boolean) => { decisionTerminal = value; });
  syncScalar("replanFeedback", () => replanFeedback, (value: string | null) => { replanFeedback = value; });
  syncScalar("waitingForInput", () => waitingForInput, (value: string | null) => { waitingForInput = value; });
  syncScalar("lastStatusCheck", () => lastStatusCheck, (value: number) => { lastStatusCheck = value; });
  syncScalar("inStageLoop", () => inStageLoop, (value: boolean) => { inStageLoop = value; });

  const runReviewLoop = (): Promise<boolean> => runReviewLoopImpl(ctx);

  /**
   * Plan 005 Step 5.2: targeted QA correction. A failing QA verdict spawns
   * a fix subtask carrying the QA failure as findings (the checks, when
   * present), and the same QA nodes re-run. Bounded by maxReviewIterations
   * like the review loop. Returns false when QA still fails (or the fix
   * itself failed) — the caller turns that into "failed" so the task is
   * never silently marked done.
   */
  const runQaLoop = (): Promise<boolean> => runQaLoopImpl(ctx);

  const implementation = await runNodes(implementationNodes);
  // Plan 005 Step 5.4: the decision step bound is terminal — fail the
  // task explicitly upstream, never mark it done or replan it.
  if (stepLimitHit) {
    return { status: "step_limit" };
  }
  if (implementation.status === "cancelled") {
    await deps.api
      .updateSubtask({
        taskId,
        key: implementationNodes[0]?.key ?? reviewNodes[0]?.key ?? qaNodes[0]?.key ?? "unknown",
        status: "blocked",
      })
      .catch(() => undefined);
    // Cancellation is its own outcome (Phase 4 hardening): the caller
    // ends the task as cancelled instead of treating it as a failure
    // it could replan away.
    return { status: "cancelled" };
  }
  if (implementation.status !== "completed") {
    if (implementation.outcomes) {
      for (const [key, o] of implementation.outcomes) {
        if (o.status === "failed") state.feedback.push(`${key}: ${o.error ?? "failed without detail"}`);
      }
    }
    return { status: taskCancelled() ? "cancelled" : "failed" };
  }
  // Engine replan at the stage boundary (plan 013 step 3): abandon the
  // rest of this plan; processTask re-plans (bounded) and re-runs the
  // scheduler. Cancellation already won above.
  {
    const exit = terminalExit();
    if (exit) return exit;
  }

  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  if (hasCodeChange && state.fileChanges.size === 0) {
    state.feedback.push("The implementation produced no file changes");
    return { status: "failed" };
  }

  const reviewApproved = await runReviewLoop();
  if (!reviewApproved) {
    return { status: taskCancelled() ? "cancelled" : "failed" };
  }
  // Same boundary after the review stage (plan 013 step 3).
  {
    const exit = terminalExit();
    if (exit) return exit;
  }

  const preparedChanges = Array.from(state.fileChanges.values());
  const reviewSnapshotId = snapshotIdForChanges(preparedChanges);
  const approvedVerdicts = Object.values(state.reviewVerdicts).filter(
    (verdict) => verdict.verdict === "approved" && verdict.snapshotId
  );
  if (
    preparedChanges.length > 0 &&
    approvedVerdicts.length > 0 &&
    approvedVerdicts.some((verdict) => verdict.snapshotId !== reviewSnapshotId)
  ) {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "review.snapshot_mismatch",
      payload: {
        expected: approvedVerdicts.map((verdict) => verdict.snapshotId),
        actual: reviewSnapshotId,
      },
      level: "error",
    });
    state.feedback.push(
      "Changes changed after review approval; re-review required before apply"
    );
    return { status: taskCancelled() ? "cancelled" : "failed" };
  }

  let dryRunSummary:
    | { filePaths: string[]; count: number; changes: string[] }
    | undefined;
  if (preparedChanges.length > 0) {
    const dryRun = await dryRunPolicy(
      preparedChanges,
      deps,
      task,
      project,
      plan,
      plan.version,
      state
    );
    if (!dryRun.allowed) {
      return { status: taskCancelled() ? "cancelled" : "failed" };
    }
    dryRunSummary = dryRun.summary;
  }

  const shouldAsk =
    input.approvalMode === "ask" &&
    plan.requiresApproval &&
    !input.approvalResolved &&
    preparedChanges.length > 0;

  /**
   * Request the user's approval for the prepared changes and pause the
   * task (`needs_approval`, lease released by the backend). Shared by the
   * plan-level `requiresApproval` gate AND the permission broker's "ask"
   * decision: an "ask" without an approval row would leave the task
   * `running` forever with nothing for the user to click (core H2).
   */
  const requestApplyApproval = async (reason: "plan" | "broker"): Promise<ExecutePlanResult> => {
    const implementer = implementerAgent(plan, input.agents);
    const summary = `Apply changes to ${preparedChanges.length} file(s): ${preparedChanges
      .map((change) => change.filePath)
      .join(", ")}`;
    // Metrics reflect what actually ran: verification and QA run AFTER the
    // apply, so before approval they are "not run" unless a previous
    // invocation recorded a real result.
    const verificationMetric = state.verification
      ? state.verification.status
      : "not run";
    await deps.api.requestApproval({
      taskId,
      projectId: project._id,
      subtaskKey: plan.subtasks.find((subtask) => subtask.kind === "code_change")?.key,
      kind: "apply_changes",
      summary,
      payload: {
        filePaths: preparedChanges.map((change) => change.filePath),
        planVersion: plan.version,
        reviewSnapshotId: approvedVerdicts.length > 0 ? reviewSnapshotId : undefined,
        policyDryRun: dryRunSummary,
        metrics: {
          files: preparedChanges.length,
          review: approvedVerdicts.length > 0 ? "approved" : reviewNodes.length > 0 ? "not approved" : "not run",
          build: verificationMetric,
          tests: verificationMetric,
          qa:
            qaNodes.length > 0
              ? (plan.visualQa ?? wantsVisualQa(input.task.command))
                ? "Visual QA planned (runs after apply)"
                : "Structural QA planned (runs after apply)"
              : "not requested",
        },
      },
      requestedByAgentId: implementer?._id as any,
      planVersion: plan.version,
    });
    await deps.api.appendAgentMessage({
      projectId: project._id,
      taskId,
      agentId: implementer?._id as any,
      content: `Changes are prepared${
        approvedVerdicts.length > 0 ? " and review-approved" : ""
      } (${preparedChanges.length} file(s)). Verification${
        qaNodes.length > 0 ? " and QA run" : " runs"
      } after they are applied. Please approve the diff.`,
    });
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "waiting_approval", files: preparedChanges.length, reason },
      level: "warn",
    });
    await deps.api.recordAudit({
      taskId,
      projectId: project._id,
      workerId: deps.workerId,
      actor: implementer?.name ?? "orchestrator",
      tool: "apply_changes",
      action: "request",
      decision: "pending",
      target: preparedChanges.map((change) => change.filePath).join(","),
      details: { dryRun: dryRunSummary, reason },
    });
    return { status: "waiting_approval" };
  };

  if (shouldAsk) {
    return await requestApplyApproval("plan");
  }

  if (preparedChanges.length > 0) {
    // Plan 015: broker pre-check before applying. Deny → stop with an
    // audit event; Ask (auto-mode project or no live row needed) →
    // request approval wait; Allow → apply.
    const firstApplied = preparedChanges[0];
    // The broker resolves every target against the workspace root (core
    // H4): send ALL prepared files (absolute, resolved by the same
    // resolver the apply phase uses), the plan version for approval
    // matching, and the worker's resolved root for relative project paths.
    const resolvedRoot = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
    const targetPaths = preparedChanges.map((change) => path.join(resolvedRoot, change.filePath));
    const broker = await deps.api.checkPermission({
      taskId,
      projectId: project._id,
      kind: "apply_changes",
      targetPath: targetPaths[0] ?? resolvedRoot,
      targetPaths,
      planVersion: input.planVersion ?? plan.version,
      workspaceRoot: resolvedRoot,
    });
    if (broker.decision === "deny") {
      await deps.api.recordAudit({
        taskId,
        projectId: project._id,
        workerId: deps.workerId,
        actor: "permission-broker",
        tool: "apply_changes",
        action: "deny",
        decision: "denied",
        target: firstApplied?.filePath ?? project.workspacePath ?? ".",
        details: { reason: broker.reason },
      });
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "permission.denied",
        payload: { action: "apply_changes", reason: broker.reason },
        level: "error",
      });
      return { status: "failed" };
    }
    if (broker.decision === "ask" && input.approvalMode !== "auto") {
      // Never return waiting_approval without an approval row (core H2):
      // the task would stay `running`, its lease renewed by heartbeat,
      // with nothing for the user to approve.
      return await requestApplyApproval("broker");
    }
    const applied = await applyStaged(
      preparedChanges,
      input.approvalResolved ? "user" : "orchestrator"
    );
    if ("stop" in applied) {
      return { status: applied.stop };
    }
    if (input.approvalResolved && applied.applied.length > 0) {
      await deps.api.appendAgentMessage({
        projectId: project._id,
        taskId,
        agentId: implementerAgent(plan, input.agents)?._id as any,
        content: `Approved changes applied to ${applied.applied.length} file(s). Running verification.`,
      });
    }
  }

  // A decision-engine "complete" latched during the implementation pass
  // only ends THAT drain. The post-apply stage loops (verification / QA
  // fixes) must still be able to schedule their own nodes; a replan or
  // waiting_input already returned through terminalExit above.
  if (decisionTerminal && replanFeedback === null && waitingForInput === null) {
    decisionTerminal = false;
  }

  // Stage order after apply (core H1 / QA P0-1): verification (cheap,
  // deterministic) → QA (only when the plan has QA nodes) → worktree
  // commit/merge → final decision boundary. None of these is gated on QA.
  if (preparedChanges.length > 0) {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "verifying", files: preparedChanges.length },
    });
    // Verify loop (plan 012 step 2): extracted to services/runner/verifyLoop.ts.
    const stop = await runVerificationLoop(ctx);
    if (stop === "waiting_approval") return { status: "waiting_approval" };
    if (stop) {
      return { status: taskCancelled() ? "cancelled" : stop };
    }
    if (stepLimitHit) {
      return { status: "step_limit" };
    }
    {
      const exit = terminalExit();
      if (exit) return exit;
    }
  }

  if (qaNodes.length > 0) {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "qa", files: preparedChanges.length },
    });
    // Plan 005 Step 5.2: QA failures spawn targeted fix subtasks and the
    // same QA nodes re-run; a still-failing QA after the last fix attempt
    // fails the task instead of being silently marked done.
    const qaApproved = await runQaLoop();
    if (ctx.pendingApproval) {
      return { status: "waiting_approval" };
    }
    if (!qaApproved) {
      return { status: taskCancelled() ? "cancelled" : "failed" };
    }
    if (stepLimitHit) {
      return { status: "step_limit" };
    }
    // Same boundary after the QA stage (plan 013 step 3).
    {
      const exit = terminalExit();
      if (exit) return exit;
    }
  }

  if (input.worktree && preparedChanges.length > 0) {
    try {
      const committed = await commitWorktree(
        input.worktree.worktreePath,
        `MOAgent: ${task.title}`,
        Array.from(state.fileChanges.keys())
      );
      // Plan 019: the push card. Recorded before the local merge (which
      // removes the task branch); the commit stays reachable by sha, which
      // is what the push request pushes. Best-effort: the card never
      // decides whether the task completes.
      if (committed) {
        try {
          const summary = await describeCommit(input.worktree.worktreePath, project.mainBranch ?? "main");
          await deps.api.recordTaskCommit({
            taskId,
            projectId: project._id,
            agentId: implementerAgent(plan, input.agents)?._id,
            branchName: input.worktree.branchName,
            commitSha: summary.sha,
            commitMessage: summary.message,
            filesChanged: summary.filesChanged,
            additions: summary.additions,
            deletions: summary.deletions,
            ahead: summary.ahead,
            behind: summary.behind,
            comparedTo: summary.comparedTo,
          });
        } catch (error) {
          await deps.api
            .logEvent({
              taskId,
              projectId: project._id,
              type: "card.post_failed",
              payload: { kind: "push", message: error instanceof Error ? error.message : String(error) },
              level: "warn",
            })
            .catch(() => undefined);
        }
      }
      await deps.api.mergeBranch({ taskId });
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "branch.merged",
        payload: { branchName: input.worktree.branchName },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "branch.merge_failed",
        payload: { branchName: input.worktree.branchName, message },
        level: "error",
      });
      state.feedback.push(`Worktree merge failed: ${message}`);
      return { status: taskCancelled() ? "cancelled" : "failed" };
    }
  }
  // Final boundary before completing (plan 013 step 3): a replan
  // requested anywhere earlier in this invocation still wins over
  // "completed".
  {
    const exit = terminalExit();
    if (exit) return exit;
  }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { status: "completed" };
}

export async function resumeTask(taskId: string, deps: RunnerDeps): Promise<void> {
  const context = await deps.api.getContext({ taskId });
  if (!context?.project || context.task.status !== "needs_approval") return;
  const approvals = await deps.api.getApprovals({ taskId });
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length > 0) return;

  const applyApprovals = approvals.filter((approval) => approval.kind === "apply_changes");
  if (applyApprovals.length === 0) return;

  if (applyApprovals.some((approval) => approval.status === "rejected")) {
    await deps.api.appendAgentMessage({
      projectId: context.project._id,
      taskId,
      content: "Changes were rejected by the user and were not applied to the workspace.",
    });
    await deps.api.recordAudit({
      taskId,
      projectId: context.project._id,
      workerId: deps.workerId,
      actor: "user",
      tool: "apply_changes",
      action: "reject",
      decision: "denied",
    });
    await deps.api.completeTask({
      taskId,
      status: "rejected",
      errorMessage: "Changes rejected by user",
    });
    return;
  }
  if (!applyApprovals.some((approval) => approval.status === "approved")) return;

  const planValidation = context.plan
    ? validatePlan(context.plan.payload, deps.policy.maxSubtasks)
    : null;
  if (!planValidation?.ok || !planValidation.plan) {
    await deps.api.completeTask({
      taskId,
      status: "failed",
      errorMessage: "Stored plan is missing or invalid",
    });
    return;
  }
  const plan = planValidation.plan;
  const planVersion = context.plan?.version ?? context.task.planVersion ?? 1;
  // The approval was resolved, so the task is no longer waiting on the user.
  // Leaving it at `needs_approval` made the UI advertise an approval button
  // that no longer exists while the resumed run is in flight.
  await deps.api.setTaskStatus({ taskId, status: "running" });
  // Phase 4 hardening: the resumed run gets its OWN per-task LLM gate
  // and its deadline is armed before execution setup begins (the
  // timer is disposed on every exit path below — the resolver-failure
  // return disposes explicitly; everything else flows through the
  // try/finally around executePlan).
  const llmTaskGate = new LlmConcurrencyGate(deps.policy.maxConcurrentLLMCalls);
  const taskAbort = armTaskAbort(deps.policy, deps.shutdownSignal);
  const persistedWorktree = context.task.worktreePath
    ? resolveWorkspacePath(deps.workspaceRoot, context.task.worktreePath)
    : undefined;
  const workspacePath = persistedWorktree ?? resolveWorkspacePath(deps.workspaceRoot, context.project.workspacePath);
  await fs.mkdir(workspacePath, { recursive: true });

  // Plan 009: seed the shared MCP registry (see processTask).
  const mcp = mcpForTask(context.mcpServers, workspacePath, deps.policy, (serverId, status, errorMessage) =>
    deps.api
      .updateMcpServerStatus({
        serverId: serverId as Parameters<WorkerApi["updateMcpServerStatus"]>[0]["serverId"],
        status,
        errorMessage,
      })
      .catch(() => undefined)
  );

  const changes = await deps.api.getFileChanges({ taskId });

  // Resumed tasks resolve LLMs exactly like fresh ones (Phase 2 resolver).
  let llmResolver: TaskLlmResolver;
  let llmConfig: GlobalLLMConfig;
  try {
    llmResolver = await buildTaskLlmResolver(context.llmProviders);
    llmConfig = llmResolver.defaultConfig();
  } catch (error) {
    taskAbort.dispose();
    await deps.api.completeTask({
      taskId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const agents = context.agents.map(toAgentDefinition);
  // Phase 4: resume builds its execution state through the SAME builder
  // as processTask's recovery path, and carries the same orchestrator
  // wiring (budget + shared context + classification) — previously the
  // resume path ran with none of them, so authoritative evaluation,
  // budget accounting and retry bounds silently did not apply after an
  // approval.
  const { state, completedKeys } = buildStateFromDb({
    subtasks: context.subtasks,
    executions: context.executions,
    fileChanges: changes,
  });
  // Resumed runs must not redo finished nodes. Log what the DB reported so a
  // regression (completed rows read as pending) is visible in task events.
  await deps.api.logEvent({
    taskId,
    projectId: context.project._id,
    type: "task.stage",
    payload: {
      stage: "resuming",
      completed: [...completedKeys],
      subtasks: context.subtasks.map(
        (subtask: { key: string; status: string }) => `${subtask.key}:${subtask.status}`
      ),
    },
    level: "info",
  });
  const command = await withFileContexts(
    deps.workspaceRoot,
    context.project.workspacePath,
    context.task.command
  );
  const classification = classifyCommand(command);
  const budget = new BudgetTracker(deps.policy);
  // Phase 5: resume seeds the FULL persisted budget state (usage totals
  // + snapshot extras) with visible failure — replacing the old silent
  // best-effort catch that reset every non-usage limit on resume.
  await seedBudgetFromPersisted({
    deps,
    taskId,
    projectId: context.project._id,
    budget,
  });
  // Pre-call budget gate closure (Phase 5), same contract as processTask.
  const assertBudgetForCall = () =>
    budget.assertLlmCallAllowed((reason) => {
      void deps.api
        .logEvent({
          taskId,
          projectId: context.project._id,
          type: "budget.warning",
          payload: { reason, budget: budget.snapshot() },
          level: "warn",
        })
        .catch(() => undefined);
    });
  // Usage sink for the resumed run: same BudgetTracker + persisted
  // tokenUsage table contract as processTask's recordUsage.
  const recordUsage = async (
    inputTokens: number,
    outputTokens: number,
    model: string,
    agentName: string,
    agentId?: string,
    meta?: TokenUsageMeta
  ) => {
    budget.recordLLMCall({ inputTokens, outputTokens, model, agentName, agentId });
    if (inputTokens > 0 || outputTokens > 0) {
      await deps.api.recordTokenUsage({
        projectId: context.project._id,
        taskId,
        agentId: agentId as WorkerAgent["_id"] | undefined,
        agentName,
        model,
        inputTokens,
        outputTokens,
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
  const sharedContext = createSharedTaskContext({
    taskId,
    projectId: context.project._id,
    originalRequest: command,
    title: context.task.title,
    classification,
  });
  // Plan 013 step 4: same threading on the approval-resume path.
  await threadUserAnswers(deps, taskId, sharedContext);

  try {
    const outcome = await executePlan({
      deps,
      task: context.task,
      project: context.project,
      workspacePath,
      agents,
      plan,
      planVersion,
      state,
      approvalResolved: true,
      approvalMode: context.approvalMode,
      completedKeys,
      taskAbort: taskAbort.controller,
      budget,
      assertBudgetForCall,
      sharedContext,
      classification,
      llmConfig,
      llmResolver,
      llmTaskGate,
      onTokenUsage: recordUsage,
      qaBaseUrl: resolveQaBaseUrl(context.project),
      mcp,
      worktree:
        context.task.branchName && persistedWorktree
          ? { branchName: context.task.branchName, worktreePath: persistedWorktree }
          : undefined,
      onDynamicSubtasks: async ({ added, origin, plan: currentPlan, version }) => {
        await deps.api.saveDynamicSubtasks?.({
          taskId,
          projectId: context.project._id,
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
      },
    });

    // EVERY executePlan outcome is handled explicitly (Phase 4
    // hardening). The pre-hardening resume path ran finalize
    // unconditionally, so a failed — or even cancelled — resumed
    // execution could be finalized into "done".
    switch (outcome.status) {
      case "waiting_approval":
        return;
      case "waiting_input":
        // Paused for a user answer (plan 013 step 4): the backend holds
        // the question; this invocation just ends.
        return;
      case "cancelled":
        await finishCancelledTask({
          deps,
          task: context.task,
          project: context.project,
          signal: taskAbort.controller.signal,
        });
        return;
      case "step_limit": {
        // Plan 005 Step 5.4 mirrored from processTask: the decision
        // step bound is terminal, never a silent done.
        await deps.api.logEvent({
          taskId,
          projectId: context.project._id,
          type: "orchestrator.step_limit",
          payload: { maxDecisionSteps: deps.policy.maxDecisionSteps },
          level: "error",
        });
        await deps.api
          .recordLifecycle?.({
            taskId,
            projectId: context.project._id,
            state: "FAILED",
            prevState: "RUNNING",
          })
          ?.catch(() => undefined);
        await deps.api.completeTask({
          taskId,
          status: "failed",
          errorMessage: "Decision step limit reached",
        });
        return;
      }
      case "replan": {
        // The engine asked for a re-plan with the objective missing
        // list (plan 013 step 3). resumeTask has no re-plan loop — the
        // replans budget is processTask's — so the resumed run ends
        // failed with the missing list instead of a silent done.
        const missing = outcome.replanFeedback ?? "objective not satisfied";
        const failureMessage = `Objective not satisfied after resume: ${missing}`;
        await deps.api.logEvent({
          taskId,
          projectId: context.project._id,
          type: "task.error",
          payload: { message: failureMessage.slice(0, 2000) },
          level: "error",
        });
        await deps.api
          .recordLifecycle?.({
            taskId,
            projectId: context.project._id,
            state: "FAILED",
            prevState: "RUNNING",
          })
          ?.catch(() => undefined);
        await deps.api.completeTask({
          taskId,
          status: "failed",
          errorMessage: failureMessage,
        });
        return;
      }
      case "failed": {
        const failureSummary =
          state.feedback.join("; ") || "Execution failed after approval";
        // Budget exhausted during the resumed execution (Phase 5):
        // ends with the explicit budget.exhausted status, not a
        // generic post-approval failure.
        if (summaryHasBudgetFailure(failureSummary)) {
          await finishBudgetExhaustedTask({
            deps,
            task: context.task,
            project: context.project,
            budget,
            reason: budgetReasonFromSummary(failureSummary),
          });
          return;
        }
        await deps.api.logEvent({
          taskId,
          projectId: context.project._id,
          type: "task.error",
          payload: { message: failureSummary.slice(0, 2000) },
          level: "error",
        });
        await deps.api.completeTask({
          taskId,
          status: "failed",
          errorMessage: failureSummary,
        });
        return;
      }
      case "completed": {
        // A cancellation that landed during the resumed execution
        // wins over completion: never finalize a cancelled task.
        if (taskAbort.controller.signal.aborted) {
          await finishCancelledTask({
            deps,
            task: context.task,
            project: context.project,
            signal: taskAbort.controller.signal,
          });
          return;
        }
        const after = await deps.api.getContext({ taskId });
        await finalize({
          deps,
          task: context.task,
          project: context.project,
          workspacePath,
          plan,
          planVersion,
          agents: context.agents,
          subtasks: after?.subtasks ?? [],
          state,
          openIssues: sharedContext.outstandingIssues,
          signal: taskAbort.controller.signal,
        });
        return;
      }
    }
  } finally {
    taskAbort.dispose();
  }
}


export type { SubtaskKind };
