import type {
  WorkerApi,
  WorkerExecutionId,
  WorkerProject,
  WorkerTask,
} from "@/workerApi";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { ReviewResult } from "@/utils/json";
import type { FileDiff } from "@/tools/gitDiff";
import type { BudgetTracker } from "@/orchestrator/budget";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type {
  AgentDefinition,
  Classification,
  ExecutionPlan,
  PlanSubtask,
} from "@/types";
import type { GlobalLLMConfig } from "@/llm";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { TokenUsageFn } from "@/types/llm";
import type { QaCheckRecord, QaVerdict } from "@/types/qa";
import type { DynamicSubtaskOrigin } from "@/types/subtask";
import type { WebClient } from "@/tools/webClient";
import type { LlmConcurrencyGate } from "@/effects/llmCall";
import type { McpRunConfig } from "@/mcp/registry";
import type {
  NodeOutcome,
  SchedulerNode,
  SchedulerResult,
} from "@/scheduler/dagScheduler";

/**
 * Runtime dependencies the runner needs. One sink per concern: every
 * backend call goes through `api` (never the Convex HTTP API directly).
 */
export interface RunnerDeps {
  api: WorkerApi;
  workerId: string;
  policy: ExecutionPolicy;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
  /**
   * Fired by the worker entrypoint on SIGINT/SIGTERM: every in-flight task
   * aborts promptly and is left for lease-expiry recovery (not failed).
   */
  shutdownSignal?: AbortSignal;
}

/**
 * In-memory execution state for one task run (Phase 4). Seeded from the DB
 * by `buildStateFromDb`, mutated by the DAG, and read by finalize and the
 * objective evaluation.
 */
export interface RunState {
  priorOutputs: Map<string, string>;
  qaVerdicts: Record<string, QaVerdict>;
  /** The exact checks each QA node ran (labels + statuses). Feeds the
   * specific pass message instead of a generic template. */
  qaChecks?: Record<string, QaCheckRecord[]>;
  reviewVerdicts: Record<string, ReviewResult>;
  fileChanges: Map<string, FileDiff>;
  /** Applied file paths per producing subtask key (Phase 5 Step 5.1). */
  appliedFilesBySubtask: Map<string, string[]>;
  /** Last static verification result, once it has run (Phase 5 Step 5.1). */
  verification?: { status: "passed" | "failed" | "skipped"; details?: string };
  feedback: string[];
}

/**
 * Inputs to one `executePlan` run. Both `processTask` and `resumeTask`
 * assemble this once and hand it to the extracted run stages.
 */
export interface ExecutePlanInput {
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
  taskAbort?: AbortController & { bump?: () => void };
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
  mcp?: McpRunConfig;
  /**
   * Usage sink for plan-level LLM calls (the decision advisor). Threaded
   * from the caller's recorder so advisor spend is metered in the same
   * BudgetTracker and tokenUsage table as subtask calls.
   */
  onTokenUsage?: TokenUsageFn;
  worktree?: { branchName: string; worktreePath: string };
  /**
   * Persist dynamically spawned subtasks (Phase 4 hardening): called
   * the moment a delegation/fix/review-fix subtask is added to the
   * plan, with the full updated plan, so a worker restart recovers the
   * whole DAG instead of only the initial plan.
   */
  onDynamicSubtasks?: (request: {
    added: PlanSubtask[];
    origin: DynamicSubtaskOrigin;
    plan: ExecutionPlan;
    version: number;
  }) => Promise<void>;
}

/** Result of applying staged file changes: the applied paths or a terminal stop. */
export type ApplyStagedResult =
  | { applied: string[] }
  | { stop: "cancelled" | "failed" };

/**
 * The `applyStaged` closure (Plan 005 Step 5.2): the ONE place staged
 * file changes reach the workspace. Shared by the main apply phase and
 * the QA/verification fix loops so a correction actually lands before
 * re-running. A stop result maps to the caller's terminal outcome — a
 * cancellation or an apply failure is never retried or replanned here.
 */
export type ApplyStagedFn = (
  changes: FileDiff[],
  actor: "user" | "orchestrator"
) => Promise<ApplyStagedResult>;

/** The `runNodes` scheduler closure: run a set of subtasks through the DAG. */
export type RunNodesFn = (nodes: PlanSubtask[]) => Promise<SchedulerResult>;

