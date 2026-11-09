import * as fs from "node:fs/promises";
import type { WorkerRunAgent, WorkerTask } from "@/workerApi";
import type { SubtaskKind } from "@/types";
import { classifyCommand } from "@/orchestrator/classifier";
import { policyForComplexity } from "@/orchestrator/policy";
import { validateStoredPlan } from "@/orchestrator/planValidator";
import { BudgetTracker } from "@/orchestrator/budget";
import { createSharedTaskContext } from "@/orchestrator/taskContext";
import type { GlobalLLMConfig } from "@/llm";
import { LlmConcurrencyGate } from "@/effects/llmCall";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { RunnerDeps, RunState } from "./runner/types";
import { buildStateFromDb } from "./runner/state";
import {
  buildTaskLlmResolver,
  mcpForTask,
  resolveQaBaseUrl,
  resolveWorkspacePath,
  seedBudgetFromPersisted,
  toAgentDefinition,
  withFileContexts,
} from "./runner/setup";
import { armTaskAbort } from "./runner/abort";
import {
  budgetReasonFromSummary,
  failStepLimit,
  failTaskWithError,
  finishBudgetExhaustedTask,
  finishCancelledTask,
  isTerminalTaskStatus,
  summaryHasBudgetFailure,
} from "./runner/terminal";
import { finalize } from "./runner/finalize";
import { executePlan } from "./runner/executePlan";
import { createInitialPlan, type PlanningContext } from "./runner/planning";
import { replanOnce, type ReplanLoopState } from "./runner/replan";
import { planReviewGate } from "./runner/planReview";
import {
  createBudgetGate,
  createUsageRecorder,
  dynamicSubtaskPersister,
  mcpStatusReporter,
  threadUserAnswers,
} from "./runner/session";

