import { resolveProjectPath } from "@fhara/config";
import { wenv } from "@fhara/config/worker";
import { WORKER_DIR } from "@/utils/rootEnv";
import { resolveSandboxPathAsync } from "@/tools/sandbox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY,
  type AgentDefinition,
  type ExecutionPlan,
  type PlanSubtask,
} from "@/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { BudgetSnapshot, BudgetTracker } from "@/orchestrator/budget";
import type { AgentResult } from "@/orchestrator/taskContext";
import { normalizeFindings } from "@/orchestrator/taskContext";
import type { GlobalLLMConfig } from "@/llm";
import {
  materializePool,
  TaskLlmResolver,
  type TaskLlmResolverOptions,
  type PoolConnectionRow,
} from "@/llm/resolver";
import { providerHealth } from "@/llm/health";
import type { LlmSelectionMode } from "@/api/convex/lib/llmSelection";
import { routeCapability } from "@/orchestrator/capabilities";
import type { ReviewFinding } from "@/utils/json";
import { getMcpRegistry, type McpRunConfig } from "@/mcp/registry";
import type { WebReachConfig } from "@/execution/webReachTools";
import type { WebClientConfig } from "@/tools/webClient";
import type { NodeOutcome, SchedulerResult } from "@/scheduler/dagScheduler";
import type { FileDiff } from "@/tools/gitDiff";
import { taskAgentSkills } from "@/execution/skillLoading";
import type { ModelTiers } from "@/api/convex/lib/modelTiers";
import { appendMemoryToPrompt } from "@/api/convex/lib/memory";
import { settingEnv } from "@/api/convex/lib/appSettings";
import type {
  WorkerRunAgent,
  WorkerProject,
  WorkerTask,
} from "@/workerApi";
import type { RunnerDeps, RunState } from "./types";

// Re-exported for tests that import the replan feedback helpers from here.
export { completedSubtasksFor, buildReplanFeedback, type CompletedSubtask } from "./replan";

/**
 * Build the per-task LLM resolver from the DB provider pool (Settings
 * page). The pool rows carry only ENCRYPTED keys; materializePool decrypts
 * them with the worker's PROVIDER_ENCRYPTION_KEY (or reads the env var a
 * connection names via apiKeyEnv). A decryption failure is a hard error
 * naming the provider — the caller fails the task with it rather than
 * silently calling an LLM with the wrong credential.
 *
 * Every call then resolves the one global chain (L4: the model list in
 * Settings order, the mode, circuit-open connections excluded; the
 * project's role model first only with FHARA_LLM_ROLE_OVERRIDE on).
 */