/**
 * Shared mutable state for one `executePlan` run. The extracted stages
 * (`runNodes`, `handleNodeOutcome`, the review/QA/verification loops)
 * all read and mutate this context instead of closing over locals, so
 * `executePlan` builds it once and stays a thin orchestration.
 *
 * Scalars must be accessed as `ctx.<scalar>` (a destructured copy would
 * not be visible); reference-type containers may be destructured —
 * mutations through the shared reference are visible to every stage.
 */
export interface RunContext {
  input: ExecutePlanInput;
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  plan: ExecutionPlan;
  state: RunState;
  agents: AgentDefinition[];
  browser: WebClient;
  taskId: string;

  /**
   * Node groups precomputed before any dynamic node is added. The review
   * and QA loops re-run their own nodes only — a dynamic node must never
   * join these groups.
   */
  implementationNodes: PlanSubtask[];
  reviewNodes: PlanSubtask[];
  qaNodes: PlanSubtask[];
  reviewNodeKeys: string[];
  /** Capabilities the stored plan already schedules (pre-dynamic). */
  plannedCapabilities: string[];

  /** Policy is in enforce mode: a budget BLOCKED evaluation halts scheduling. */
  budgetEnforced: boolean;
  /** Authoritative orchestrator mode is active for this run. */
  authoritative: boolean;
  /** The decision engine replaces the advisory evaluation path. */
  decisionEngine: boolean;

  // --- Mutable scalars (always read/write via `ctx.<name>`) --------------
  decisionStep: number;
  /** Latched when the decision step bound is hit (Plan 005 Step 5.4). */
  stepLimitHit: boolean;
  /** Latched when a budget BLOCKED evaluation halts scheduling. */
  budgetHalt: boolean;
  /** True once this run is cancelled — by the status poll or the deadline signal. */
  cancelled: boolean;
  /** Latched when a decision-terminal outcome ends scheduling (plan 013 step 3). */
  decisionTerminal: boolean;
  /** Objective missing list carried by the first replan outcome. */
  replanFeedback: string | null;
  /** True while a review/QA staged loop owns the remaining work. */
  inStageLoop: boolean;
  /**
   * Plan 019: the live QA checklist card of the QA pass in flight. runNodes
   * folds each QA `task.check` into it; the QA loop posts the final state.
   */
  qaCard?: {
    key: string;
    iteration: number;
    rows: import("@/api/convex/cardTypes").QaCardRow[];
    url?: string;
    agentId?: string;
  };
  /** The question this invocation paused for (plan 013 step 4). */
  waitingForInput: string | null;
  /**
   * Latched when a stage loop (verification / QA fix in ask mode) requested
   * an apply approval and the run must end as `waiting_approval`.
   */
  pendingApproval?: boolean;
  delegationSeq: number;
  fixSeq: number;
  lastStatusCheck: number;

  // --- Reference-type containers (safe to destructure) -------------------
  /** Completion state for THIS run (seeded from `input.completedKeys`). */
  runCompleted: Set<string>;
  /** Keys of delegation / fix / recovery nodes added after planning. */
  dynamicKeys: Set<string>;
  /** Per-branch capability chain per subtask key (root first). */
  chainByKey: Map<string, string[]>;
  /** Orchestrator fix rounds a subtask already sits in (0 = plan/delegation, 1 = fix). */
  fixDepthByKey: Map<string, number>;
  /** Live per-agent execution counts (delegation + scheduler start gates). */
  activeByAgent: Map<string, number>;
  executionIds: Map<string, WorkerExecutionId>;
  /** Last posted chat text per agent+subtask (duplicate suppression). */
  lastPostedMessage: Map<string, string>;
  /** Resolved agent per subtask key (memoized `assign`). */
  agentByKey: Map<string, AgentDefinition>;

  // --- Helpers (built once by `executePlan`) ------------------------------
  assign: (key: string) => AgentDefinition | null;
  nextOrder: () => number;
  uniqueSubtaskKey: (base: string) => string;
  persistDynamic: (
    added: PlanSubtask[],
    origin: DynamicSubtaskOrigin
  ) => Promise<void>;
  /** True once this run is cancelled — by the status poll or the deadline signal. */
  taskCancelled: () => boolean;
  applyStaged: ApplyStagedFn;
  runNodes: RunNodesFn;
}