// Public surface of `@/services/taskRunner`: the task lifecycle entry
// points (processTask / resumeTask) plus re-exports tests and
// `src/index.ts` import. The stages live in `./runner/*`:
//   planning.ts     initial plan (authoritative / legacy) + planner calls
//   replan.ts       replanOnce — the ONE bounded re-plan path
//   executePlan.ts  stage driver (DAG → review → apply → verify → QA → merge)
//   runContext.ts   per-invocation RunContext (latches, closures, applyStaged)
//   applyStage.ts   approval request, permission broker, worktree commit/merge
//   resume.ts       resumeTask (post-approval)
//   session.ts      budget gate, usage sink, MCP status, dynamic-subtask sink
//   terminal.ts     terminal endings (cancelled / budget / failed / step limit)
export { buildStateFromDb, carryForwardState } from "./runner/state";
export { resolveQaBaseUrl } from "./runner/setup";
export { resumeTask } from "./runner/resume";
export type { ExecutePlanResult } from "./runner/executePlan";
export type { RunnerDeps, RunState } from "./runner/types";

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
  const mcp = mcpForTask(context.mcpServers, workspacePath, deps.policy, mcpStatusReporter(deps));

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
  const runAgents = (agents as WorkerRunAgent[])
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
  // High/ultra changes run under the larger subtask timeout / deadline.
  deps = { ...deps, policy: policyForComplexity(deps.policy, classification.complexity) };
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.classified",
    payload: {
      kind: classification.kind,
      strategy: classification.strategy,
      reasons: classification.reasons,
      ...(classification.complexity ? { complexity: classification.complexity } : {}),
      ...(classification.concerns ? { concerns: classification.concerns.map((c) => c.category) } : {}),
      subtaskTimeoutMs: deps.policy.subtaskTimeoutMs,
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
  const assertBudgetForCall = createBudgetGate(deps, budget, task._id, project._id);
  const recordUsage = createUsageRecorder(deps, budget, task._id, project._id);
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
      // Keep the threaded user input: writing [] here erased persisted
      // user_answer decisions before the run's first prompt (M9).
      decisions: sharedContext.decisions,
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
  // tasks never share it and never resize each other's bound. The task
  // deadline is armed NOW, before planning, so a slow planner runs under
  // the deadline and a task cancelled during planning never executes a
  // fresh plan.
  const llmTaskGate = new LlmConcurrencyGate(deps.policy.maxConcurrentLLMCalls);
  const taskAbort = armTaskAbort(deps.policy, deps.shutdownSignal);
  const signal = taskAbort.controller.signal;
  const cancel = () => finishCancelledTask({ deps, task, project, signal });
  const fail = (message: string) =>
    failTaskWithError({ deps, taskId: task._id, projectId: project._id, message });

  try {
    const pctx: PlanningContext = {
      deps,
      task,
      project,
      command,
      agents: runAgents,
      plannerAgent: context.plannerAgent
        ? toAgentDefinition(context.plannerAgent as WorkerRunAgent)
        : null,
      plannerFallbackReason: context.plannerFallbackReason ?? null,
      classification,
      budget,
      sharedContext,
      llmConfig,
      llmResolver,
      recordUsage,
      assertBudgetForCall,
      signal,
      llmTaskGate,
    };
    // Plan Inspector "Replan with note": the user discarded the plan under
    // review; plan afresh with the note as planner feedback (the next
    // saved planner version clears the note).
    const replanNote = (context.task as { planReviewNote?: string }).planReviewNote?.trim() || undefined;
    const stored =
      context.plan && !replanNote ? validateStoredPlan(context.plan.payload, deps.policy.maxSubtasks) : null;
    if (stored && !stored.ok && context.plan?.createdBy === "user") {
      // A user-edited version that no longer validates is never executed:
      // a fresh plan is made and (when review applies) reviewed again.
      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "plan.user_version_invalid",
        payload: { version: context.plan.version, errors: stored.errors.slice(0, 10) },
        level: "warn",
      });
    }
    const storedPlan = stored?.ok && stored.plan ? stored.plan : null;
    const initial = await createInitialPlan(pctx, storedPlan, context.plan, replanNote);
    if (!initial) return;

    // Plan Inspector: pause after plan.created for the user's review when
    // the project setting applies. Approval re-queues the task; this run
    // then adopts the approved stored plan and passes the gate.
    const review = await planReviewGate({
      deps,
      task: context.task,
      project,
      planVersion: initial.planVersion,
      classification,
      executionStarted:
        (context.executions ?? []).length > 0 ||
        (context.subtasks ?? []).some((subtask: { status: string }) => subtask.status !== "pending"),
    });
    if (review === "paused") return;

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
    const loop: ReplanLoopState = {
      plan: initial.plan,
      planVersion: initial.planVersion,
      replans: task.replanCount ?? 0,
      feedback: undefined,
      completedKeys: seeded?.completedKeys ?? new Set<string>(),
    };
    // Spec §7 vocabulary: maxPlanningIterations is the single bound on
    // planning iterations; it aliases maxReplans in loadPolicy and falls
    // back to it for hand-built policies that omit the alias.
    const maxPlanningIterations =
      deps.policy.maxPlanningIterations ?? deps.policy.maxReplans;
    const canReplan = () => loop.replans < maxPlanningIterations;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "executing", planVersion: loop.planVersion },
      });

      const outcome = await executePlan({
        deps,
        task,
        project,
        workspacePath,
        agents: runAgents,
        plan: loop.plan,
        planVersion: loop.planVersion,
        state,
        feedback: loop.feedback,
        approvalMode,
        completedKeys: loop.completedKeys,
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
        onDynamicSubtasks: dynamicSubtaskPersister(deps, task._id, project._id),
      });

      // ask_user pause (plan 013 step 4): the backend already holds the
      // question in `waiting_input`; this invocation just ends. The
      // user's answer re-queues the task for a fresh worker claim.
      if (outcome.status === "waiting_approval" || outcome.status === "waiting_input") return;

      // Plan 005 Step 5.4: the decision step bound is terminal.
      if (outcome.status === "step_limit") {
        await failStepLimit({ deps, taskId: task._id, projectId: project._id });
        return;
      }

      // Cancellation is terminal (Phase 4 hardening): a cancelled or
      // timed-out task ends here — never replanned, finalized, or done.
      if (outcome.status === "cancelled") {
        await cancel();
        return;
      }

      // Engine replan (plan 013 step 3): the decision engine requested a
      // re-plan with the objective missing list as feedback. Bounded by
      // the same replans budget as the verification/execution replans;
      // exhaustion fails the task with the missing list, never a
      // silent done. Cancellation still wins (checked above).
      if (outcome.status === "replan") {
        const missing = outcome.replanFeedback ?? "objective not satisfied";
        if (canReplan()) {
          const result = await replanOnce(pctx, loop, state, {
            reason: `Objective not satisfied: ${missing}`,
          });
          if (result === "ended") return;
          continue;
        }
        await fail(`Objective not satisfied after ${loop.replans} replan(s): ${missing}`);
        return;
      }

      if (outcome.status === "completed") {
        const after = await deps.api.getContext({ taskId: task._id });
        // Terminal guard (Phase 4 hardening): the cancellation may have
        // landed while the scheduler was finishing its last node (or the
        // task row already turned terminal by another path). A cancelled
        // task must not be finalized into "done".
        if (signal.aborted || isTerminalTaskStatus(after?.task.status)) {
          await cancel();
          return;
        }
        const verification = await finalize({
          deps,
          task,
          project,
          // Apply writes to the main workspace; verify where the files
          // actually landed. runVerification + evaluateTask both read
          // input.workspacePath, so this single change aligns both.
          workspacePath: resolveWorkspacePath(deps.workspaceRoot, project.workspacePath),
          plan: loop.plan,
          planVersion: loop.planVersion,
          agents: runAgents,
          subtasks: after?.subtasks ?? [],
          state,
          openIssues: sharedContext.outstandingIssues,
          signal,
        });
        if (verification.verdict === "failed" && canReplan()) {
          // No replan after cancellation/deadline (Phase 4 hardening).
          if (signal.aborted) {
            await cancel();
            return;
          }
          const result = await replanOnce(pctx, loop, state, {
            reason: `Verification failed: ${verification.checks
              .filter((check) => check.status === "failed")
              .map((check) => `${check.name}: ${check.details ?? ""}`)
              .join("; ")}`,
          });
          if (result === "ended") return;
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
      if (signal.aborted) {
        await cancel();
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
      if (canReplan()) {
        const result = await replanOnce(pctx, loop, state, {
          reason: failureSummary,
          eventFeedback: failureSummary,
          timedOutFrom: failureSummary,
        });
        if (result === "ended") return;
        continue;
      }
      await fail(failureSummary);
      return;
    }
  } finally {
    taskAbort.dispose();
  }
}

export type { SubtaskKind };
