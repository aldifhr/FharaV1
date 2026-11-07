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
import {
  BudgetTracker,
  isBudgetExhaustedError,
  type BudgetSnapshot,
} from "@/orchestrator/budget";
import type { TokenUsageMeta } from "@/effects/llmCall";
import {
  createAuthoritativePlan,
  createOrchestratorPlan,
  evaluateAfterExecution,
} from "@/orchestrator/orchestrator";
import {
  createSharedTaskContext,
  appendExecution,
  normalizeFindings,
  type AgentResult,
  type SharedTaskContext,
} from "@/orchestrator/taskContext";
import type { Classification } from "@/orchestrator/types";
import type { GlobalLLMConfig } from "@/llm";
import { LlmConcurrencyGate, type FallbackHandle } from "@/effects/llmCall";
import {
  materializePool,
  TaskLlmResolver,
  type PoolConnectionRow,
} from "@/llm/resolver";
import { providerHealth } from "@/llm/health";
import { routeCapability, capabilitiesOf } from "@/orchestrator/capabilities";
import {
  buildFixSubtask,
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
  type SchedulerNode,
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
  // Phase 5 observability: register each pool connection's display
  // name on the shared health registry, so the worker's health
  // reporter can key mirrored snapshots by the name the Settings
  // panel renders.
  for (const row of llmProviders ?? []) {
    providerHealth.registerConnectionName(row._id, row.name);
  }
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

/**
 * Build the executable state for a task from what the DB already holds:
 * subtask rows marked completed become completedKeys (with their
 * recorded outputs as priorOutputs), and the persisted file changes are
 * the staged work those subtasks produced. ONE builder is shared by
 * processTask (recovery of a re-claimed task whose stored plan was
 * adopted) and resumeTask (post-approval continuation), so a completed
 * subtask is never re-executed on either path (Phase 4). Since Phase 4
 * hardening, dynamic subtasks (delegation/fix/review-fix) are persisted
 * too — their rows are in `subtasks` and their definitions in the
 * stored plan payload — so the builder recovers the WHOLE DAG, not
 * just the initial plan. (Runtime derivations that are not persisted —
 * the per-branch capability chain and fix depth — are rebuilt from the
 * plan alone; see the Phase 4H report's limitations.)
 */
export function buildStateFromDb(input: {
  subtasks: WorkerSubtask[];
  fileChanges: WorkerFileChange[];
}): { state: RunState; completedKeys: Set<string> } {
  const completedKeys = new Set(
    input.subtasks
      .filter((subtask) => subtask.status === "completed")
      .map((subtask) => subtask.key)
  );
  const state: RunState = {
    priorOutputs: new Map(
      input.subtasks
        .filter((subtask) => subtask.status === "completed" && subtask.output)
        .map((subtask) => [subtask.key, subtask.output as string])
    ),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(
      input.fileChanges.map((change) => [change.filePath, toFileDiff(change)])
    ),
    feedback: [],
  };
  return { state, completedKeys };
}

/**
 * One AbortController per task run (Phase 4): fired by the runner's
 * cancel polling when the task row turns terminal, and by the
 * policy.taskTimeoutMs deadline armed here. Every consumer — scheduler
 * node signals, LLM calls, QA, verification — observes this one signal,
 * so a cancel or a timeout stops the whole task, not just whichever
 * node happens to be scheduled. dispose() disarms the deadline.
 */
function armTaskAbort(policy: ExecutionPolicy): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Task deadline exceeded (${policy.taskTimeoutMs}ms)`)
    );
  }, policy.taskTimeoutMs);
  timer.unref?.();
  return { controller, dispose: () => clearTimeout(timer) };
}

/** A signal that fires when ANY of the given signals fires. */
function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/** Terminal task statuses: a task in one of these is finished for good. */
function isTerminalTaskStatus(status: string | undefined): boolean {
  return status === "done" || status === "failed" || status === "rejected";
}

/**
 * End a task run as BUDGET EXHAUSTED (Phase 5). The backend has no
 * dedicated budget status — like cancellation, the task row lands on
 * "failed" — so the distinction lives in the dedicated
 * `budget.exhausted` event (with the final tracker snapshot) and the
 * error message. Completed subtask outputs are untouched: they were
 * persisted as they finished and remain visible in the task timeline.
 * The backend completeTask terminal guard makes this a no-op if the
 * task already reached a terminal status by another path.
 */
export async function finishBudgetExhaustedTask(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  budget: BudgetTracker;
  reason: string;
}): Promise<void> {
  const { deps, task, project, budget, reason } = input;
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "budget.exhausted",
    payload: { reason, budget: budget.snapshot() },
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
    errorMessage: `Budget exhausted: ${reason}`,
  });
}

/**
 * Whether a failure summary is a budget-exhaustion stop. Budget exits
 * carry the typed error's message ("Budget exhausted: <reason>") —
 * subtask outcomes flatten the error class to a string at the executor
 * boundary, so the prefix IS the recognition contract (Phase 5).
 */
function isBudgetFailureText(text: string): boolean {
  return text.startsWith("Budget exhausted:");
}

/**
 * Whether a failure SUMMARY carries a budget stop. Failure summaries
 * are the per-subtask feedback entries joined with "; ", each entry
 * prefixed with its subtask key ("s3 (attempt 1): Budget exhausted:
 * ..."), so the raw summary never STARTS with the prefix — the
 * recognition scans for it at any entry boundary (Phase 5).
 */
function summaryHasBudgetFailure(summary: string): boolean {
  return summary
    .split("; ")
    .some((entry) => entry.includes("Budget exhausted:"));
}

/** The budget reason carried by a failure summary (prefix stripped). */
function budgetReasonFromSummary(summary: string): string {
  const entry = summary
    .split("; ")
    .find((candidate) => candidate.includes("Budget exhausted:"));
  if (!entry) return summary;
  return entry.slice(entry.indexOf("Budget exhausted: ") + "Budget exhausted: ".length);
}

/**
 * Seed a task's budget tracker from persisted state (Phase 5): call and
 * token totals from the tokenUsage table (source of truth for usage)
 * PLUS the non-usage state — agents, delegation count, retries — from
 * the budget snapshot stored on the task context. A seeding failure is
 * VISIBLE: it emits a `budget.seed_failed` warning event and the run
 * continues on a visibly-partial tracker — never the old silent catch
 * that quietly reset every limit (PLAN §7.4).
 */
export async function seedBudgetFromPersisted(input: {
  deps: RunnerDeps;
  taskId: WorkerTask["_id"];
  projectId: WorkerProject["_id"];
  budget: BudgetTracker;
}): Promise<void> {
  const { deps, taskId, projectId, budget } = input;
  try {
    const priorUsage = await deps.api.getTaskTokenUsage?.({ taskId });
    const snapshot = (
      await deps.api.getTaskContext?.({ taskId }).catch(() => null)
    )?.budgetSnapshot as BudgetSnapshot | undefined;
    if (snapshot) {
      budget.restoreExtras({
        agents: snapshot.agents,
        delegationDepth: snapshot.delegationDepth,
        retries: snapshot.retries,
      });
    }
    if (priorUsage && priorUsage.calls > 0) {
      budget.seed(priorUsage);
    } else if (snapshot && snapshot.llmCalls > 0) {
      // Fallback when the usage aggregate is unavailable: the snapshot
      // still carries the totals it recorded.
      budget.seed({
        calls: snapshot.llmCalls,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
      });
    }
  } catch (error) {
    await deps.api
      .logEvent({
        taskId,
        projectId,
        type: "budget.seed_failed",
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
        level: "warn",
      })
      .catch(() => undefined);
  }
}

/**
 * End a task run as cancelled (Phase 4 hardening). The backend has no
 * "cancelled" task status — tasks.cancel itself stores a user
 * cancellation as status "failed" + "Cancelled by user" — so the
 * outcome maps to completeTask("failed") with a cancellation message,
 * while the dedicated `task.cancelled` event preserves the distinction
 * (user cancel vs deadline) in the task timeline. The backend
 * completeTask guard makes this call a no-op when the task already
 * reached a terminal status by another path, so a late cancel ending
 * can never overwrite a real completion either.
 */
async function finishCancelledTask(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  signal: AbortSignal;
}): Promise<void> {
  const { deps, task, project, signal } = input;
  const reasonText =
    signal.reason instanceof Error ? signal.reason.message : "";
  const timedOut = reasonText.startsWith("Task deadline exceeded");
  const errorMessage = timedOut ? reasonText : "Task cancelled";
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.cancelled",
    payload: { reason: errorMessage, timedOut },
    level: "warn",
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
    errorMessage,
  });
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

/** Map a delegation target capability to the subtask kind that executes it. */
function kindForCapability(capability: string): SubtaskKind {
  switch (capability) {
    case CAPABILITY.BROWSER_TESTING:
      return "qa";
    case CAPABILITY.CODE_REVIEW:
      return "review";
    case CAPABILITY.FRONTEND:
    case CAPABILITY.BACKEND:
    case CAPABILITY.GITHUB:
      return "code_change";
    case CAPABILITY.SECURITY:
      return "audit";
    case CAPABILITY.RESEARCH:
      return "research";
    default:
      return "analysis";
  }
}

function slugifyKeyPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "task";
}

/**
 * Replan feedback (Phase 3): the deterministic evaluator's summary plus
 * what the orchestrator itself decided and found along the way — the
 * decisions and open findings accumulated in the shared task context —
 * so the next plan is built with the orchestrator's evaluations as
 * input, not just the final verdict.
 */
export function buildReplanFeedback(
  base: string,
  sharedContext: SharedTaskContext
): string {
  const parts = [base];
  const decisions = sharedContext.decisions.slice(-6);
  if (decisions.length > 0) {
    parts.push(
      `Orchestrator evaluations: ${decisions
        .map(
          (decision) =>
            `${decision.decision}${decision.capability ? ` (${decision.capability})` : ""}: ${decision.reason}`
        )
        .join("; ")}`
    );
  }
  const openIssues = sharedContext.outstandingIssues
    .filter((issue) => issue.status === "open")
    .slice(-6);
  if (openIssues.length > 0) {
    parts.push(
      `Open findings: ${openIssues
        .map((issue) => `[${issue.severity}] ${issue.description}`)
        .join("; ")}`
    );
  }
  return parts.filter((part) => part.length > 0).join("\n");
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
        authoritative: true,
      },
    });
    if (!storedPlan) {
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
      let created: Awaited<ReturnType<typeof createPlan>>;
      try {
        created = await createPlan({
          command,
          classification,
          agents: runAgents,
          policy: deps.policy,
          llmConfig,
          llmResolver,
          onTokenUsage: recordUsage,
          assertBudgetForCall,
          signal: taskAbort.controller.signal,
          llmTaskGate,
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
        fileChanges: await deps.api.getFileChanges({ taskId: task._id }),
      })
    : null;
  const state: RunState = seeded?.state ?? {
    priorOutputs: new Map(),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(),
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
        qaBaseUrl,
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

      if (outcome === "waiting_approval") return;

      // Cancellation is terminal (Phase 4 hardening): a cancelled or
      // timed-out task ends here — it is never replanned, never
      // finalized, and never marked done.
      if (outcome === "cancelled") {
        await finishCancelledTask({
          deps,
          task,
          project,
          signal: taskAbort.controller.signal,
        });
        return;
      }

      if (outcome === "completed") {
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
          subtasks: after?.subtasks ?? [],
          state,
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
          let replanned: Awaited<ReturnType<typeof createPlan>>;
          try {
            replanned = await createPlan({
              command,
              classification,
              agents: runAgents,
              policy: deps.policy,
              feedback,
              llmConfig,
              llmResolver,
              onTokenUsage: recordUsage,
              assertBudgetForCall,
              signal: taskAbort.controller.signal,
              llmTaskGate,
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
          // A replan is a brand-new plan: nothing is pre-completed in it.
          completedKeys = new Set<string>();
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
        state.feedback.join("; ") || "Execution failed without a detailed error";
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
        let replanned: Awaited<ReturnType<typeof createPlan>>;
        try {
          replanned = await createPlan({
            command,
            classification,
            agents: runAgents,
            policy: deps.policy,
            feedback,
            llmConfig,
            llmResolver,
            onTokenUsage: recordUsage,
            assertBudgetForCall,
            signal: taskAbort.controller.signal,
            llmTaskGate,
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
        // A replan is a brand-new plan: nothing is pre-completed in it.
        completedKeys = new Set<string>();
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
}): Promise<"completed" | "failed" | "waiting_approval" | "cancelled"> {
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

  /**
   * Durable dynamic DAG (Phase 4 hardening): persist a freshly spawned
   * subtask (and the plan payload containing it) at the moment it is
   * added, so recovery after a worker restart sees the whole DAG. A
   * persistence failure is surfaced as an event — never silently
   * swallowed — but does not abort the run: the in-memory DAG is still
   * correct for THIS worker; only restart-durability is degraded.
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
  // Per-branch capability chain per subtask key (root first, ending with
  // the subtask's own capability). Delegation depth and circularity are
  // derived from this chain — never from a task-global counter.
  const chainByKey = new Map<string, string[]>();
  // How many orchestrator fix rounds a subtask already sits in (0 = plan
  // or delegation subtask, 1 = fix subtask). Fix subtasks do not spawn
  // further fixes from evaluations; the review loop owns its iterations.
  const fixDepthByKey = new Map<string, number>();
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
    const agent = routeCapability(subtask.capability, input.agents);
    if (agent) agentByKey.set(key, agent);
    return agent;
  };

  let lastStatusCheck = 0;
  let cancelled = false;
  /** True once this run is cancelled — by the status poll or by the deadline signal. */
  const taskCancelled = (): boolean =>
    cancelled || input.taskAbort?.signal.aborted === true;

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
        llmTaskGate: input.llmTaskGate,
        qaBaseUrl: input.qaBaseUrl,
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
      shouldHaltNewNodes: () => budgetHalt,
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
        if (input.completedKeys.has(node.id)) return;
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
        if (agent && !input.completedKeys.has(node.id)) {
          activeByAgent.set(
            agent._id,
            Math.max(0, (activeByAgent.get(agent._id) ?? 1) - 1)
          );
        }
        let dynamicNodes: SchedulerNode[] | undefined;
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
            if (subtaskDef) {
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
                taskContext: input.sharedContext,
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

  const implementation = await runNodes(implementationNodes);
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
    return "cancelled";
  }
  if (implementation.status !== "completed") {
    return taskCancelled() ? "cancelled" : "failed";
  }

  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  if (hasCodeChange && state.fileChanges.size === 0) {
    state.feedback.push("The implementation produced no file changes");
    return "failed";
  }

  const reviewApproved = await runReviewLoop();
  if (!reviewApproved) {
    return taskCancelled() ? "cancelled" : "failed";
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
      return taskCancelled() ? "cancelled" : "failed";
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
      // A cancel/deadline that landed while the scheduler was running
      // stops the apply phase too: no further files are written.
      if (input.taskAbort?.signal.aborted) {
        state.feedback.push(
          "Apply aborted: the task was cancelled or timed out"
        );
        return "cancelled";
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
          agentId: implementerAgent(plan, input.agents)?._id,
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
      return "cancelled";
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
  // Phase 4 hardening: the resumed run gets its OWN per-task LLM gate
  // and its deadline is armed before execution setup begins (the
  // timer is disposed on every exit path below — the resolver-failure
  // return disposes explicitly; everything else flows through the
  // try/finally around executePlan).
  const llmTaskGate = new LlmConcurrencyGate(deps.policy.maxConcurrentLLMCalls);
  const taskAbort = armTaskAbort(deps.policy);
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
    fileChanges: changes,
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
  const sharedContext = createSharedTaskContext({
    taskId,
    projectId: context.project._id,
    originalRequest: command,
    title: context.task.title,
    classification,
  });

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
      qaBaseUrl: resolveQaBaseUrl(context.project),
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
    switch (outcome) {
      case "waiting_approval":
        return;
      case "cancelled":
        await finishCancelledTask({
          deps,
          task: context.task,
          project: context.project,
          signal: taskAbort.controller.signal,
        });
        return;
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
          subtasks: after?.subtasks ?? [],
          state,
          signal: taskAbort.controller.signal,
        });
        return;
      }
    }
  } finally {
    taskAbort.dispose();
  }
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
  /** Per-task abort signal (Phase 4): verification steps die with the task. */
  signal?: AbortSignal;
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
      signal: input.signal,
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
      maxConcurrentLLMCalls: 1,
      maxTokenBudgetPerTask: 50_000,
    },
  });
}

export type { SubtaskKind };
