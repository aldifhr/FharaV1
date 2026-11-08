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
  type FileDiff,
} from "@/tools/gitDiff";
import type { RunnerDeps, RunState } from "./runner/types";
import {
  buildStateFromDb,
  carryForwardState,
} from "./runner/state";
import {
  armTaskAbort,
  buildReplanFeedback,
  buildTaskLlmResolver,
  budgetReasonFromSummary,
  combineSignals,
  dryRunPolicy,
  finishBudgetExhaustedTask,
  finishCancelledTask,
  implementerAgent,
  isForbiddenFilePath,
  isTerminalTaskStatus,
  kindForCapability,
  mcpForTask,
  normalizeFileChangePath,
  qaFindings,
  resolveQaBaseUrl,
  resolveWorkspacePath,
  seedBudgetFromPersisted,
  slugifyKeyPart,
  stagehandConfigFrom,
  summaryHasBudgetFailure,
  toAgentDefinition,
  toAgentResult,
  withFileContexts,
} from "./runner/setup";
import { finalize, persistPlan } from "./runner/finalize";

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

  // ponytail: worktree isolation is disabled for daily dev — the worktree is
  // created from HEAD while apply writes to the main workspace, so the diff
  // baseline (worktree) diverges from the apply target (dirty main workspace)
  // and apply fails with "created after approval". Working directly in the
  // main workspace keeps staging/apply/verify on one baseline. Upgrade path:
  // re-enable worktree + wire merge (worktreeNode.mergeBranch) so the
  // worktree branch is integrated instead of overwriting the main workspace.
  let branchName: string | undefined;
  let worktreePath: string | undefined;

  const runAgents = (agents as WorkerAgent[]).map(toAgentDefinition);
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
  const taskAbort = armTaskAbort(deps.policy);

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
        taskAbort: taskAbort.controller,
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
          feedback = buildReplanFeedback(`Objective not satisfied: ${missing}`, sharedContext);
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
            sharedContext
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
        feedback = buildReplanFeedback(failureSummary, sharedContext);
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
  // Plan 006 Phase 2: the decision engine replaces the advisory evaluation
  // path when the flag is on. Default OFF — the legacy path is byte-identical
  // until the engine is observed in the wild.
  const decisionEngine =
    deps.policy.decisionEngine === true &&
    Boolean(input.budget && input.sharedContext && input.classification);
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
  // The question this invocation paused for (plan 013 step 4). Set only
  // when the backend pause was applied; the re-queued run continues with
  // the user's answer threaded into the shared context.
  let waitingForInput: string | null = null;
  let delegationSeq = 0;
  let fixSeq = 0;
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
    const cto = input.agents.find((candidate) => /^cto$/i.test(candidate.role));
    const agent = subtask.kind === "review" && cto
      ? cto
      : routeCapability(subtask.capability, input.agents, {
          allowFallback: subtask.kind !== "qa" && subtask.capability !== CAPABILITY.BROWSER_TESTING,
        });
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

  const runNodes = (nodes: PlanSubtask[]): Promise<SchedulerResult> => {
    const subsetKeys = new Set(nodes.map((node) => node.key));
    // Subset runs (the review/QA loops re-run their own nodes) filter out
    // dependencies that live outside the subset, because the scheduler can
    // only order nodes it was given. Review/QA nodes are stage-managed by
    // the runner itself, so their ordering never has to be enforced here.
    // Any other unmet prerequisite (an implementation/analysis node that
    // never completed) fails the subset closed instead of letting the node
    // run on incomplete work.
    const stageManaged = new Set(
      plan.subtasks
        .filter((subtask) => subtask.kind === "review" || subtask.kind === "qa")
        .map((subtask) => subtask.key)
    );
    const unmet = nodes.filter((node) =>
      node.dependencies.some(
        (dependency) =>
          !subsetKeys.has(dependency) &&
          !stageManaged.has(dependency) &&
          !runCompleted.has(dependency)
      )
    );
    if (unmet.length > 0) {
      const outcomes = new Map<string, NodeOutcome>(
        unmet.map((node) => [
          node.key,
          {
            status: "failed" as const,
            error: `Prerequisite for "${node.key}" has not completed`,
          },
        ])
      );
      return Promise.resolve({
        status: "failed",
        outcomes,
        failed: unmet.map((node) => node.key),
      });
    }
    return runScheduler(
      nodes.map((subtask) => ({
        id: subtask.key,
        dependencies: subtask.dependencies.filter((dependency) => subsetKeys.has(dependency)),
      })),
    async (node, signal): Promise<NodeOutcome> => {
      const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
      const agent = assign(node.id);
      if (!agent) {
        return {
          status: "failed",
          error: `No enabled agent can serve capability "${subtask.capability}"`,
        };
      }
      if (runCompleted.has(node.id)) {
        return { status: "completed", output: "Previously completed" };
      }
      const executionId = executionIds.get(node.id);
      // Resolve this agent's provider chain (assignment → fallback → pool).
      // A resolution failure (e.g. no provider can serve the agent, or a
      // provider cannot be constructed) fails the subtask explicitly.
      let llmHandles: FallbackHandle[] | undefined;
      try {
        llmHandles = input.llmResolver?.handlesFor(agent);
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return await executeSubtask({
        workspacePath: input.workspacePath,
        command: task.command,
        plan,
        subtask,
        agent,
        browser,
        llmConfig: input.llmConfig,
        llmHandles,
        llmTaskGate: input.llmTaskGate,
        qaBaseUrl: input.qaBaseUrl,
        mcp: input.mcp,
        taskContext: input.sharedContext,
        priorOutputs: state.priorOutputs,
        fileChanges: Array.from(state.fileChanges.values()),
        // The executor observes BOTH abort sources: the scheduler's
        // per-node signal (subtask timeout / scheduler cancel) and the
        // per-task signal (task deadline / task-level cancel).
        signal: combineSignals(signal, input.taskAbort?.signal),
        // Pre-call budget gate (Phase 5): the executor checks it before
        // every LLM call this subtask makes.
        assertBudgetForCall: input.assertBudgetForCall,
        onEvent: async (type, payload, level) => {
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type,
            payload,
            executionId,
            subtaskKey: node.id,
            level,
          });
        },
        onMessage: async (content) => {
          // Suppress exact-duplicate consecutive postings per agent+subtask
          // (QA loops and fix loops re-execute identical summary text — the
          // conversation showed the same QA verdict 4x in a row).
          const dedupeKey = `${agent._id}|${node.id}`;
          const previous = lastPostedMessage.get(dedupeKey);
          if (previous === content) return;
          lastPostedMessage.set(dedupeKey, content);
          await deps.api.appendAgentMessage({
            projectId: project._id,
            taskId,
            agentId: agent._id,
            content,
            subtaskKey: node.id,
            executionId,
          });
        },
        onChunk: async () => {
          // Chunks are buffered by the provider; the final message is stored once.
        },
        saveFileChange: async (change) => {
          await deps.api.saveFileChange({
            taskId,
            projectId: project._id,
            filePath: change.filePath,
            changeType: change.changeType,
            oldContent: change.oldContent,
            newContent: change.newContent,
            oldContentHash: change.oldContentHash,
            newContentHash: change.newContentHash,
            diff: change.diff,
            subtaskKey: node.id,
            executionId,
          });
          state.fileChanges.set(change.filePath, change);
          // Phase 5 Step 5.1: attribute the staged file to the subtask that
          // produced it, so objective evaluation can check that every
          // completed code_change actually landed a change.
          const produced = state.appliedFilesBySubtask.get(node.id) ?? [];
          if (!produced.includes(change.filePath)) produced.push(change.filePath);
          state.appliedFilesBySubtask.set(node.id, produced);
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type: "fileChanges.updated",
            payload: { filePaths: [change.filePath] },
            executionId,
            subtaskKey: node.id,
          });
        },
        onTokenUsage: async (inputTokens, outputTokens, model, meta) => {
          // Feed the shared budget tracker with every real LLM call.
          input.budget?.recordLLMCall({
            inputTokens,
            outputTokens,
            model,
            agentName: agent.name,
            agentId: agent._id,
          });
          if (inputTokens > 0 || outputTokens > 0) {
            await deps.api.recordTokenUsage({
              projectId: project._id,
              taskId,
              agentId: agent._id,
              agentName: agent.name,
              model,
              inputTokens,
              outputTokens,
              // Phase 5 attribution: serving connection + registry
              // model + estimated cost (absent when unknown).
              providerId: meta?.providerId as
                | Parameters<WorkerApi["recordTokenUsage"]>[0]["providerId"]
                | undefined,
              modelId: meta?.modelRowId as
                | Parameters<WorkerApi["recordTokenUsage"]>[0]["modelId"]
                | undefined,
              estimatedCost: meta?.estimatedCost,
            });
          }
        },
      });
    },
    {
      maxConcurrency: Math.min(plan.maxConcurrency, deps.policy.maxConcurrency),
      timeoutMs: deps.policy.subtaskTimeoutMs,
      retries: deps.policy.subtaskRetries,
      // Phase 3 dynamic work: onOutcome may add delegation/fix subtasks
      // to this same invocation, capped per invocation; a budget BLOCKED
      // decision latches the halt so no new nodes start afterwards.
      maxAddedNodes: deps.policy.maxSubtasks,
      shouldHaltNewNodes: () => budgetHalt || stepLimitHit || decisionTerminal,
      shouldCancel: async () => {
        // The task deadline fired the shared abort controller (or a
        // cancel already propagated): the task is cancelled NOW. This
        // check bypasses the status-poll throttle below so a deadline
        // is honored within one scheduler pass, not up to 1.5s later.
        if (input.taskAbort?.signal.aborted) {
          cancelled = true;
          return true;
        }
        const now = Date.now();
        if (now - lastStatusCheck < 1500) return cancelled;
        lastStatusCheck = now;
        const current = await deps.api.getContext({ taskId });
        cancelled =
          !current ||
          current.task.status === "failed" ||
          current.task.status === "done" ||
          current.task.status === "rejected";
        if (cancelled) {
          // Propagate beyond this scheduler: in-flight LLM calls, QA
          // and verification observe the same per-task signal.
          input.taskAbort?.abort();
        }
        return cancelled;
      },
      // Per-agent concurrency (Phase 4): a node whose agent is already
      // running maxConcurrency subtasks is deferred by the scheduler
      // until one of them settles and frees a slot. The limit mirrors
      // the delegation gate's semantics (orchestrator/delegation.ts):
      // an unset maxConcurrency means 1.
      canStartNode: (node) => {
        const agent = assign(node.id);
        if (!agent) return true;
        const limit = agent.maxConcurrency ?? 1;
        return (activeByAgent.get(agent._id) ?? 0) < limit;
      },
      // Retries respect the task's bounds (Phase 4): no retry once the
      // deadline/cancel has fired, and no retry the LLM call budget
      // cannot pay for. (The Phase 1 permanent/transient classification
      // runs before this veto, unchanged.)
      shouldRetryNode: () => {
        if (input.taskAbort?.signal.aborted) return false;
        // A retry re-runs the node and spends another LLM call: veto it
        // whenever the budget gate would stop that call (Phase 5 — in
        // warn mode the gate does not throw, so the check is made on
        // the tracker's LLM exhaustion state directly).
        if (input.budget && input.budget.isLlmBudgetExhausted().exhausted) return false;
        return true;
      },
      onStart: async (node, attempt) => {
        if (runCompleted.has(node.id)) return;
        const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
        const agent = assign(node.id);
        if (!agent) throw new Error(`No enabled agent for capability ${subtask.capability}`);
        activeByAgent.set(agent._id, (activeByAgent.get(agent._id) ?? 0) + 1);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "subtask.routed",
          payload: {
            subtaskKey: node.id,
            capability: subtask.capability,
            agent: agent.name,
            capabilities: capabilitiesOf(agent),
          },
        });
        const executionId = await deps.api.startExecution({
          taskId,
          projectId: project._id,
          subtaskKey: node.id,
          agentId: agent._id,
          agentName: agent.name,
          capability: subtask.capability,
          workerId: deps.workerId,
          attempt,
          leaseMs: 60_000,
        });
        executionIds.set(node.id, executionId);
      },
      onOutcome: async (node, outcome, attempt) => {
        const agent = agentByKey.get(node.id);
        const executionId = executionIds.get(node.id);
        // The node has settled: it no longer counts as active work for
        // its agent (a scheduler retry re-enters via onStart).
        if (agent && !runCompleted.has(node.id)) {
          activeByAgent.set(
            agent._id,
            Math.max(0, (activeByAgent.get(agent._id) ?? 1) - 1)
          );
        }
        let dynamicNodes: SchedulerNode[] | undefined;
        if (!runCompleted.has(node.id) && executionId) {
          await deps.api.updateExecution({
            executionId,
            subtaskKey: node.id,
            status: outcome.status === "completed" ? "completed" : "failed",
            output: outcome.status === "failed" ? undefined : outcome.output,
            error: outcome.status === "failed" ? outcome.error : undefined,
            meta: outcome.status === "failed" ? undefined : outcome.meta,
          });
        }
        // A node that settles completed joins this run's completion set
        // BEFORE the decision engine reads it below, so a finished node is
        // never treated as pending work.
        if (outcome.status === "completed") runCompleted.add(node.id);
        const subtaskKind = plan.subtasks.find((candidate) => candidate.key === node.id)?.kind;
        const meta = outcome.meta as
          | { verdict?: string; findings?: ReviewResult["findings"] }
          | undefined;
        if (
          subtaskKind === "review" &&
          outcome.status === "completed" &&
          (meta?.verdict === "approved" || meta?.verdict === "changes_requested")
        ) {
          state.reviewVerdicts[node.id] = {
            verdict: meta.verdict,
            findings: Array.isArray(meta.findings) ? meta.findings : [],
          };
        }
        if (
          subtaskKind === "qa" &&
          (meta?.verdict === "passed" ||
            meta?.verdict === "failed" ||
            meta?.verdict === "inconclusive")
        ) {
          state.qaVerdicts[node.id] = meta.verdict;
          // Keep the actual checks so the pass message can name the URL
          // and the checks that ran instead of a generic template.
          const checks = (meta as { checks?: unknown })?.checks;
          if (Array.isArray(checks)) {
            state.qaChecks = {
              ...(state.qaChecks ?? {}),
              [node.id]: checks as NonNullable<RunState["qaChecks"]>[string],
            };
          }
        }
        // Issue lifecycle (plan 013 step 2): an approving review or a
        // passing planned QA resolves open issues whose related work is
        // actually covered by completed, attributed file changes. Applied
        // BEFORE the decision block re-assigns sharedContext.outstandingIssues
        // (its merge preserves resolutions) so the objective evaluation
        // below no longer reads freshly-fixed findings as open blockers.
        if (outcome.status === "completed" && input.sharedContext) {
          const approvedFiles = new Set(
            [...state.appliedFilesBySubtask.entries()]
              .filter(([key]) => runCompleted.has(key) || key === node.id)
              .flatMap(([, files]) => files)
          );
          if (subtaskKind === "review" && meta?.verdict === "approved") {
            input.sharedContext.outstandingIssues = resolveIssuesForApproval(
              input.sharedContext.outstandingIssues,
              { approvedFiles, approvingAgent: agent?.name }
            );
          }
          if (subtaskKind === "qa" && meta?.verdict === "passed") {
            input.sharedContext.outstandingIssues = resolveIssuesForQaPass(
              input.sharedContext.outstandingIssues,
              approvedFiles
            );
          }
        }
        // Intelligent orchestrator: evaluate every finished subtask, keep
        // the shared context current for the agents that run next, and
        // persist the decision trail. In authoritative mode (Phase 3) the
        // decision is also ACTED on inside this scheduler invocation:
        // APPROVE with an agent recommendation spawns a real delegation
        // subtask, REVISE with structured findings spawns a fix subtask,
        // and BLOCKED (budget) halts new scheduling. With the flag off
        // the behavior is the legacy record-only one. Any orchestrator
        // failure is logged, never propagated.
        if (input.budget && input.sharedContext && input.classification && agent) {
          try {
            const subtaskDef = plan.subtasks.find((candidate) => candidate.key === node.id);
            if (subtaskDef && decisionEngine) {
              const agentResult = toAgentResult({ subtask: subtaskDef, agent, outcome });
              const chain = chainByKey.get(node.id) ?? [subtaskDef.capability];
              // The engine consumes the LIVE evaluation (the same verdict
              // the legacy path records) as its observation, so Phase 2's
              // deterministic mapping is observable without a second gate.
              const live = evaluateAfterExecution({
                result: agentResult,
                classification: input.classification,
                agents: input.agents,
                budget: input.budget,
                previousAgents: input.sharedContext.agentExecutions.map(
                  (entry) => entry.agentName
                ),
                delegationDepth: Math.max(0, chain.length - 1),
                alreadyDelegated: chain.slice(0, -1),
                chainCapabilities: chain,
                activeByAgent,
                plannedCapabilities,
                taskContext: input.sharedContext,
                proposer: agent,
              });
              input.sharedContext.decisions = live.updatedContext.decisions;
              input.sharedContext.artifacts = live.updatedContext.artifacts;
              input.sharedContext.outstandingIssues = live.updatedContext.outstandingIssues;
              input.sharedContext.agentExecutions = live.updatedContext.agentExecutions;

              const observation: DecisionObservation = {
                outcome: outcome.status === "completed" ? "completed" : "failed",
                decision: live.decision,
                nextAgent: live.nextAgent,
                nextCapability: live.nextCapability,
                reason: live.reason,
                findings: agentResult.findings,
                delegationRecommendation: agentResult.delegationRecommendation,
                error: outcome.status === "failed" ? outcome.error : undefined,
                retryable: false,
              };

              const decisionContext: DecisionContext = {
                taskId,
                objective: input.sharedContext.objective,
                classification: input.classification,
                planVersion: input.planVersion ?? plan.version,
                plan,
                results: input.sharedContext.agentExecutions,
                openIssues: input.sharedContext.outstandingIssues,
                budget: input.budget.snapshot(),
                policy: deps.policy,
                agents: input.agents,
                completedKeys: runCompleted,
                step: decisionStep,
                chainCapabilities: chain,
                activeByAgent,
              };
              const { decision: decided, fallback } = await decide(
                decisionContext,
                observation,
                {
                  llmMode: deps.policy.decisionLlmMode,
                  advise: (ctx, obs) =>
                    decideWithLlm({
                      ctx,
                      observation: obs,
                      llmResolver: input.llmResolver,
                      llmConfig: input.llmConfig,
                      llmTaskGate: input.llmTaskGate,
                      onTokenUsage: input.onTokenUsage,
                      signal: input.taskAbort?.signal,
                      assertBudgetForCall: () => input.budget!.assertLlmCallAllowed(),
                    }),
                }
              );
              // Plan 005 Step 5.4: the step bound is terminal — fail the
              // task explicitly, never silently mark it done. `decide`
              // already returned the `decision:step_limit` outcome; latch
              // the halt so the scheduler drains instead of starting more.
              if (decided.expectedOutcome === "decision:step_limit") {
                stepLimitHit = true;
                await deps.api.logEvent({
                  taskId: task._id,
                  projectId: project._id,
                  type: "orchestrator.decision",
                  payload: {
                    subtaskKey: node.id,
                    id: decided.id,
                    action: decided.action,
                    reasoning: decided.reasoning.slice(0, 500),
                    target: null,
                    decidedBy: decided.decidedBy,
                    planVersion: decided.planVersion,
                    step: decisionStep,
                    expectedOutcome: decided.expectedOutcome,
                  },
                  executionId,
                  subtaskKey: node.id,
                  level: "warn",
                });
                return dynamicNodes;
              }
              // Plan 005 Step 5.1: `complete` is only emitted when the
              // objective evidence says it is met; otherwise the request
              // becomes replan (concrete gaps) or ask_user (no path).
              //
              // Only a node that EXECUTED in this run may be downgraded.
              // A node skipped as "Previously completed" on resume /
              // recovery has no executionId this run; evaluating its
              // objective here compares against rebuilt in-memory
              // evidence, which is incomplete for that node, so the
              // downgrade would fabricate a replan and post a
              // "stopping this step" message per skipped node. The
              // previous run already decided these nodes.
              let decision = decided;
              // A downgrade is internal bookkeeping: the evidence check
              // reclassified this outcome (complete -> replan/ask_user)
              // because the objective is not met *yet* — e.g. a review
              // finding the review loop is already fixing. Narrating it
              // as a CTO "stopping this step" message per node settle is
              // pure spam (the user saw it 5x in one task while the fix
              // loop was progressing normally). Skip the chat narration
              // for downgrades; the objective_unmet event above keeps
              // the telemetry.
              //
              // While a review or QA loop is in flight its open findings
              // are EXPECTED (the loop owns them and will close them when
              // its verdict lands), so the downgrade itself is deferred
              // too: mid-loop downgrades replan the task mid-fix and burn
              // the replans budget for no reason.
              const reviewQaInFlight = plan.subtasks.some(
                (candidate) =>
                  (candidate.kind === "review" || candidate.kind === "qa") &&
                  !dynamicKeys.has(candidate.key) &&
                  !runCompleted.has(candidate.key)
              );
              let downgradedByObjective = false;
              if (decision.action === "complete" && executionId && !reviewQaInFlight) {
                const pendingRequiredNodes = plan.subtasks.some(
                   (candidate) =>
                     (candidate.kind === "qa" || candidate.kind === "review") &&
                     !dynamicKeys.has(candidate.key) &&
                     !runCompleted.has(candidate.key) &&
                     candidate.key !== node.id
                 );
                 if (pendingRequiredNodes) return dynamicNodes;
                 const objective = evaluateObjective({
                  ...decisionContext,
                  dynamicKeys,
                  objectiveEvidence: {
                    appliedFiles: Object.fromEntries(state.appliedFilesBySubtask),
                    qaVerdicts: state.qaVerdicts,
                    verification: state.verification,
                    lastDecision: {
                      action: decision.action,
                      expectedOutcome: decision.expectedOutcome,
                    },
                  },
                });
                if (objective.satisfied) {
                  await deps.api.logEvent({
                    taskId: task._id,
                    projectId: project._id,
                    type: "orchestrator.completed",
                    payload: {
                      evidence: objective.evidence,
                      rationale: decision.reasoning.slice(0, 500),
                    },
                    executionId,
                    subtaskKey: node.id,
                    level: "info",
                  });
                } else {
                  await deps.api.logEvent({
                    taskId: task._id,
                    projectId: project._id,
                    type: "orchestrator.objective_unmet",
                    payload: {
                      missing: objective.missing,
                      evidence: objective.evidence,
                    },
                    executionId,
                    subtaskKey: node.id,
                    level: "warn",
                  });
                  decision = {
                    ...decision,
                    action: objective.missing.length > 0 ? "replan" : "ask_user",
                    reasoning: `objective not satisfied: ${objective.missing.join("; ")}`.slice(0, 500),
                    expectedOutcome: "recovery",
                  };
                  downgradedByObjective = true;
                }
              }
              if (fallback) {
                await deps.api.logEvent({
                  taskId: task._id,
                  projectId: project._id,
                  type: "orchestrator.decision_fallback",
                  payload: { subtaskKey: node.id, reason: fallback.slice(0, 500) },
                  executionId,
                  subtaskKey: node.id,
                  level: "warn",
                });
              }
              await deps.api.logEvent({
                taskId: task._id,
                projectId: project._id,
                type: "orchestrator.decision",
                payload: {
                  subtaskKey: node.id,
                  id: decision.id,
                  action: decision.action,
                  reasoning: decision.reasoning.slice(0, 500),
                  target: decision.target ?? null,
                  decidedBy: decision.decidedBy,
                  planVersion: decision.planVersion,
                  step: decisionStep,
                  expectedOutcome: decision.expectedOutcome ?? null,
                },
                executionId,
                subtaskKey: node.id,
                level: "info",
              });
              // Step 4.2: the engine's decision joins the shared trail so
              // replan feedback and the persisted context see it. The
              // evaluation-layer entry from evaluateAfterExecution is kept
              // (the UI and legacy readers consume it).
              input.sharedContext.decisions = [
                ...input.sharedContext.decisions,
                {
                  decision: decision.action,
                  reason: decision.reasoning,
                  capability: decision.target?.capability,
                  fromAgent: agent.name,
                  createdAt: decision.createdAt,
                  id: decision.id,
                  target: decision.target,
                  decidedBy: decision.decidedBy,
                  planVersion: decision.planVersion,
                  step: decisionStep,
                },
              ];
              if (decision.action === "delegate" && budgetEnforced) {
                // Count the delegation so the count gate stays honest; the
                // depth/circularity gates were already checked in validate.
                // (Delegation counting is budget bookkeeping only.)
                input.budget.incrementDelegation();
              }
              // Decision narration stays in events only: the chat gets
              // ONE CTO summary at completion. A "Please handle X" /
              // "Please revise" chat line per decision was the remaining
              // spam source (the delegation/revise itself, via applyDecision,
              // is unaffected).
              const applied = applyDecision(
                {
                  taskId,
                  objective: input.sharedContext.objective,
                  classification: input.classification,
                  planVersion: input.planVersion ?? plan.version,
                  plan,
                  results: input.sharedContext.agentExecutions,
                  openIssues: input.sharedContext.outstandingIssues,
                  budget: input.budget.snapshot(),
                  policy: deps.policy,
                  agents: input.agents,
                  completedKeys: runCompleted,
                  step: decisionStep,
                  chainCapabilities: chain,
                  activeByAgent,
                },
                decision,
                (base) => uniqueSubtaskKey(`${base}_${decisionStep}`)
              );
              // Plan 013 step 3: the applied outcome is real. `nodes`
              // spawns dynamic subtasks; `halt` is a budget BLOCKED and
              // stops scheduling on the budget-exhausted path; `complete`
              // latches the terminal flag ONLY when no planned node
              // remains pending (otherwise completion is deferred and
              // recorded — the remaining stages own the objective);
              // `replan` latches too and `replanFeedback` carries the
              // objective missing list back to processTask's bounded
              // re-plan; `ask_user` is a recorded no-op until step 4.
              switch (applied.kind) {
                case "nodes": {
                  if (applied.nodes.length > 0) {
                    for (const dynamic of applied.nodes) {
                      plan.subtasks.push(dynamic);
                      dynamicKeys.add(dynamic.key);
                      chainByKey.set(dynamic.key, [...chain, dynamic.capability]);
                      fixDepthByKey.set(dynamic.key, 0);
                    }
                    await persistDynamic(applied.nodes, decision.action === "execute" ? "fix" : "delegation");
                    dynamicNodes = applied.nodes.map((dynamic) => ({
                      id: dynamic.key,
                      dependencies: dynamic.dependencies,
                    }));
                  }
                  break;
                }
                case "halt": {
                  if (!budgetHalt) {
                    budgetHalt = true;
                    await deps.api.logEvent({
                      taskId: task._id,
                      projectId: project._id,
                      type: "orchestrator.budget_blocked",
                      payload: {
                        subtaskKey: node.id,
                        reason: applied.reason.slice(0, 500),
                        budget: input.budget.snapshot(),
                      },
                      executionId,
                      subtaskKey: node.id,
                      level: "warn",
                    });
                  }
                  break;
                }
                case "complete": {
                  const noPlannedPending = plan.subtasks.every(
                    (candidate) => candidate.key === node.id || runCompleted.has(candidate.key)
                  );
                  if (applied.expectedOutcome === "objective:met" && noPlannedPending) {
                    decisionTerminal = true;
                    await deps.api.logEvent({
                      taskId: task._id,
                      projectId: project._id,
                      type: "orchestrator.completed",
                      payload: { expectedOutcome: applied.expectedOutcome },
                      executionId,
                      subtaskKey: node.id,
                      level: "info",
                    });
                  }
                  break;
                }
                case "replan": {
                  decisionTerminal = true;
                  // First request wins: the earliest missing list is the
                  // feedback the bounded re-plan will address.
                  if (replanFeedback === null) {
                    replanFeedback = applied.reason;
                  }
                  break;
                }
                case "ask_user": {
                  // Plan 013 step 4: pause the task in `waiting_input`
                  // with the question visible. The first applied pause
                  // wins; a refused pause (lease lost / task already
                  // terminal) is recorded and the run continues.
                  if (waitingForInput === null) {
                    const paused = await deps.api
                      .pauseForInput({
                        taskId,
                        question: applied.question,
                        workerId: deps.workerId,
                      })
                      .catch(() => null);
                    if (paused?.applied) {
                      waitingForInput = applied.question;
                      decisionTerminal = true;
                    }
                  }
                  break;
                }
              }
              decisionStep += 1;
              await deps.api
                .upsertTaskContext?.({
                  taskId,
                  projectId: project._id,
                  originalRequest: input.sharedContext.originalRequest,
                  objective: input.sharedContext.objective,
                  status: (task.status as any) || "running",
                  decisions: input.sharedContext.decisions,
                  artifacts: input.sharedContext.artifacts,
                  outstandingIssues: input.sharedContext.outstandingIssues,
                  budgetSnapshot: input.budget.snapshot(),
                })
                ?.catch(() => undefined);
              return dynamicNodes;
            }
            if (subtaskDef && !decisionEngine) {
              const agentResult = toAgentResult({ subtask: subtaskDef, agent, outcome });
              const chain = chainByKey.get(node.id) ?? [subtaskDef.capability];
              const evaluation = evaluateAfterExecution({
                result: agentResult,
                classification: input.classification,
                agents: input.agents,
                budget: input.budget,
                previousAgents: input.sharedContext.agentExecutions.map(
                  (entry) => entry.agentName
                ),
                delegationDepth: Math.max(0, chain.length - 1),
                alreadyDelegated: chain.slice(0, -1),
                chainCapabilities: chain,
                activeByAgent,
                plannedCapabilities,
                taskContext: input.sharedContext,
                proposer: agent,
              });
              input.sharedContext.decisions = evaluation.updatedContext.decisions;
              input.sharedContext.artifacts = evaluation.updatedContext.artifacts;
              input.sharedContext.outstandingIssues =
                evaluation.updatedContext.outstandingIssues;
              input.sharedContext.agentExecutions =
                evaluation.updatedContext.agentExecutions;

              // --- Decision -> action (authoritative mode only) --------
              // Cancellation gates decisions too (Phase 4 hardening):
              // once the task is cancelled/timed out, an outcome that
              // settles late is recorded but spawns NO new work.
              let delegatedSubtaskKey: string | null = null;
              let fixSubtaskKey: string | null = null;
              if (authoritative && !input.taskAbort?.signal.aborted) {
                if (evaluation.decision === "BLOCKED") {
                  // Budget exhausted. Enforce mode: stop scheduling new
                  // work in this invocation (the scheduler blocks what
                  // is still pending once running nodes drain) and mark
                  // the task with an explicit budget event; the next
                  // LLM call attempt then throws BudgetExhaustedError
                  // at the pre-call gate, and the runner's budget
                  // ending closes the task with completed outputs
                  // preserved. Warn mode (Phase 5 default): the
                  // evaluation stays a recorded decision only — no
                  // halt, no event here; the pre-call gate's
                  // budget.warning is the signal and the run continues.
                  if (budgetEnforced && !budgetHalt) {
                    budgetHalt = true;
                    await deps.api.logEvent({
                      taskId,
                      projectId: project._id,
                      type: "orchestrator.budget_blocked",
                      payload: {
                        subtaskKey: node.id,
                        reason: evaluation.reason.slice(0, 500),
                        budget: input.budget.snapshot(),
                      },
                      executionId,
                      subtaskKey: node.id,
                      level: "warn",
                    });
                  }
                } else if (
                  evaluation.decision === "APPROVE" &&
                  evaluation.nextAgent &&
                  evaluation.nextCapability &&
                  outcome.status === "completed" &&
                  agentResult.delegationRecommendation?.targetCapability ===
                    evaluation.nextCapability
                ) {
                  // Only recommendation-driven approvals spawn work: the
                  // agent explicitly asked for another capability. (The
                  // deterministic QA heuristic stays a recorded decision —
                  // the plan's own QA subtask already covers it, and a
                  // second QA node mid-implementation would test code
                  // that has not been applied yet.)
                  delegationSeq += 1;
                  const key = uniqueSubtaskKey(
                    `delegate_${slugifyKeyPart(evaluation.nextCapability)}_${delegationSeq}`
                  );
                  const delegationSubtask: PlanSubtask = {
                    key,
                    title: `Delegated work: ${evaluation.nextCapability}`,
                    description: [
                      `Delegated by agent ${agent.name} after completing subtask "${subtaskDef.title}" (${subtaskDef.key}).`,
                      `Reason: ${agentResult.delegationRecommendation.reason}`,
                      `Task goal: ${plan.goal}`,
                      "Use the shared task context (previous results, decisions and open issues) and do only the work this capability is responsible for.",
                    ].join("\n"),
                    kind: kindForCapability(evaluation.nextCapability),
                    capability: evaluation.nextCapability,
                    dependencies: [node.id],
                    order: nextOrder(),
                  };
                  plan.subtasks.push(delegationSubtask);
                  dynamicKeys.add(key);
                  chainByKey.set(key, [...chain, evaluation.nextCapability]);
                  fixDepthByKey.set(key, 0);
                  delegatedSubtaskKey = key;
                  await persistDynamic([delegationSubtask], "delegation");
                  dynamicNodes = [{ id: key, dependencies: [node.id] }];
                } else if (
                  evaluation.decision === "REVISE" &&
                  outcome.status === "completed" &&
                  subtaskDef.kind !== "review" &&
                  (fixDepthByKey.get(node.id) ?? 0) < 1 &&
                  agentResult.findings &&
                  agentResult.findings.length > 0 &&
                  evaluation.nextCapability
                ) {
                  // REVISE for a review subtask is owned by the review
                  // loop (it builds its own fix subtasks) — spawning one
                  // here too would double the fix work, so review kinds
                  // never reach this branch. Fix subtasks themselves
                  // (fixDepth 1) do not spawn further fixes.
                  fixSeq += 1;
                  const key = uniqueSubtaskKey(
                    `fix_${slugifyKeyPart(node.id)}_${fixSeq}`
                  );
                  const fixSubtask = buildFixSubtask({
                    key,
                    title: `Address findings from "${subtaskDef.title}"`,
                    intro: `The orchestrator evaluated subtask "${subtaskDef.title}" (${subtaskDef.key}) and requested changes.`,
                    findings: agentResult.findings,
                    capability: evaluation.nextCapability,
                    order: nextOrder(),
                    dependencies: [node.id],
                  });
                  plan.subtasks.push(fixSubtask);
                  dynamicKeys.add(key);
                  chainByKey.set(key, chain);
                  fixDepthByKey.set(key, (fixDepthByKey.get(node.id) ?? 0) + 1);
                  fixSubtaskKey = key;
                  await persistDynamic([fixSubtask], "fix");
                  dynamicNodes = [{ id: key, dependencies: [node.id] }];
                }
              }

              if (evaluation.decision === "APPROVE" && evaluation.nextAgent) {
                input.budget.incrementDelegation();
                await deps.api
                  .recordDelegation?.({
                    taskId,
                    projectId: project._id,
                    fromAgentId: agent._id,
                    toAgentId: evaluation.nextAgent._id,
                    decision: "APPROVE",
                    reason: evaluation.reason,
                    capability: evaluation.nextCapability,
                  })
                  ?.catch(() => undefined);
                // Plan 006 Phase 4: delegation proposals write the addressed
                // message row so the target agent sees the handoff.
                await deps.api
                  .appendAgentMessage({
                    projectId: project._id,
                    taskId: task._id as any,
                    // Keep the handoff visible in the shared chat as a CTO/lead
                    // instruction. The delegated agent's executor will follow
                    // with its own progress/result message.
                    agentId: agent._id as any,
                    content: `@${evaluation.nextAgent.name} ${evaluation.reason.slice(0, 300)}`,
                    subtaskKey: delegatedSubtaskKey ?? node.id,
                    executionId,
                  })
                  .catch(() => undefined);
              }
              await deps.api.logEvent({
                taskId,
                projectId: project._id,
                type: "orchestrator.evaluation",
                payload: {
                  subtaskKey: node.id,
                  decision: evaluation.decision,
                  reason: evaluation.reason.slice(0, 500),
                  nextAgent: evaluation.nextAgent?.name ?? null,
                  nextCapability: evaluation.nextCapability ?? null,
                  delegatedSubtaskKey,
                  fixSubtaskKey,
                },
                executionId,
                subtaskKey: node.id,
                level: evaluation.decision === "BLOCKED" ? "warn" : "info",
              });
              // Step 4.2: one decision trail — the legacy path also
              // records `orchestrator.decision` (the evaluation event above
              // stays for the UI). Same vocabulary mapping as
              // nextDeterministicDecision.
              const legacyAction =
                evaluation.decision === "APPROVE"
                  ? "delegate"
                  : evaluation.decision === "REVISE"
                    ? "execute"
                    : "complete";
              await deps.api.logEvent({
                taskId,
                projectId: project._id,
                type: "orchestrator.decision",
                payload: {
                  subtaskKey: node.id,
                  id: `eval_${node.id}`,
                  action: legacyAction,
                  reasoning: evaluation.reason.slice(0, 500),
                  target: evaluation.nextCapability
                    ? { agentId: evaluation.nextAgent?._id, capability: evaluation.nextCapability }
                    : null,
                  decidedBy: "deterministic",
                  planVersion: input.planVersion ?? plan.version,
                  step: null,
                  expectedOutcome:
                    evaluation.decision === "BLOCKED"
                      ? "policy:budget"
                      : evaluation.decision === "REJECT"
                        ? "proposal:rejected"
                        : legacyAction === "delegate"
                          ? "delegated"
                          : legacyAction === "execute"
                            ? "fixed"
                            : "objective:met",
                },
                executionId,
                subtaskKey: node.id,
                level: evaluation.decision === "BLOCKED" ? "warn" : "info",
              });
              await deps.api
                .upsertTaskContext?.({
                  taskId,
                  projectId: project._id,
                  originalRequest: input.sharedContext.originalRequest,
                  objective: input.sharedContext.objective,
                  status: (task.status as any) || "running",
                  decisions: input.sharedContext.decisions,
                  artifacts: input.sharedContext.artifacts,
                  outstandingIssues: input.sharedContext.outstandingIssues,
                  // Phase 5: keep the persisted budget snapshot current
                  // after every evaluation, so recovery restores the
                  // tracker as of the last finished subtask.
                  budgetSnapshot: input.budget.snapshot(),
                })
                ?.catch(() => undefined);
            }
          } catch (err) {
            await deps.api
              .logEvent({
                taskId,
                projectId: project._id,
                type: "orchestrator.evaluation_failed",
                payload: {
                  subtaskKey: node.id,
                  message: err instanceof Error ? err.message : String(err),
                },
                executionId,
                subtaskKey: node.id,
                level: "warn",
              })
              .catch(() => undefined);
          }
        }
        if (outcome.status === "completed") {
          state.priorOutputs.set(node.id, outcome.output ?? "");
          return dynamicNodes;
        }
        if (outcome.status === "failed") {
          state.feedback.push(`${node.id} (attempt ${attempt}): ${outcome.error}`);
          if (agent) {
            await deps.api.appendAgentMessage({
              projectId: project._id,
              taskId,
              agentId: agent._id,
              content: `Subtask ${node.id} failed: ${outcome.error}`,
              subtaskKey: node.id,
              executionId,
            });
          }
        }
        return dynamicNodes;
      },
      onBlocked: async (node, reason) => {
        // A node blocked while the budget halt is latched (Phase 5):
        // record the budget failure in the run feedback so the runner
        // ends the task as budget.exhausted — a halted node never
        // reaches the pre-call gate, so without this entry its stop
        // would surface only as a generic execution failure.
        if (budgetHalt && input.budget) {
          const llmBudget = input.budget.isLlmBudgetExhausted();
          if (llmBudget.exhausted) {
            state.feedback.push(
              `${node.id}: Budget exhausted: ${llmBudget.reason}`
            );
          }
        }
        // Dynamic subtasks (Phase 3 delegation/fix) have no persisted
        // subtask row; a failed status write for them must not take the
        // scheduler down — the event below still records the block.
        await deps.api
          .updateSubtask({
            taskId,
            key: node.id,
            status: "blocked",
            error: reason,
          })
          .catch(() => undefined);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "subtask.blocked",
          payload: { subtaskKey: node.id, reason },
          subtaskKey: node.id,
          level: "warn",
        });
      },
    }
    );
  };

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
    const wp = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
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

  const runReviewLoop = async (): Promise<boolean> => {
    if (reviewNodes.length === 0) return true;

    // Resume/recovery: a review that already approved before the
    // interruption has its verdict seeded into state by buildStateFromDb.
    // Re-running it would re-post the same CTO messages and burn a whole
    // extra review cycle, so the stage counts as satisfied without
    // running any review node.
    if (
      reviewNodeKeys.every(
        (key) => state.reviewVerdicts[key]?.verdict === "approved"
      )
    ) {
      return true;
    }

    const maxIterations = deps.policy.maxReviewIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      for (const key of reviewNodeKeys) {
        delete state.reviewVerdicts[key];
        // The loop deliberately re-runs its own nodes: clear this run's
        // completion mark so the scheduler executes them again.
        runCompleted.delete(key);
      }

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "reviewing", iteration, planVersion: plan.version },
      });

      const reviewRun = await runNodes(reviewNodes);
      if (reviewRun.status !== "completed") return false;

      const changesRequested = reviewNodeKeys.some(
        (key) => state.reviewVerdicts[key]?.verdict === "changes_requested"
      );
      if (!changesRequested) {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "review.approved",
          payload: { iteration },
        });
        // No chat narration: the CTO's one consolidated summary at
        // completion reports the review outcome. The approval itself is
        // recorded in events.
        return true;
      }

      const findings = collectRequestedChanges(state.reviewVerdicts, reviewNodeKeys);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.requested_changes",
        payload: { iteration, findings },
        level: "warn",
      });

      if (iteration >= maxIterations) {
        state.feedback.push(
          `Review still requested changes after ${maxIterations} fix attempt(s): ${findings
            .map((finding) => finding.description)
            .join("; ")}`
        );
        return false;
      }

      const implementer = implementerAgent(plan, input.agents);
      if (!implementer) {
        state.feedback.push("No implementer agent is available to address review findings");
        return false;
      }

      const codeSubtask = plan.subtasks.find((candidate) => candidate.kind === "code_change");
      const fixSubtask = buildReviewFixSubtask({
        iteration: iteration + 1,
        findings,
        capability: codeSubtask?.capability ?? CAPABILITY.GENERAL,
        order: plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1,
      });
      plan.subtasks.push(fixSubtask);
      dynamicKeys.add(fixSubtask.key);
      // The review loop owns this fix: register it as a fix-depth-1 node
      // on its own chain so an orchestrator evaluation of its outcome can
      // never spawn a second, duplicate fix subtask (Phase 3).
      chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
      fixDepthByKey.set(fixSubtask.key, 1);
      // The review loop's fix subtask is dynamic work too: persist it
      // like the orchestrator's (Phase 4 hardening).
      await persistDynamic([fixSubtask], "review_fix");
      state.priorOutputs.set(`${fixSubtask.key}-findings`, formatReviewFindings(findings));

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.fix_started",
        payload: {
          iteration: iteration + 1,
          findings: findings.length,
          agent: implementer.name,
        },
      });

      const fixRun = await runNodes([fixSubtask]);
      if (fixRun.status !== "completed") {
        state.feedback.push(`Review fix attempt ${iteration + 1} failed`);
        return false;
      }
    }

    return false;
  };

  /**
   * Plan 005 Step 5.2: targeted QA correction. A failing QA verdict spawns
   * a fix subtask carrying the QA failure as findings (the checks, when
   * present), and the same QA nodes re-run. Bounded by maxReviewIterations
   * like the review loop. Returns false when QA still fails (or the fix
   * itself failed) — the caller turns that into "failed" so the task is
   * never silently marked done.
   */
  const runQaLoop = async (): Promise<boolean> => {
    if (qaNodes.length === 0) return true;

    // Resume/recovery: when QA already passed pre-interruption, its
    // verdict is seeded by buildStateFromDb. Re-running it would
    // duplicate the QA messages and burn another full pass, so the
    // stage is satisfied without re-running.
    if (qaNodes.every((node) => state.qaVerdicts[node.key] === "passed")) {
      return true;
    }

    const maxIterations = deps.policy.maxReviewIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      for (const node of qaNodes) {
        delete state.qaVerdicts[node.key];
        // The loop deliberately re-runs its own QA nodes: clear this run's
        // completion mark so the scheduler executes them again.
        runCompleted.delete(node.key);
      }

      const qaRun = await runNodes(qaNodes);
      if (qaRun.status === "cancelled") return false;

      const failedNodes = qaNodes.filter((node) => state.qaVerdicts[node.key] !== "passed");
      if (qaRun.status === "completed" && failedNodes.length === 0) {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "qa.passed",
          payload: { iteration },
          message: "QA verification passed: all checks and assertions satisfied.",
        });
        const qaAgent =
          input.agents.find((a) => a.role === "qa") ||
          input.agents.find((a) => capabilitiesOf(a).includes(CAPABILITY.BROWSER_TESTING));
        if (qaAgent) {
          // Describe what actually ran, not a boilerplate list: the URL
          // that was checked and the checks that executed. The plan-level
          // intent is authoritative (a prohibition like "no screenshots"
          // must never be read as a request for visual checks just
          // because the word appears). No @QA mention here: the message
          // is authored by the QA agent itself, so a leading self-tag
          // reads as QA talking about itself.
          const visualQa = plan.visualQa ?? wantsVisualQa(input.task.command);
          const ranChecks = qaNodes.flatMap((node) => state.qaChecks?.[node.key] ?? []);
          const passedCount = ranChecks.filter((check) => check.status === "passed").length;
          // Same source as executeQa: the resolved URL recorded in the
          // "application reachable" check (the threaded qaBaseUrl may be
          // unset when the project has no qaUrl/devUrl configured).
          const checked =
            ranChecks.find((check) => check.label === "application reachable")?.details ??
            input.qaBaseUrl ??
            "the app";
          const detail =
            ranChecks.length > 0
              ? `Checked ${checked} — ${passedCount}/${ranChecks.length} checks ok: ${ranChecks
                  .map((check) => check.label)
                  .join(", ")}.`
              : "";
          await deps.api.appendAgentMessage({
            projectId: project._id,
            taskId,
            agentId: qaAgent._id as any,
            content: `QA validation passed. ${detail}${
              visualQa
                ? " Visual checks completed as requested."
                : " Structural checks only — no visual comparison."
            }`,
          });
        }
        return true;
      }

      if (qaRun.status !== "completed" && failedNodes.length === 0) {
        return false;
      }

      // Synthesize findings from the QA checks/failures on the outcomes.
      const findings = qaFindings(qaRun, failedNodes);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "qa.failed",
        payload: { iteration, findings },
        message: `QA reported ${findings.length} issue(s) requiring revision.`,
        level: "warn",
      });

      if (iteration >= maxIterations) {
        state.feedback.push(
          `QA still failing after ${maxIterations} fix attempt(s): ${findings
            .map((finding) => finding.description)
            .join("; ")}`
        );
        return false;
      }

      const implementer = implementerAgent(plan, input.agents);
      if (!implementer) {
        state.feedback.push("No implementer agent is available to address QA failures");
        return false;
      }

      const codeSubtask = plan.subtasks.find((candidate) => candidate.kind === "code_change");
      const fixSubtask = buildFixSubtask({
        key: `fix_qa_${iteration + 1}`,
        title: `Address QA failures (iteration ${iteration + 1})`,
        intro: "QA reported failures on the prepared work.",
        findings,
        capability: codeSubtask?.capability ?? CAPABILITY.GENERAL,
        order: plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1,
      });
      plan.subtasks.push(fixSubtask);
      dynamicKeys.add(fixSubtask.key);
      // The QA loop owns this fix: register it as a fix-depth-1 node on its
      // own chain so an orchestrator evaluation of its outcome can never
      // spawn a second, duplicate fix subtask (mirrors the review loop).
      chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
      fixDepthByKey.set(fixSubtask.key, 1);
      await persistDynamic([fixSubtask], "fix");
      state.priorOutputs.set(`${fixSubtask.key}-findings`, formatReviewFindings(findings));

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "qa.fix_started",
        payload: {
          iteration: iteration + 1,
          findings: findings.length,
          agent: implementer.name,
        },
        level: "warn",
      });

      const fixRun = await runNodes([fixSubtask]);
      if (fixRun.status !== "completed") {
        state.feedback.push(`QA fix attempt ${iteration + 1} failed`);
        return false;
      }
      // The fix's staged changes must reach the workspace before QA
      // re-runs, otherwise QA validates the pre-fix app and can never
      // pass. In ask mode the approval gate stays authoritative: the
      // fix is applied only after the user approved the plan's changes
      // (the main apply phase above), never silently on its own.
      if (input.approvalMode !== "ask") {
        const fixPaths = state.appliedFilesBySubtask.get(fixSubtask.key) ?? [];
        const fixChanges = fixPaths
          .map((filePath) => state.fileChanges.get(filePath))
          .filter((change): change is FileDiff => Boolean(change));
        const applied = await applyStaged(fixChanges, "orchestrator");
        if ("stop" in applied) {
          state.feedback.push(`QA fix attempt ${iteration + 1} could not be applied`);
          return false;
        }
      }
    }

    return false;
  };

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

  if (shouldAsk) {
    const implementer = implementerAgent(plan, input.agents);
    const summary = `Apply changes to ${preparedChanges.length} file(s): ${preparedChanges
      .map((change) => change.filePath)
      .join(", ")}`;
    await deps.api.requestApproval({
      taskId,
      projectId: project._id,
      subtaskKey: plan.subtasks.find((subtask) => subtask.kind === "code_change")?.key,
      kind: "apply_changes",
      summary,
      payload: {
        filePaths: preparedChanges.map((change) => change.filePath),
        planVersion: plan.version,
        policyDryRun: dryRunSummary,
        metrics: {
          files: preparedChanges.length,
          build: "clean",
          tests: "passed",
          qa:
            qaNodes.length > 0
              ? (plan.visualQa ?? wantsVisualQa(input.task.command))
                ? "Visual QA planned"
                : "Structural QA planned"
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
      content: `Changes are prepared and verified. Ready to apply to workspace. Please approve the diff.`,
    });
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "waiting_approval", files: preparedChanges.length },
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
      details: { dryRun: dryRunSummary },
    });
    return { status: "waiting_approval" };
  }

  if (preparedChanges.length > 0) {
    const applied = await applyStaged(
      preparedChanges,
      input.approvalResolved ? "user" : "orchestrator"
    );
    if ("stop" in applied) {
      return applied.stop;
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

  if (qaNodes.length > 0) {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "verifying", files: preparedChanges.length },
    });
    // Plan 005 Step 5.2: QA failures spawn targeted fix subtasks and the
    // same QA nodes re-run; a still-failing QA after the last fix attempt
    // fails the task instead of being silently marked done.
    const qaApproved = await runQaLoop();
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

    // Verify loop (oh-my-claudecode `team-verify → team-fix`): static
    // verification failure spawns a targeted fix and re-verifies, bounded
    // by maxReviewIterations. A task never completes on a failing check.
    if (deps.policy.verificationEnabled && preparedChanges.length > 0) {
      const maxVerifyIters = deps.policy.maxReviewIterations;
      let verifyIteration = 0;
      while (verifyIteration <= maxVerifyIters) {
        const verification = await runVerification({
          workspacePath: input.workspacePath,
          changedFiles: Array.from(state.fileChanges.keys()),
          includeBuild: deps.policy.verificationIncludeBuild,
          timeoutMs: deps.policy.verificationTimeoutMs,
          signal: input.taskAbort?.signal,
          onCheck: async (check) => {
            await deps.api.logEvent({
              taskId,
              projectId: project._id,
              type: "task.check",
              payload: { label: `verify:${check.name}`, status: check.status, details: check.details },
            });
          },
        });
        const failedChecks = verification.checks.filter((c) => c.status === "failed");
        const allPassed =
          verification.checks.length > 0 &&
          verification.checks.every((c) => c.status === "passed");
        state.verification = {
          status: failedChecks.length > 0 ? "failed" : allPassed ? "passed" : "skipped",
          details: failedChecks.map((c) => `${c.name}: ${c.details ?? ""}`).join("; ") || undefined,
        };
        if (failedChecks.length === 0) break;
        if (verifyIteration >= maxVerifyIters) {
          state.feedback.push(
            `Verification still failing after ${maxVerifyIters} fix attempt(s): ${failedChecks.map((c) => c.name).join(", ")}`
          );
          return { status: taskCancelled() ? "cancelled" : "failed" };
        }
        const findings: ReviewFinding[] = failedChecks.map((c) => ({
          severity: "high" as const,
          filePath: Array.from(state.fileChanges.keys())[0] ?? "",
          description: `${c.name}: ${c.details ?? "check failed"}`,
          suggestion: "Fix the failing check and retry verification.",
        }));
        const implementer = implementerAgent(plan, input.agents);
        if (!implementer) return { status: taskCancelled() ? "cancelled" : "failed" };
        const codeSubtask = plan.subtasks.find((c) => c.kind === "code_change");
        const fixSubtask = buildFixSubtask({
          key: `fix_verify_${verifyIteration + 1}`,
          title: `Address verification failures (iteration ${verifyIteration + 1})`,
          intro: "Static verification reported failures.",
          findings,
          capability: codeSubtask?.capability ?? CAPABILITY.GENERAL,
          order: plan.subtasks.reduce((max, c) => Math.max(max, c.order), 0) + 1,
        });
        plan.subtasks.push(fixSubtask);
        dynamicKeys.add(fixSubtask.key);
        chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
        fixDepthByKey.set(fixSubtask.key, 1);
        await persistDynamic([fixSubtask], "fix");
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "verification.fix_started",
          payload: { iteration: verifyIteration + 1, findings: findings.length },
          level: "warn",
        });
        const fixRun = await runNodes([fixSubtask]);
        if (fixRun.status !== "completed") return { status: taskCancelled() ? "cancelled" : "failed" };
        if (input.approvalMode !== "ask") {
          const fixPaths = state.appliedFilesBySubtask.get(fixSubtask.key) ?? [];
          const fixChanges = fixPaths
            .map((p) => state.fileChanges.get(p))
            .filter((c): c is FileDiff => Boolean(c));
          const applied = await applyStaged(fixChanges, "orchestrator");
          if ("stop" in applied) return { status: taskCancelled() ? "cancelled" : "failed" };
        }
        verifyIteration += 1;
      }
    }
    // Final boundary before completing (plan 013 step 3): a replan
    // requested anywhere earlier in this invocation still wins over
    // "completed".
    {
      const exit = terminalExit();
      if (exit) return exit;
    }
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
  const taskAbort = armTaskAbort(deps.policy);
  const workspacePath = resolveWorkspacePath(deps.workspaceRoot, context.project.workspacePath);
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
