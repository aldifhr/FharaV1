import { normalizeModelTiers } from "@/api/convex/lib/modelTiers";
import type { LlmSelectionMode } from "@/api/convex/lib/llmSelection";
import { withSnapshotScope } from "@/llm/snapshots";
import * as fs from "node:fs/promises";
import { classifyCommand } from "@/orchestrator/classifier";
import { policyForComplexity } from "@/orchestrator/policy";
import { validateStoredPlan } from "@/orchestrator/planValidator";
import { BudgetTracker } from "@/orchestrator/budget";
import { createSharedTaskContext } from "@/orchestrator/taskContext";
import type { GlobalLLMConfig } from "@/llm";
import { LlmConcurrencyGate } from "@/effects/llmCall";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { RunnerDeps } from "./types";
import { buildStateFromDb } from "./state";
import {
  buildTaskLlmResolver,
  mcpForTask,
  webReachForTask,
  resolveQaBaseUrl,
  resolveWorkspacePath,
  seedBudgetFromPersisted,
  toAgentDefinition,
  withFileContexts,
} from "./setup";
import { armTaskAbort } from "./abort";
import {
  budgetReasonFromSummary,
  failStepLimit,
  failTaskWithError,
  finishBudgetExhaustedTask,
  finishCancelledTask,
  findProviderHoldMessage,
  alreadyDoneFiles,
  finishAlreadyDone,
  summaryHasBudgetFailure,
} from "./terminal";
import { postSystemLine } from "./systemLines";
import { finalize } from "./finalize";
import { executePlan } from "./executePlan";
import { releaseAfterPause } from "./pause";
import {
  createBudgetGate,
  createUsageRecorder,
  dynamicSubtaskPersister,
  mcpStatusReporter,
  threadUserAnswers,
} from "./session";

/**
 * Resume a task after its apply approval was resolved: a rejection ends
 * the task as rejected; an approval re-runs the stored plan with the
 * persisted execution state (completed nodes are never redone) and
 * applies the approved changes.
 */
export async function resumeTask(taskId: string, deps: RunnerDeps): Promise<void> {
  // Context Snapshot scope (the project is derived from the task server-side).
  return await withSnapshotScope({ taskId: String(taskId) }, () => resumeTaskScoped(taskId, deps));
}

