import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkerApi } from "@/workerApi";
import type {
  WorkerAgent,
  WorkerExecutionId,
  WorkerFileChange,
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
import { createPlan, heuristicPlan } from "@/orchestrator/planner";
import { validatePlan } from "@/orchestrator/planValidator";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import { BudgetTracker } from "@/orchestrator/budget";
import { createOrchestratorPlan, evaluateAfterExecution } from "@/orchestrator/orchestrator";
import {
  createSharedTaskContext,
  appendExecution,
  normalizeFindings,
  type AgentResult,
  type SharedTaskContext,
} from "@/orchestrator/taskContext";
import type { Classification } from "@/orchestrator/types";
import type { GlobalLLMConfig } from "@/llm";
import type { FallbackHandle } from "@/effects/llmCall";
import {
  materializePool,
  TaskLlmResolver,
  type PoolConnectionRow,
} from "@/llm/resolver";
import { providerHealth } from "@/llm/health";
import { routeCapability, capabilitiesOf } from "@/orchestrator/capabilities";
import {
  buildReviewFixSubtask,
  collectRequestedChanges,
  formatReviewFindings,
} from "@/orchestrator/reviewLoop";
import type { ReviewResult } from "@/utils/json";
import { executeSubtask } from "@/execution/agentExecutor";
import { WebClient, type WebClientConfig } from "@/tools/webClient";
import { runVerification } from "@/execution/verification";
import {
  runScheduler,
  type NodeOutcome,
  type SchedulerResult,
} from "@/scheduler/dagScheduler";
import {
  evaluateTask,
  type EvaluationCheck,
  type EvaluationResult,
} from "@/orchestrator/evaluator";
import {
  applyFileChange,
  hashContent,
  type FileDiff,
} from "@/tools/gitDiff";

export interface RunnerDeps {
  api: WorkerApi;
  workerId: string;
  policy: ExecutionPolicy;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
}

interface RunState {
  priorOutputs: Map<string, string>;
  qaVerdicts: Record<string, "passed" | "failed" | "inconclusive">;
  reviewVerdicts: Record<string, ReviewResult>;
  fileChanges: Map<string, FileDiff>;
  feedback: string[];
}

/**
 * Build the per-task LLM resolver from the DB provider pool (Settings
 * page). The pool rows carry only ENCRYPTED keys; materializePool decrypts
 * them with the worker's PROVIDER_ENCRYPTION_KEY (or reads the env var a
 * connection names via apiKeyEnv). A decryption failure is a hard error
 * naming the provider — the caller fails the task with it rather than
 * silently calling an LLM with the wrong credential.
 *
 * Each agent then resolves independently (assignment → fallback
 * assignment → pool by priority/weight, circuit-open connections
 * excluded) — replacing the old single `llmProviders[0]` task config.
 */
async function buildTaskLlmResolver(
  llmProviders: PoolConnectionRow[] | undefined
): Promise<TaskLlmResolver> {
  const pool = await materializePool(llmProviders);
  return new TaskLlmResolver(pool, providerHealth);
}

/**
 * Stagehand (live browser) model + key, derived from the task's resolved
 * default LLM config — threaded explicitly into WebClient so the browser
 * tool follows the same provider resolution as every other LLM consumer
 * instead of reading shared process.env values.
 */
function stagehandConfigFrom(
  llmConfig: GlobalLLMConfig | undefined
): { stagehandModelName?: WebClientConfig["stagehandModelName"]; stagehandApiKey?: string } {
  if (!llmConfig?.apiKey) return {};
  const family = llmConfig.provider.toLowerCase() === "anthropic" ? "anthropic" : "openai";
  return {
    stagehandModelName: `${family}/${llmConfig.model}` as WebClientConfig["stagehandModelName"],
    stagehandApiKey: llmConfig.apiKey,
  };
}

/**
 * QA base URL fallback captured ONCE per worker process (memoized on first
 * task, after dotenv has loaded). Per-task URLs come from the project; this
 * is only the fallback for projects without qaUrl/devUrl. Reading it once —
 * and never writing process.env.QA_BASE_URL — is what removes the race where
 * concurrent tasks overwrote each other's QA target (spec §8).
 */
let qaEnvFallbackCache: string | undefined | null = null;
function qaEnvFallback(): string | undefined {
  if (qaEnvFallbackCache === null) {
    qaEnvFallbackCache = process.env.QA_BASE_URL;
  }
  return qaEnvFallbackCache;
}

/**
 * Resolve the QA base URL for one task: project.qaUrl > project.devUrl >
 * worker-start env fallback. Returns undefined when none is configured, in
 * which case qa.ts applies its own default.
 */
export function resolveQaBaseUrl(
  project: { qaUrl?: string | null; devUrl?: string | null },
  envFallback: string | undefined = qaEnvFallback()
): string | undefined {
  return project.qaUrl ?? project.devUrl ?? envFallback;
}

/** Build the orchestrator's AgentResult view of a finished scheduler node. */
function toAgentResult(input: {
  subtask: PlanSubtask;
  agent: AgentDefinition;
  outcome: NodeOutcome;
}): AgentResult {
  const meta =
    input.outcome.status === "completed"
      ? (input.outcome.meta as
          | {
              delegationRecommendation?: AgentResult["delegationRecommendation"];
              findings?: unknown;
            }
          | undefined)
      : undefined;
  return {
    agentId: input.agent._id,
    agentName: input.agent.name,
    capability: input.subtask.capability,
    success: input.outcome.status === "completed",
    summary: (input.outcome.status === "completed"
      ? input.outcome.output ?? ""
      : input.outcome.status === "failed"
        ? input.outcome.error
        : ""
    ).slice(0, 500),
    findings: normalizeFindings(meta?.findings),
    delegationRecommendation: meta?.delegationRecommendation,
    meta:
      input.outcome.status === "completed"
        ? (input.outcome.meta as Record<string, unknown> | undefined)
        : undefined,
  };
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

  let branchName: string | undefined;
  let worktreePath: string | undefined;

  // Create isolated git worktree for this task (if repo is a git directory)
  try {
    const branch = await deps.api.createBranch({ taskId: task._id, projectId: project._id });
    branchName = branch.branchName;
    worktreePath = branch.worktreePath;
    if (worktreePath) workspacePath = worktreePath;
    await fs.mkdir(workspacePath, { recursive: true });
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "branch.created",
      payload: { branchName, worktreePath },
      level: "info",
    });
  } catch (err: any) {
    // If worktree creation fails (not a git repo, etc.), fall back to main workspace
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "branch.creation_skipped",
      payload: { reason: err.message },
      level: "warn",
    });
  }

  const runAgents = agents.map(toAgentDefinition);
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
  // made before a worker restart) so limits apply to the task as a whole.
  try {
    const priorUsage = await deps.api.getTaskTokenUsage?.({ taskId: task._id });
    if (priorUsage && priorUsage.calls > 0) budget.seed(priorUsage);
  } catch {
    // Seeding is best-effort; a fresh tracker is the safe fallback.
  }
  // Single usage sink: feeds the budget tracker AND the persisted
  // tokenUsage table, used by the planner and every subtask callback.
  const recordUsage = async (
    inputTokens: number,
    outputTokens: number,
    model: string,
    agentName: string,
    agentId?: string
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
    })
    ?.catch(() => undefined);
  await deps.api.recordLifecycle?.({ taskId: task._id, projectId: project._id, state: "RUNNING" })?.catch(() => undefined);
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

  let plan: ExecutionPlan;
  let createdBy: "orchestrator" | "fallback" = "fallback";
  let planVersion: number;

  const stored = context.plan ? validatePlan(context.plan.payload, deps.policy.maxSubtasks) : null;
  if (stored?.ok && stored.plan) {
    plan = stored.plan;
    createdBy = context.plan!.createdBy;
    planVersion = context.plan!.version;
  } else {
    const created = await createPlan({
      command,
      classification,
      agents: runAgents,
      policy: deps.policy,
      llmConfig,
      llmResolver,
      onTokenUsage: recordUsage,
    });
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
    await persistPlan(deps, {
      taskId: task._id,
      projectId: project._id,
      plan,
      version: planVersion,
      createdBy,
      classification: classification.kind,
    });
  }

  const state: RunState = {
    priorOutputs: new Map(),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(),
    feedback: [],
  };

  let replans = task.replanCount ?? 0;
  let feedback: string | undefined;

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
      state,
      feedback,
      approvalMode,
      completedKeys: new Set<string>(),
      budget,
      sharedContext,
      classification,
      llmConfig,
      llmResolver,
      qaBaseUrl,
    });

    if (outcome === "waiting_approval") return;

    if (outcome === "completed") {
      const after = await deps.api.getContext({ taskId: task._id });
      const verification = await finalize({
        deps,
        task,
        project,
        workspacePath,
        plan,
        planVersion,
        subtasks: after?.subtasks ?? [],
        state,
      });
      if (verification.verdict === "failed" && replans < deps.policy.maxReplans) {
        replans += 1;
        feedback = `Verification failed: ${verification.checks
          .filter((check) => check.status === "failed")
          .map((check) => `${check.name}: ${check.details ?? ""}`)
          .join("; ")}`;
        const replanned = await createPlan({
          command,
          classification,
          agents: runAgents,
          policy: deps.policy,
          feedback,
          llmConfig,
          llmResolver,
          onTokenUsage: recordUsage,
        });
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
        state.priorOutputs.clear();
        state.fileChanges.clear();
        state.qaVerdicts = {};
        state.feedback = [];
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

    // Execution failed before any approval.
    const failureSummary =
      state.feedback.join("; ") || "Execution failed without a detailed error";
    if (replans < deps.policy.maxReplans) {
      replans += 1;
      feedback = failureSummary;
      const replanned = await createPlan({
        command,
        classification,
        agents: runAgents,
        policy: deps.policy,
        feedback,
        llmConfig,
        llmResolver,
        onTokenUsage: recordUsage,
      });
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
      state.priorOutputs.clear();
      state.fileChanges.clear();
      state.qaVerdicts = {};
      state.feedback = [];
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
  /** Orchestrator wiring (processTask only; resumeTask runs without it). */
  budget?: BudgetTracker;
  sharedContext?: SharedTaskContext;
  classification?: Classification;
  llmConfig?: GlobalLLMConfig;
  /** Per-agent LLM resolver (Phase 2); executors resolve their own agent's chain from it. */
  llmResolver?: TaskLlmResolver;
  /** Per-task QA base URL (project qaUrl > devUrl > env fallback), threaded to the QA executor. */
  qaBaseUrl?: string;
}): Promise<"completed" | "failed" | "waiting_approval"> {
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
  if (implementationNodes.length === 0 && reviewNodes.length === 0 && qaNodes.length === 0) {
    return "failed";
  }

  const executionIds = new Map<string, WorkerExecutionId>();
  const agentByKey = new Map<string, AgentDefinition>();
  const taskId = task._id;

  const assign = (key: string): AgentDefinition | null => {
    const existing = agentByKey.get(key);
    if (existing) return existing;
    const subtask = plan.subtasks.find((candidate) => candidate.key === key);
    if (!subtask) return null;
    const agent = routeCapability(subtask.capability, input.agents);
    if (agent) agentByKey.set(key, agent);
    return agent;
  };

  let lastStatusCheck = 0;
  let cancelled = false;

  const runNodes = (nodes: PlanSubtask[]): Promise<SchedulerResult> => {
    const subsetKeys = new Set(nodes.map((node) => node.key));
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
      if (input.completedKeys.has(node.id)) {
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
        qaBaseUrl: input.qaBaseUrl,
        taskContext: input.sharedContext,
        priorOutputs: state.priorOutputs,
        fileChanges: Array.from(state.fileChanges.values()),
        signal,
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
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type: "fileChanges.updated",
            payload: { filePaths: [change.filePath] },
            executionId,
            subtaskKey: node.id,
          });
        },
        onTokenUsage: async (inputTokens, outputTokens, model) => {
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
            });
          }
        },
      });
    },
    {
      maxConcurrency: Math.min(plan.maxConcurrency, deps.policy.maxConcurrency),
      timeoutMs: deps.policy.subtaskTimeoutMs,
      retries: deps.policy.subtaskRetries,
      shouldCancel: async () => {
        const now = Date.now();
        if (now - lastStatusCheck < 1500) return cancelled;
        lastStatusCheck = now;
        const current = await deps.api.getContext({ taskId });
        cancelled =
          !current ||
          current.task.status === "failed" ||
          current.task.status === "done" ||
          current.task.status === "rejected";
        return cancelled;
      },
      onStart: async (node, attempt) => {
        if (input.completedKeys.has(node.id)) return;
        const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
        const agent = assign(node.id);
        if (!agent) throw new Error(`No enabled agent for capability ${subtask.capability}`);
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
        if (!input.completedKeys.has(node.id) && executionId) {
          await deps.api.updateExecution({
            executionId,
            subtaskKey: node.id,
            status: outcome.status === "completed" ? "completed" : "failed",
            output: outcome.status === "failed" ? undefined : outcome.output,
            error: outcome.status === "failed" ? outcome.error : undefined,
            meta: outcome.status === "failed" ? undefined : outcome.meta,
          });
        }
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
        }
        // Intelligent orchestrator: evaluate every finished subtask, keep
        // the shared context current for the agents that run next, and
        // persist the decision trail. Advisory only — the DAG, the review
        // loop and the evaluator keep their existing behavior, and any
        // orchestrator failure is logged, never propagated.
        if (input.budget && input.sharedContext && input.classification && agent) {
          try {
            const subtaskDef = plan.subtasks.find((candidate) => candidate.key === node.id);
            if (subtaskDef) {
              const evaluation = evaluateAfterExecution({
                result: toAgentResult({ subtask: subtaskDef, agent, outcome }),
                classification: input.classification,
                agents: input.agents,
                budget: input.budget,
                previousAgents: input.sharedContext.agentExecutions.map(
                  (entry) => entry.agentName
                ),
                delegationDepth: input.budget.currentDelegationDepth,
                alreadyDelegated: input.sharedContext.decisions
                  .filter((decision) => decision.decision === "APPROVE")
                  .map((decision) => decision.capability)
                  .filter((capability): capability is string => Boolean(capability)),
                taskContext: input.sharedContext,
              });
              input.sharedContext.decisions = evaluation.updatedContext.decisions;
              input.sharedContext.artifacts = evaluation.updatedContext.artifacts;
              input.sharedContext.outstandingIssues =
                evaluation.updatedContext.outstandingIssues;
              input.sharedContext.agentExecutions =
                evaluation.updatedContext.agentExecutions;

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
          return;
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
      },
      onBlocked: async (node, reason) => {
        await deps.api.updateSubtask({
          taskId,
          key: node.id,
          status: "blocked",
          error: reason,
        });
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
  const runReviewLoop = async (): Promise<boolean> => {
    if (reviewNodes.length === 0) return true;

    const maxIterations = deps.policy.maxReviewIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      for (const key of reviewNodeKeys) delete state.reviewVerdicts[key];

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

  const implementation = await runNodes(implementationNodes);
  if (implementation.status === "cancelled") {
    await deps.api
      .updateSubtask({
        taskId,
        key: implementationNodes[0]?.key ?? reviewNodes[0]?.key ?? qaNodes[0]?.key ?? "unknown",
        status: "blocked",
      })
      .catch(() => undefined);
    return "failed";
  }
  if (implementation.status !== "completed") {
    return "failed";
  }

  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  if (hasCodeChange && state.fileChanges.size === 0) {
    state.feedback.push("The implementation produced no file changes");
    return "failed";
  }

  const reviewApproved = await runReviewLoop();
  if (!reviewApproved) {
    return "failed";
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
      return "failed";
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
      },
      requestedByAgentId: implementer?._id,
      planVersion: plan.version,
    });
    await deps.api.appendAgentMessage({
      projectId: project._id,
      taskId,
      agentId: implementer?._id,
      content: `Changes are prepared and verified. ${summary}. Waiting for your approval before writing them to the workspace.`,
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
    return "waiting_approval";
  }

  if (preparedChanges.length > 0) {
    const wp = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
    const appliedPaths: string[] = [];
    for (const change of preparedChanges) {
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
        return "failed";
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
        actor: input.approvalResolved ? "user" : "orchestrator",
        tool: "apply_changes",
        action: "apply",
        decision: "allowed",
        target: appliedPaths.join(","),
        details: { filePaths: appliedPaths, planVersion: plan.version },
      });
      if (input.approvalResolved) {
        await deps.api.appendAgentMessage({
          projectId: project._id,
          taskId,
          content: `Approved changes applied to ${appliedPaths.length} file(s). Running verification.`,
        });
      }
    }
  }

  if (qaNodes.length > 0) {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "verifying", files: preparedChanges.length },
    });
    const qa = await runNodes(qaNodes);
    if (qa.status === "cancelled") {
      return "failed";
    }
    // QA failures are recorded on the subtasks; the evaluator decides the verdict.
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return "completed";
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
  const workspacePath = resolveWorkspacePath(deps.workspaceRoot, context.project.workspacePath);
  await fs.mkdir(workspacePath, { recursive: true });

  const changes = await deps.api.getFileChanges({ taskId });

  // Resumed tasks resolve LLMs exactly like fresh ones (Phase 2 resolver).
  let llmResolver: TaskLlmResolver;
  let llmConfig: GlobalLLMConfig;
  try {
    llmResolver = await buildTaskLlmResolver(context.llmProviders);
    llmConfig = llmResolver.defaultConfig();
  } catch (error) {
    await deps.api.completeTask({
      taskId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const agents = context.agents.map(toAgentDefinition);
  const completedKeys = new Set(
    context.subtasks
      .filter((subtask) => subtask.status === "completed")
      .map((subtask) => subtask.key)
  );
  const state: RunState = {
    priorOutputs: new Map(
      context.subtasks
        .filter((subtask) => subtask.status === "completed" && subtask.output)
        .map((subtask) => [subtask.key, subtask.output as string])
    ),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(
      changes.map((change) => [change.filePath, toFileDiff(change)])
    ),
    feedback: [],
  };

  const outcome = await executePlan({
    deps,
    task: context.task,
    project: context.project,
    workspacePath,
    agents,
    plan,
    state,
    approvalResolved: true,
    approvalMode: context.approvalMode,
    completedKeys,
    llmConfig,
    llmResolver,
    qaBaseUrl: resolveQaBaseUrl(context.project),
  });
  if (outcome === "waiting_approval") return;

  const after = await deps.api.getContext({ taskId });
  await finalize({
    deps,
    task: context.task,
    project: context.project,
    workspacePath,
    plan,
    planVersion,
    subtasks: after?.subtasks ?? [],
    state,
  });
}

async function mergeApprovalResolved(
  deps: RunnerDeps,
  task: WorkerTask,
  project: WorkerProject,
  branchName?: string,
  worktreePath?: string
): Promise<boolean> {
  let attempt = 0;
  const maxAttempts = 480; // ~12 min at 1.5s interval
  while (attempt < maxAttempts) {
    const approvals = await deps.api.getApprovals({ taskId: task._id });
    const pending = approvals.filter(
      (a) => a.kind === "merge_pr" && a.status === "pending"
    );
    if (pending.length === 0) {
      const resolved = approvals.find((a) => a.kind === "merge_pr");
      if (resolved?.status === "approved") {
        if (branchName && worktreePath) {
          try {
            await deps.api.mergeBranch({ taskId: task._id });
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "branch.merged",
              payload: { branchName },
              level: "info",
            });
          } catch (err: any) {
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "branch.merge_failed",
              payload: { error: err.message },
              level: "error",
            });
            await deps.api.completeTask({
              taskId: task._id,
              status: "failed",
              errorMessage: `Merge failed: ${err.message}`,
            });
            return false;
          }
        }
        await deps.api.recordAudit({
          taskId: task._id,
          projectId: project._id,
          workerId: deps.workerId,
          actor: "user",
          tool: "merge_pr",
          action: "approve",
          decision: "allowed",
        });
        await deps.api.completeTask({ taskId: task._id, status: "done" });
        return true;
      } else if (resolved?.status === "rejected") {
        if (branchName && worktreePath) {
          await deps.api.discardBranch({ taskId: task._id });
          await deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "branch.discarded",
            payload: { branchName },
            level: "warn",
          });
        }
        await deps.api.recordAudit({
          taskId: task._id,
          projectId: project._id,
          workerId: deps.workerId,
          actor: "user",
          tool: "merge_pr",
          action: "reject",
          decision: "denied",
        });
        await deps.api.appendAgentMessage({
          projectId: project._id,
          taskId: task._id,
          content: "Changes were rejected by the user. Branch has been discarded.",
        });
        await deps.api.completeTask({
          taskId: task._id,
          status: "rejected",
          errorMessage: "Changes rejected by user",
        });
        return false;
      }
    }
    await sleep(1500);
    attempt++;
  }
  await deps.api.completeTask({
    taskId: task._id,
    status: "failed",
    errorMessage: "Approval timed out",
  });
  return false;
}

