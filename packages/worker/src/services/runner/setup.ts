import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY,
  type AgentDefinition,
  type ExecutionPlan,
  type PlanSubtask,
  type SubtaskKind,
} from "@/orchestrator/types";
import { classifyCommand } from "@/orchestrator/classifier";
import { heuristicPlan } from "@/orchestrator/planner";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { BudgetSnapshot, BudgetTracker } from "@/orchestrator/budget";
import type { AgentResult, SharedTaskContext } from "@/orchestrator/taskContext";
import { normalizeFindings } from "@/orchestrator/taskContext";
import type { GlobalLLMConfig } from "@/llm";
import {
  materializePool,
  TaskLlmResolver,
  type PoolConnectionRow,
} from "@/llm/resolver";
import { providerHealth } from "@/llm/health";
import { routeCapability } from "@/orchestrator/capabilities";
import type { ReviewFinding } from "@/utils/json";
import { getMcpRegistry, type McpSession } from "@/mcp/registry";
import type { WebClientConfig } from "@/tools/webClient";
import type { NodeOutcome, SchedulerResult } from "@/scheduler/dagScheduler";
import type { FileDiff } from "@/tools/gitDiff";
import type {
  WorkerAgent,
  WorkerProject,
  WorkerTask,
} from "@/workerApi";
import type { RunnerDeps, RunState } from "./types";

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
export async function buildTaskLlmResolver(
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
export function stagehandConfigFrom(
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
 * One AbortController per task run (Phase 4): fired by the runner's
 * cancel polling when the task row turns terminal, by the
 * policy.taskTimeoutMs wall-clock deadline, and by the MausBot-style
 * idle watchdog — the task aborts only after policy.idleTimeoutMs of NO
 * observable progress (bump() is called on every logged event, usage
 * record, and staged change). Every consumer — scheduler node signals,
 * LLM calls, QA, verification — observes this one signal, so a cancel
 * or a timeout stops the whole task, not just whichever node happens to
 * be scheduled. dispose() disarms everything.
 */
export const SHUTDOWN_ABORT_MESSAGE = "Worker shutting down";
export const LEASE_LOST_PREFIX = "Lease lost";

/** True for errors/abort reasons that mean "this worker no longer owns the task". */
export function isLeaseLostOrShutdown(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  // Convex wraps server errors ("[CONVEX A(...)] Uncaught Error: Lease lost: ..."),
  // so match anywhere in the message.
  return message.includes(`${LEASE_LOST_PREFIX}:`) || message.includes(LEASE_LOST_PREFIX + " ") ||
    message.startsWith(SHUTDOWN_ABORT_MESSAGE);
}

export function armTaskAbort(policy: ExecutionPolicy, shutdownSignal?: AbortSignal): {
  controller: AbortController;
  bump: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onShutdown = () => controller.abort(new Error(SHUTDOWN_ABORT_MESSAGE));
  if (shutdownSignal?.aborted) onShutdown();
  else shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Task deadline exceeded (${policy.taskTimeoutMs}ms)`)
    );
  }, policy.taskTimeoutMs);
  timer.unref?.();
  let lastActivity = Date.now();
  const bump = () => {
    lastActivity = Date.now();
  };
  const idleMs = policy.idleTimeoutMs ?? 0;
  const idleTimer =
    idleMs > 0
      ? setInterval(() => {
          if (controller.signal.aborted) return;
          if (Date.now() - lastActivity > idleMs) {
            controller.abort(
              new Error(`Task idle exceeded (${idleMs}ms)`)
            );
          }
        }, Math.min(5_000, Math.max(1_000, idleMs / 4)))
      : undefined;
  idleTimer?.unref?.();
  return {
    controller,
    bump,
    dispose: () => {
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      shutdownSignal?.removeEventListener("abort", onShutdown);
    },
  };
}

/** A signal that fires when ANY of the given signals fires. */
export function combineSignals(
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
export function isTerminalTaskStatus(status: string | undefined): boolean {
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
 * Whether a failure SUMMARY carries a budget stop. Failure summaries
 * are the per-subtask feedback entries joined with "; ", each entry
 * prefixed with its subtask key ("s3 (attempt 1): Budget exhausted:
 * ..."), so the raw summary never STARTS with the prefix — the
 * recognition scans for it at any entry boundary (Phase 5).
 */
export function summaryHasBudgetFailure(summary: string): boolean {
  return summary
    .split("; ")
    .some((entry) => entry.includes("Budget exhausted:"));
}

/** The budget reason carried by a failure summary (prefix stripped). */
export function budgetReasonFromSummary(summary: string): string {
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
  taskId: WorkerTask["_id"] | string;
  projectId: WorkerProject["_id"] | string;
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
export async function finishCancelledTask(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  signal: AbortSignal;
}): Promise<void> {
  const { deps, task, project, signal } = input;
  const reasonText =
    signal.reason instanceof Error ? signal.reason.message : "";
  // Worker shutdown / lost lease: this worker no longer owns the task.
  // Do NOT fail it — leave it for lease-expiry recovery (another worker
  // re-claims it) and just record why this run stopped.
  if (isLeaseLostOrShutdown(signal.reason)) {
    await deps.api
      .logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "task.interrupted",
        payload: { reason: reasonText },
        level: "warn",
      })
      .catch(() => undefined);
    return;
  }
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
export function toAgentResult(input: {
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

/** Map a delegation target capability to the subtask kind that executes it.
 * One implementation (plan 013 step 7): orchestrator/decision.ts, which
 * additionally normalizes capability aliases. */
export { kindForCapability } from "@/orchestrator/decision";

export function slugifyKeyPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "task";
}

/**
 * The subtasks of `plan` that already produced output, in the shape the
 * replan feedback lists them. Keys with no matching subtask in the plan
 * (stale state) are skipped: their output text is not a task description,
 * and without kind/capability carry-forward could never match them anyway.
 */
export function completedSubtasksFor(
  plan: Pick<ExecutionPlan, "subtasks">,
  state: Pick<RunState, "priorOutputs">
): CompletedSubtask[] {
  const completed: CompletedSubtask[] = [];
  for (const key of state.priorOutputs.keys()) {
    const subtask = plan.subtasks.find((candidate) => candidate.key === key);
    if (!subtask) continue;
    completed.push({
      key: subtask.key,
      kind: subtask.kind,
      capability: subtask.capability,
      description: subtask.description,
    });
  }
  return completed;
}

export type CompletedSubtask = {
  key: string;
  kind: string;
  capability: string;
  description: string;
};

/**
 * Replan feedback (Phase 3): the deterministic evaluator's summary plus
 * what the orchestrator itself decided and found along the way — the
 * decisions and open findings accumulated in the shared task context —
 * so the next plan is built with the orchestrator's evaluations as
 * input, not just the final verdict.
 */
export function buildReplanFeedback(
  base: string,
  sharedContext: SharedTaskContext,
  completedSubtasks?: Array<{ key: string; kind: string; capability: string; description: string }>
): string {
  const parts = [base];
  if (completedSubtasks && completedSubtasks.length > 0) {
    parts.push(
      "Already completed (DO NOT repeat these; reuse their descriptions verbatim so carry-forward matches): " +
        completedSubtasks
          .map((s) => `${s.key}: [${s.kind}/${s.capability}] ${s.description}`)
          .join(" | ")
    );
  }
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
    executionRuntime: agent.executionRuntime,
    opencodeModel: agent.opencodeModel,
  };
}

export function resolveWorkspacePath(workspaceRoot: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(workspaceRoot, configured);
}

type McpConfigRow = {
  _id: string;
  name: string;
  type: string;
  url?: string;
  command?: string;
  args?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  transport?: string;
  allowedDirectories?: string[];
};

/**
 * Plan 009: build the MCP executor input for a task. Seeding is lazy
 * (`autoConnect` pre-warms only), sessions are shared per workspace, and
 * a server that fails to connect simply yields no tools — the registry
 * never throws, so a dead MCP server can never fail the task.
 */
export function mcpForTask(
  configs: McpConfigRow[] | undefined,
  workspacePath: string,
  policy: ExecutionPolicy,
  reportStatus: (serverId: string, status: "connected" | "disconnected" | "error", errorMessage?: string) => Promise<void> | void
): { sessions: McpSession[]; writeTools: boolean; maxIterations: number } | undefined {
  if (policy.mcpToolLoop === false) return undefined;
  const sessions = getMcpRegistry().ensure(
    configs ?? [],
    workspacePath,
    {
      timeoutMs: policy.mcpTimeoutMs ?? 30_000,
      maxResultChars: policy.mcpMaxResultChars ?? 8_000,
    },
    { onStatus: reportStatus }
  );
  return {
    sessions,
    writeTools: policy.mcpWriteTools ?? false,
    maxIterations: policy.mcpMaxToolIterations ?? 6,
  };
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

/**
 * Plan 005 Step 5.2: turn QA outcomes into review findings for the fix
 * subtask. Prefers the QA checks carried on the node outcome; falls back
 * to the failure text when the executor did not include them.
 */
export function qaFindings(run: SchedulerResult, nodes: PlanSubtask[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const node of nodes) {
    const outcome = run.outcomes.get(node.key);
    const checks = (outcome?.meta as { checks?: { label: string; status: string; details?: string }[] } | undefined)
      ?.checks;
    const failedChecks = (checks ?? []).filter((check) => check.status === "failed");
    if (failedChecks.length > 0) {
      for (const check of failedChecks) {
        findings.push({
          severity: "high",
          filePath: "",
          description: `QA ${check.label}: ${check.details ?? "failed"}`,
          suggestion: "Fix the reported QA failure and re-run QA.",
        });
      }
      continue;
    }
    const failure =
      outcome && outcome.status === "failed" ? outcome.error : "no details";
    findings.push({
      severity: "high",
      filePath: "",
      description: `QA failed for ${node.key}: ${failure}`,
      suggestion: "Fix the reported QA failure and re-run QA.",
    });
  }
  return findings;
}

export function implementerAgent(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): AgentDefinition | null {
  const codeSubtask = plan.subtasks.find(
    (subtask) => subtask.kind === "code_change" || subtask.kind === "shell"
  );
  if (codeSubtask) return routeCapability(codeSubtask.capability, agents);
  return routeCapability(CAPABILITY.GENERAL, agents);
}

export function normalizeFileChangePath(filePath: string): string {
  return filePath.replace(/\\\\/g, "/").replace(/^\/+/, "");
}

export function isForbiddenFilePath(filePath: string): boolean {
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

export async function dryRunPolicy(
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