async function resumeTaskScoped(taskId: string, deps: RunnerDeps): Promise<void> {
  const context = await deps.api.getContext({ taskId });
  if (!context?.project || context.task.status !== "needs_approval") return;
  const approvals = await deps.api.getApprovals({ taskId });
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length > 0) return;
  const applyApprovals = approvals.filter((approval) => approval.kind === "apply_changes");
  if (applyApprovals.length === 0) return;

  if (applyApprovals.some((approval) => approval.status === "rejected")) {
    await postSystemLine(deps, {
      projectId: context.project._id,
      taskId,
      content: "Changes rejected by the user: nothing was applied to the workspace",
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
    ? validateStoredPlan(context.plan.payload, deps.policy.maxSubtasks)
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
  // High/ultra changes keep their larger subtask timeout / deadline on
  // resume (scaled before the deadline is armed below).
  deps = { ...deps, policy: policyForComplexity(deps.policy, classifyCommand(context.task.command).complexity) };
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
  const mcp = mcpForTask(context.mcpServers, workspacePath, deps.policy, mcpStatusReporter(deps));
  // Plan 036: the Agent Reach web tool for read-only agents.
  const webReach = webReachForTask(deps.policy);

  const changes = await deps.api.getFileChanges({ taskId });

  // Resumed tasks resolve LLMs exactly like fresh ones (Phase 2 resolver).
  let llmResolver: TaskLlmResolver;
  let llmConfig: GlobalLLMConfig;
  // Plan 035: the app-wide OpenCode runtime + model (absent = not configured).
  const opencodeCtx = context as { opencodeRuntime?: "api" | "opencode"; opencodeModel?: string };
  const opencodeSettings = opencodeCtx.opencodeRuntime
    ? { runtime: opencodeCtx.opencodeRuntime, model: opencodeCtx.opencodeModel ?? "" }
    : null;
  try {
    llmResolver = await buildTaskLlmResolver(
      context.llmProviders,
      normalizeModelTiers((context.project as { modelTiers?: unknown } | null)?.modelTiers),
      (context as { llmSelectionMode?: LlmSelectionMode }).llmSelectionMode
    );
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
  // wiring (budget + shared context + classification).
  const { state, completedKeys } = buildStateFromDb({
    subtasks: context.subtasks,
    executions: context.executions,
    fileChanges: changes,
    recordedSteps: context.recordedSteps,
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
  // + snapshot extras) with visible failure.
  await seedBudgetFromPersisted({
    deps,
    taskId,
    projectId: context.project._id,
    budget,
  });
  // Pre-call budget gate + usage sink: same contract as processTask.
  const assertBudgetForCall = createBudgetGate(deps, budget, taskId, context.project._id);
  const recordUsage = createUsageRecorder(deps, budget, taskId, context.project._id);
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
      plannerAgent: context.plannerAgent ? toAgentDefinition(context.plannerAgent as Parameters<typeof toAgentDefinition>[0]) : null,
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
      // Plan 035: the app-wide OpenCode runtime + model.
      ...(opencodeSettings
        ? { opencodeRuntime: opencodeSettings.runtime, opencodeModel: opencodeSettings.model }
        : {}),
      onTokenUsage: recordUsage,
      qaBaseUrl: resolveQaBaseUrl(context.project),
      mcp,
      webReach,
      worktree:
        context.task.branchName && persistedWorktree
          ? { branchName: context.task.branchName, worktreePath: persistedWorktree }
          : undefined,
      onDynamicSubtasks: dynamicSubtaskPersister(deps, taskId, context.project._id),
    });

    // EVERY executePlan outcome is handled explicitly (Phase 4
    // hardening). The pre-hardening resume path ran finalize
    // unconditionally, so a failed — or even cancelled — resumed
    // execution could be finalized into "done".
    switch (outcome.status) {
      case "waiting_approval":
        return;
      case "paused":
        // Plan 022: user pause during the resumed execution.
        await releaseAfterPause(deps, taskId, context.project._id);
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
      case "step_limit":
        // Plan 005 Step 5.4 mirrored from processTask.
        await failStepLimit({ deps, taskId, projectId: context.project._id });
        return;
      case "replan": {
        // The engine asked for a re-plan with the objective missing
        // list (plan 013 step 3). resumeTask has no re-plan loop — the
        // replans budget is processTask's — so the resumed run ends
        // failed with the missing list instead of a silent done.
        const missing = outcome.replanFeedback ?? "objective not satisfied";
        // O3 (bug c): a provider hold behind the replan holds the task.
        const held = findProviderHoldMessage([missing, ...state.feedback]);
        await failTaskWithError({
          deps,
          taskId,
          projectId: context.project._id,
          message: held ?? `Objective not satisfied after resume: ${missing}`,
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
        // A no-op (only "No effective change", nothing staged) is done.
        const unchangedFiles = alreadyDoneFiles(state);
        if (unchangedFiles) {
          await finishAlreadyDone({
            deps,
            taskId,
            projectId: context.project._id,
            files: unchangedFiles,
            lifecycle: false,
          });
          return;
        }
        await failTaskWithError({
          deps,
          taskId,
          projectId: context.project._id,
          message: failureSummary,
          lifecycle: false,
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
          // Like processTask: verify where the files landed. With worktree
          // isolation executePlan has merged the task branch into the main
          // workspace and removed the worktree by now, so finalizing in the
          // worktree failed every approved task with "disk-verification:
          // ENOENT" after its change had already been merged.
          workspacePath: resolveWorkspacePath(deps.workspaceRoot, context.project.workspacePath),
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