export async function buildTaskLlmResolver(
  llmProviders: PoolConnectionRow[] | undefined,
  /** Plan 022: the project's model tier per role (llmModels ids). */
  tiers?: ModelTiers,
  /** Plan 032: the app-wide selection mode ("fallback" | "round_robin"). */
  globalMode?: LlmSelectionMode
): Promise<TaskLlmResolver> {
  // Phase 5 observability: register each pool connection's display
  // name on the shared health registry, so the worker's health
  // reporter can key mirrored snapshots by the name the Settings
  // panel renders.
  for (const row of llmProviders ?? []) {
    providerHealth.registerConnectionName(row._id, row.name);
  }
  const pool = await materializePool(llmProviders);
  // L4: tiers apply only with FHARA_LLM_ROLE_OVERRIDE on (Settings override, then env).
  const roleOverride = wenv("FHARA_LLM_ROLE_OVERRIDE", settingEnv);
  return new TaskLlmResolver(pool, providerHealth, { tiers, globalMode, roleOverride });
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
    qaEnvFallbackCache = wenv("QA_BASE_URL");
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


export function toAgentDefinition(agent: WorkerRunAgent): AgentDefinition {
  const skills = taskAgentSkills(agent);
  return {
    _id: agent._id,
    name: agent.name,
    role: agent.role,
    // Library skills go AFTER the static system prompt (prefix caching):
    // inline (default) budgeted to SKILLS_PROMPT_BUDGET chars, or on_demand
    // as a names + descriptions index (load_skill reads the rest). Every
    // execution path (API messages, OpenCode prompt, curated context)
    // reads this field.
    // Then the pinned-memory section (shared → project → agent, capped at
    // MEMORY_PROMPT_BUDGET), still after everything static.
    // Plan L4: then the recalled (unpinned) memories for this task, last, so
    // the pinned prefix is identical with and without recall.
    systemPrompt: appendMemoryToPrompt(
      appendMemoryToPrompt(
        skills.systemPrompt,
        agent.memorySection
      ),
      agent.recalledMemorySection
    ),
    // Paradev C3: invoked skills are inline (above) and leave this list.
    ...(skills.onDemandSkills ? { onDemandSkills: skills.onDemandSkills } : {}),
    ...(skills.librarySkills ? { librarySkills: skills.librarySkills } : {}),
    description: agent.description,
    capabilities: agent.capabilities,
    supportedTools: agent.supportedTools,
    isEnabled: agent.isEnabled,
    priority: agent.priority,
    maxConcurrency: agent.maxConcurrency,
    status: agent.status,
    // L4: no per-agent model, fallback, policy or runtime. Every call
    // resolves the global chain (lib/llmChain.ts); a row that still carries
    // the retired fields is ignored until migrations:clearPerAgentLlm runs.
  };
}

/** B7: the shared rule (@fhara/config resolveProjectPath); a relative root is measured from packages/worker. */
export function resolveWorkspacePath(workspaceRoot: string, configured: string): string {
  return resolveProjectPath(configured, workspaceRoot, WORKER_DIR, path);
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
  projectId?: string;
  preset?: string;
  agentRoles?: string[];
  toolAllowlist?: string[];
  envCiphertext?: string;
  envKeys?: string[];
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
): McpRunConfig | undefined {
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
 * Plan 036: build the Agent Reach web-tool config for a task.
 *
 * The tool is offered to read-only agents that declare `web_reach` in their
 * `supportedTools`; the policy decides whether it exists at all.
 */
export function webReachForTask(policy: ExecutionPolicy): WebReachConfig | undefined {
  if (policy.agentReachEnabled === false) return undefined;
  return {
    command: policy.agentReachCommand ?? "agent-reach",
    timeoutMs: policy.agentReachTimeoutMs ?? 60_000,
    maxItems: policy.agentReachMaxItems ?? 10,
    maxIterations: policy.agentReachMaxToolIterations ?? 4,
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
  const realBase = await fs.realpath(base).catch(() => path.resolve(base));
  const blocks: string[] = [];
  for (const rel of mentions) {
    // W3: symlink-aware containment (realpath + separator, so neither a link
    // out of the workspace nor a prefix sibling such as `/repo-evil` passes),
    // and a secret file is never inlined, also not through a link to it.
    const abs = await resolveSandboxPathAsync(base, rel).catch(() => null);
    if (!abs || isSecretMention(rel) || isSecretMention(path.relative(realBase, abs))) continue;
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

/** `.env` / `.env.*` anywhere, and anything under `.git/` or `.ssh/`. */
function isSecretMention(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => /^\.env(\..*)?$/i.test(part) || /^\.(git|ssh)$/i.test(part));
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
    const checks = (outcome?.meta as
      | { checks?: { label: string; status: string; details?: string; filePath?: string }[] }
      | undefined)?.checks;
    const failedChecks = (checks ?? []).filter((check) => check.status === "failed");
    if (failedChecks.length > 0) {
      for (const check of failedChecks) {
        findings.push({
          severity: "high",
          // Derived from the console error's stack by the QA harness, so
          // the fix agent gets a file hint (was always "").
          filePath: check.filePath ?? "",
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
  // Plan 040: no catch-all ("general" / Support) when the plan has no code.
  return codeSubtask ? routeCapability(codeSubtask.capability, agents) : null;
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