async function finalizeRecordEval(
  deps: RunnerDeps,
  input: {
    taskId: string;
    projectId: string;
    planVersion: number;
    evaluation: EvaluationResult;
  }
): Promise<void> {
  await deps.api.recordEvaluation({
    taskId: input.taskId,
    projectId: input.projectId,
    planVersion: input.planVersion,
    verdict: input.evaluation.verdict,
    checks: input.evaluation.checks,
    notes: input.evaluation.notes.join("; ") || undefined,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finalize(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  workspacePath: string;
  plan: ExecutionPlan;
  planVersion: number;
  subtasks: WorkerSubtask[];
  state: RunState;
}): Promise<EvaluationResult> {
  const { deps, task, project, planVersion, state, plan } = input;
  const applyApprovals = await deps.api.getApprovals({ taskId: task._id });
  const hasApprovalPlan = applyApprovals.some(
    (approval) => approval.kind === "apply_changes" && approval.status === "approved"
  );
  const changes = await deps.api.getFileChanges({ taskId: task._id });

  const appliedChanges = changes.filter((change) => change.appliedAt);
  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  let verificationChecks: EvaluationCheck[] | undefined;

  if (deps.policy.verificationEnabled && hasCodeChange && appliedChanges.length > 0) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "static-verification", files: appliedChanges.length },
    });

    const verification = await runVerification({
      workspacePath: input.workspacePath,
      changedFiles: appliedChanges.map((change) => change.filePath),
      includeBuild: deps.policy.verificationIncludeBuild,
      timeoutMs: deps.policy.verificationTimeoutMs,
      onCheck: async (check) => {
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "task.check",
          payload: {
            label: `verify:${check.name}`,
            status: check.status,
            details: check.details,
          },
        });
      },
    });

    verificationChecks = verification.checks;
  }

  const evaluation = await evaluateTask({
    workspacePath: input.workspacePath,
    subtasks: input.subtasks.map((subtask) => ({
      key: subtask.key,
      kind: subtask.kind,
      status: subtask.status,
      error: subtask.error,
    })),
    fileChanges: changes.map((change) => ({
      filePath: change.filePath,
      changeType: change.changeType,
      newContentHash: change.newContentHash,
      newContent: change.newContent,
      appliedAt: change.appliedAt,
    })),
    hasApprovalPlan: hasApprovalPlan || plan.requiresApproval,
    qaVerdicts: state.qaVerdicts,
    verificationChecks,
  });

  await deps.api.recordEvaluation({
    taskId: task._id,
    projectId: project._id,
    planVersion,
    verdict: evaluation.verdict,
    checks: evaluation.checks,
    notes: evaluation.notes.join("; ") || undefined,
  });

  const details = evaluation.checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.name} (${check.status}): ${check.details ?? ""}`)
    .join("; ");

  if (evaluation.verdict === "failed") {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.error",
      payload: { message: details || "Evaluation failed" },
      level: "error",
    });
    await deps.api.completeTask({
      taskId: task._id,
      status: "failed",
      errorMessage: details || "Evaluation failed",
    });
    return evaluation;
  }

  const message =
    evaluation.verdict === "inconclusive"
      ? `Task finished, but verification is inconclusive: ${details || "not all checks were performed"}.`
      : "Task completed and verified.";
  await deps.api.appendAgentMessage({
    projectId: project._id,
    taskId: task._id,
    content: message,
  });
  await deps.api.completeTask({ taskId: task._id, status: "done" });
  return evaluation;
}

async function persistPlan(
  deps: RunnerDeps,
  input: {
    taskId: string;
    projectId: string;
    plan: ExecutionPlan;
    version: number;
    createdBy: "orchestrator" | "fallback";
    classification: string;
  }
): Promise<void> {
  await deps.api.setPlanning({
    taskId: input.taskId,
    classification: input.classification,
    strategy: input.plan.strategy,
    planVersion: input.version,
  });
  await deps.api.savePlan({
    taskId: input.taskId,
    projectId: input.projectId,
    version: input.version,
    strategy: input.plan.strategy,
    createdBy: input.createdBy,
    goal: input.plan.goal,
    payload: input.plan,
    subtasks: input.plan.subtasks,
  });
}

async function dryRunPolicy(
  changes: FileDiff[],
  deps: RunnerDeps,
  task: WorkerTask,
  project: WorkerProject,
  plan: ExecutionPlan,
  planVersion: number,
  state: RunState
): Promise<{ allowed: boolean; summary: { filePaths: string[]; count: number; changes: string[] } }> {
  const normalized = changes.map((change) => normalizeFileChangePath(change.filePath)).filter(Boolean);
  const forbidden = normalized.filter((filePath) => isForbiddenFilePath(filePath));
  const filePaths = changes.map((change) => change.filePath);
  const summary = {
    filePaths,
    count: changes.length,
    changes: changes.map((change) => `${change.changeType}:${change.filePath}`),
  };

  if (forbidden.length > 0) {
    state.feedback.push(`Policy denied protected paths: ${forbidden.join(", ")}`);
    await deps.api.recordAudit({
      taskId: task._id,
      projectId: project._id,
      workerId: deps.workerId,
      actor: "orchestrator",
      tool: "apply_changes",
      action: "dry-run",
      decision: "denied",
      target: forbidden.join(","),
      details: { reason: "file-path-forbidden", planVersion },
    });
    return { allowed: false, summary };
  }

  await deps.api.recordAudit({
    taskId: task._id,
    projectId: project._id,
    workerId: deps.workerId,
    actor: "orchestrator",
    tool: "apply_changes",
    action: "dry-run",
    decision: "allowed",
    target: filePaths.join(","),
    details: { count: changes.length, planVersion },
  });
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.policy_dry_run",
    payload: { allowed: true, files: changes.length },
  });
  return { allowed: true, summary };
}

function normalizeFileChangePath(filePath: string): string {
  return filePath.replace(/\\\\/g, "/").replace(/^\/+/, "");
}

function isForbiddenFilePath(filePath: string): boolean {
  const normalized = normalizeFileChangePath(filePath).toLowerCase();
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.startsWith(".git/") ||
    normalized.includes("/.git/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/") ||
    normalized === "package-lock.json" ||
    normalized.endsWith("/package-lock.json") ||
    normalized === "pnpm-lock.yaml" ||
    normalized.endsWith("/pnpm-lock.yaml") ||
    normalized === "yarn.lock" ||
    normalized.endsWith("/yarn.lock") ||
    normalized.startsWith(".ssh/") ||
    normalized.includes("/.ssh/")
  );
}

function implementerAgent(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): AgentDefinition | null {
  const codeSubtask = plan.subtasks.find((subtask) => subtask.kind === "code_change");
  if (codeSubtask) return routeCapability(codeSubtask.capability, agents);
  return routeCapability(CAPABILITY.GENERAL, agents);
}

function toFileDiff(change: WorkerFileChange): FileDiff {
  return {
    filePath: change.filePath,
    changeType: change.changeType,
    oldContent: change.oldContent,
    newContent: change.newContent,
    oldContentHash: change.oldContentHash,
    newContentHash: change.newContentHash,
    diff: change.diff,
  };
}

export function toAgentDefinition(agent: WorkerAgent): AgentDefinition {
  return {
    _id: agent._id,
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    description: agent.description,
    capabilities: agent.capabilities,
    supportedTools: agent.supportedTools,
    isEnabled: agent.isEnabled,
    priority: agent.priority,
    maxConcurrency: agent.maxConcurrency,
    status: agent.status,
    // LLM assignment for the Phase 2 resolver (ids only — never key material).
    llmProviderId: agent.llmProviderId,
    llmModelId: agent.llmModelId,
    llmFallbackProviderId: agent.llmFallbackProviderId,
    llmFallbackModelId: agent.llmFallbackModelId,
    llmSelectionPolicy: agent.llmSelectionPolicy,
  };
}

export function resolveWorkspacePath(workspaceRoot: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(workspaceRoot, configured);
}

/**
 * Inline the contents of @mentioned files into the command so the planner and
 * code-change agent see the workspace context. Mentions are `@relative/path.ext`
 * tokens in the command text.
 */
export async function withFileContexts(
  workspaceRoot: string,
  configuredWorkspacePath: string,
  command: string
): Promise<string> {
  const normalized = command.replace(/\r\n/g, "\n");
  const mentions = new Set<string>();
  for (const match of normalized.matchAll(/@([\w./-]+\.[\w]{1,12})/g)) {
    const rel = match[1].replace(/^\/+/, "").replace(/^\.\//, "");
    if (!rel || rel.includes("..")) continue;
    mentions.add(rel);
  }
  if (mentions.size === 0) return normalized;

  const base = resolveWorkspacePath(workspaceRoot, configuredWorkspacePath);
  const blocks: string[] = [];
  for (const rel of mentions) {
    const abs = path.resolve(base, rel);
    if (!abs.startsWith(base)) continue;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(abs, "utf-8");
      blocks.push(`--- File: ${rel} ---\n${content.slice(0, 20000)}`);
    } catch {
      // unreadable file: skip the block and keep the mention text
    }
  }
  if (blocks.length === 0) return normalized;

  const mentionLine = `Attached file context:\n${[...mentions].map((rel) => `- @${rel}`).join("\n")}`;
  return `${normalized}\n\n${mentionLine}\n\n${blocks.join("\n\n")}`;
}

export function heuristicPlanForTest(
  command: string,
  agents: AgentDefinition[]
): ExecutionPlan {
  return heuristicPlan({
    command,
    classification: classifyCommand(command),
    agents,
    policy: {
      maxSubtasks: 8,
      maxConcurrency: 2,
      maxReplans: 1,
      maxReviewIterations: 2,
      subtaskTimeoutMs: 180_000,
      subtaskRetries: 1,
      approvalTimeoutMs: 30 * 60_000,
      taskTimeoutMs: 30 * 60_000,
      verificationEnabled: true,
      verificationIncludeBuild: true,
      verificationTimeoutMs: 180_000,
      maxAgentsPerTask: 3,
      maxLLMCallsPerTask: 5,
      maxDelegationDepth: 2,
      maxDelegationChain: 2,
      maxConcurrentLLMCalls: 1,
      maxTokenBudgetPerTask: 50_000,
    },
  });
}

export type { SubtaskKind };
