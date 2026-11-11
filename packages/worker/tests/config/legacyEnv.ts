/**
 * FROZEN pre-E1 env readers (packages/worker at 4d2dfb7), kept verbatim as
 * parity oracles for the E1 migration onto @fhara/config. Do not "fix"
 * anything here: these copies define what "no behaviour change" means.
 *
 * Exception, B2 (one bool dialect): every boolean oracle below now calls
 * b2Bool, an independent copy of the unified rule. The five pre-B2
 * dialects are pinned (and contrasted) in behaviourFixes.test.ts.
 * Exception, B3 (validated numbers): the index.ts constants, DIRECT_POLL_MS
 * and the LLM ints call b3Int. Exception, B5: legacyGlobalLLMConfig is the
 * unified LLM fallback (b5GlobalLLMConfig).
 */
/* eslint-disable */
import * as nodePath from "node:path";
import { WORKER_DIR } from "../../src/utils/rootEnv";
type Env = Record<string, string | undefined>;
type Get = (name: string) => string | undefined;

/** B3 reference: unset/blank → d; Number; not finite → d; floor; clamp. */
export function b3Int(raw: string | undefined, d: number, min = -Infinity, max = Infinity): number {
  if (raw === undefined || raw.trim() === "") return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** B2 reference: unset/blank → d; 1|true|yes|on → true; 0|false|no|off → false; else d. */
export function b2Bool(raw: string | undefined, d: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return d;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return d;
}

export function legacyExecutionRuntime(env: Env): "api" | "native-provider" {
  const raw = (env.ORCHESTRATOR_EXECUTION_RUNTIME ?? env.ORCHESTRATOR_RUNTIME ?? "").trim().toLowerCase();
  return raw === "native-provider" || raw === "opencode" ? "native-provider" : "api";
}

const DEFAULT_SUBTASK_TIMEOUT_MS = 900_000;

/** policy.ts loadPolicy(), with settingEnv → get and process.env → rawEnv. */
export function legacyLoadPolicy(get: Get, rawEnv: Env): Record<string, unknown> {
  function intFromEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = get(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  }

  function boolFromEnv(name: string, fallback: boolean): boolean {
    return b2Bool(get(name), fallback);
  }

  function planningModeFromEnv(name: string, fallback: "auto" | "never" = "auto"): "always" | "auto" | "never" {
    const raw = (get(name) ?? "").trim().toLowerCase();
    return raw === "always" || raw === "auto" || raw === "never" ? raw : fallback;
  }

  function defaultParallelism(worktreeIsolation: boolean): number {
    if (!worktreeIsolation) return 1;
    return intFromEnv("ORCHESTRATOR_PARALLEL_DEFAULT", 2, 1, 3);
  }

  function loadPolicy(): Record<string, unknown> {
    const maxReplans = intFromEnv("ORCHESTRATOR_MAX_REPLANS", 1, 0, 3);
    // Off by default: isolation fails tasks whose workspace is not a git
    // repo, and needs the Convex node action to share the worker's disk.
    const worktreeIsolation = boolFromEnv("ORCHESTRATOR_WORKTREE_ISOLATION", false);
    const parallelism = defaultParallelism(worktreeIsolation);
    return {
      maxSubtasks: intFromEnv("ORCHESTRATOR_MAX_SUBTASKS", 8, 1, 20),
      maxConcurrency: intFromEnv("ORCHESTRATOR_MAX_CONCURRENCY", parallelism, 1, 8),
      maxReplans,
      // Spec alias: defaults to the maxReplans value so the two never drift;
      // ORCHESTRATOR_MAX_PLANNING_ITERATIONS overrides the iteration bound
      // directly when set.
      maxPlanningIterations: intFromEnv(
        "ORCHESTRATOR_MAX_PLANNING_ITERATIONS",
        maxReplans,
        0,
        3
      ),
      maxReviewIterations: intFromEnv("ORCHESTRATOR_MAX_REVIEW_ITERATIONS", 2, 0, 5),
      // Configurable up to 1h (was clamped to 300s, which a slow model
      // cannot meet on a multi-file change — e2e ULTRA).
      // Default 900s (was 300s): live tests 3/4 timed out medium native
      // (OpenCode) subtasks at 300s while one nous call takes 5-8 min. The
      // runner grows it further from observed latency (subtaskTimeoutFor).
      subtaskTimeoutMs: intFromEnv("ORCHESTRATOR_SUBTASK_TIMEOUT_MS", DEFAULT_SUBTASK_TIMEOUT_MS, 30_000, 3_600_000),
      subtaskTimeoutFromEnv: Boolean(rawEnv.ORCHESTRATOR_SUBTASK_TIMEOUT_MS),
      subtaskTimeoutMsHigh: intFromEnv(
        "ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS",
        // 900s: one slow call (~280s on longcat) plus a full retry must fit.
        Math.max(900_000, intFromEnv("ORCHESTRATOR_SUBTASK_TIMEOUT_MS", DEFAULT_SUBTASK_TIMEOUT_MS, 30_000, 3_600_000)),
        30_000,
        3_600_000
      ),
      subtaskRetries: intFromEnv("ORCHESTRATOR_SUBTASK_RETRIES", 1, 0, 3),
      approvalTimeoutMs: intFromEnv("ORCHESTRATOR_APPROVAL_TIMEOUT_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
      taskTimeoutMs: intFromEnv("ORCHESTRATOR_TASK_TIMEOUT_MS", 20 * 60_000, 60_000, 3 * 60 * 60_000),
      taskTimeoutMsHigh: intFromEnv(
        "ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS",
        Math.max(40 * 60_000, intFromEnv("ORCHESTRATOR_TASK_TIMEOUT_MS", 20 * 60_000, 60_000, 3 * 60 * 60_000)),
        60_000,
        3 * 60 * 60_000
      ),
      // MausBot mechanism: progress-based termination. Build steps keep the
      // task alive; only true inactivity trips this. 0 = disabled.
      idleTimeoutMs: intFromEnv("ORCHESTRATOR_IDLE_TIMEOUT_MS", 10 * 60_000, 60_000, 24 * 60 * 60_000),
      // Planning watchdog (e2e 2026-11-09: a task sat in planning after a
      // stall-triggered replan). 0 = disabled.
      planningStallMs: intFromEnv("ORCHESTRATOR_PLANNING_STALL_MS", 12 * 60_000, 0, 3 * 60 * 60_000),
      verificationEnabled: boolFromEnv("ORCHESTRATOR_VERIFICATION_ENABLED", true),
      verificationIncludeBuild: boolFromEnv("ORCHESTRATOR_VERIFICATION_BUILD", true),
      verificationTimeoutMs: intFromEnv("ORCHESTRATOR_VERIFICATION_TIMEOUT_MS", 300_000, 30_000, 300_000),
      // Intelligent orchestrator defaults from spec, env-overridable
      maxAgentsPerTask: intFromEnv("ORCHESTRATOR_MAX_AGENTS_PER_TASK", 3, 1, 10),
      // Default raised 5 -> 12: a healthy task spends calls on planning, one
      // implementation attempt + retry, review, and possible fix rounds, so a
      // limit of 5 killed normal tasks once the tracker was actually fed.
      maxLLMCallsPerTask: intFromEnv("ORCHESTRATOR_MAX_LLM_CALLS_PER_TASK", 400, 1, 1_000),
      maxDelegationDepth: intFromEnv("ORCHESTRATOR_MAX_DELEGATION_DEPTH", 2, 0, 10),
      maxDelegations: intFromEnv("ORCHESTRATOR_MAX_DELEGATIONS", 10, 0, 100),
      // Phase 5: warn-only by default for ONE release cycle — the pre-call
      // gate logs budget.warning events instead of stopping tasks, so the
      // calibrated limits (12 calls / 50k tokens) can be observed against
      // real workloads before hard-stop enforcement becomes the default.
      // Set ORCHESTRATOR_BUDGET_MODE=enforce to opt into the hard stop now.
      budgetMode:
        (get("ORCHESTRATOR_BUDGET_MODE") ?? "").trim().toLowerCase() === "enforce"
          ? "enforce"
          : "warn",
      // Phase 4: this field is LIVE. Phase 4 hardening: it sizes the
      // PER-TASK LLM gate — the runner creates one LlmConcurrencyGate per
      // task run from this value, so concurrent tasks each honor their
      // own policy. The separate WORKER-WIDE gate (total provider
      // pressure across tasks) is worker configuration: the
      // WORKER_LLM_MAX_CONCURRENCY env var, bootstrapped once from this
      // policy value by the worker entrypoint — never resized per task.
      // Sequential-by-default: a limit of 1 keeps LLM calls one-by-one so
      // tasks and subtasks never overlap (WORKER_CONCURRENCY=1 + FIFO
      // scheduler). Raise ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS for
      // provider-parallel work.
      // Follows the parallel default so side-by-side nodes do not queue on
      // the LLM gate (1 unless worktree isolation is on).
      maxConcurrentLLMCalls: intFromEnv("ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", parallelism, 1, 8),
      maxTokenBudgetPerTask: intFromEnv("ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK", 2_000_000, 1_000, 100_000_000),
      // Plan 040 (D8): off by default; unmatched work is BLOCKED, never the CTO.
      allowFallback: boolFromEnv("ORCHESTRATOR_ALLOW_FALLBACK", false),
      orchestratorAuthoritative: boolFromEnv("ORCHESTRATOR_AUTHORITATIVE", true),
      // Plan 006 Phase 1: the router is deterministic by default; the advisor
      // turns on only when the flag is set (Phase 4 wires the real call).
      routerLlmMode:
        (get("ORCHESTRATOR_ROUTER_LLM") ?? "").trim().toLowerCase() ===
        "always"
          ? "always"
          : (get("ORCHESTRATOR_ROUTER_LLM") ?? "").trim().toLowerCase() ===
              "ambiguous"
            ? "ambiguous"
            : "off",
      chatMaxAgents: intFromEnv("ORCHESTRATOR_CHAT_MAX_AGENTS", 1, 1, 5),
      // Global default; an agent's own `executionRuntime` overrides it
      // (resolveExecutionRuntime). ORCHESTRATOR_EXECUTION_RUNTIME wins over
      // the legacy ORCHESTRATOR_RUNTIME; "opencode" aliases "native-provider".
      executionRuntime: legacyExecutionRuntime(rawEnv),
      worktreeIsolation,
      // Plan 013 step 7: the decision engine is the only orchestrator path
      // (flag deleted; default is irrevocably on).
      // Plan 005 Phase 4 Step 4.3 (enabled once Phase 4 tests went green):
      // the advisor is consulted only on ambiguous observations; the
      // deterministic policy decisions still win via validateDecision.
      decisionLlmMode:
        (get("ORCHESTRATOR_DECISION_LLM") ?? "").trim().toLowerCase() === "always"
          ? "always"
          : (get("ORCHESTRATOR_DECISION_LLM") ?? "").trim().toLowerCase() === "off"
            ? "off"
            : "ambiguous",
      maxDecisionSteps: intFromEnv("ORCHESTRATOR_MAX_DECISION_STEPS", 20, 1, 200),
      toolLoop: boolFromEnv("ORCHESTRATOR_TOOL_LOOP", false),
      mcpToolLoop: boolFromEnv("ORCHESTRATOR_MCP_TOOL_LOOP", true),
      mcpWriteTools: boolFromEnv("ORCHESTRATOR_MCP_WRITE_TOOLS", false),
      mcpMaxToolIterations: intFromEnv("ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS", 6, 1, 20),
      mcpTimeoutMs: intFromEnv("ORCHESTRATOR_MCP_TIMEOUT_MS", 30_000, 1_000, 300_000),
      mcpMaxResultChars: intFromEnv("ORCHESTRATOR_MCP_MAX_RESULT_CHARS", 8_000, 500, 200_000),
      // Plan 036: the Agent Reach web tool. Enabled by default; an agent must
      // still declare `web_reach` in its `supportedTools` to get it.
      agentReachEnabled: boolFromEnv("ORCHESTRATOR_AGENT_REACH_ENABLED", true),
      agentReachCommand: (get("ORCHESTRATOR_AGENT_REACH_COMMAND") ?? "agent-reach").trim() || "agent-reach",
      agentReachTimeoutMs: intFromEnv("ORCHESTRATOR_AGENT_REACH_TIMEOUT_MS", 60_000, 1_000, 300_000),
      agentReachMaxItems: intFromEnv("ORCHESTRATOR_AGENT_REACH_MAX_ITEMS", 10, 1, 20),
      agentReachMaxToolIterations: intFromEnv("ORCHESTRATOR_AGENT_REACH_MAX_TOOL_ITERATIONS", 4, 1, 20),
      reviewMode: planningModeFromEnv("ORCHESTRATOR_REVIEW_MODE"),
      qaMode: planningModeFromEnv("ORCHESTRATOR_QA_MODE", "auto"),
      // QA gets its own, smaller fix budget than review (QA audit §5).
      qaMaxFixIterations: intFromEnv("ORCHESTRATOR_QA_MAX_FIX_ITERATIONS", intFromEnv("QA_MAX_FIX_ITERATIONS", 1, 0, 5), 0, 5),
      qaRequired: boolFromEnv("ORCHESTRATOR_QA_REQUIRED", boolFromEnv("QA_REQUIRED", false)),
      loadAwareRouting: boolFromEnv("ORCHESTRATOR_LOAD_AWARE_ROUTING", false),
      performanceRouting: boolFromEnv("ORCHESTRATOR_PERFORMANCE_ROUTING", false),
    };
  }

  return loadPolicy();
}

// ── Non-policy readers, verbatim (env/get passed in) ──────────────────────

/** B5 reference: the one LLM fallback (worker and Convex). */
export function b5GlobalLLMConfig(e: Env) {
  const provider = (e.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const openai = provider === "openai-compatible" || provider === "openai";
  return {
    provider,
    model: e.LLM_MODEL ?? (openai ? "gpt-4o-mini" : "claude-sonnet-4-20250514"),
    baseUrl: (openai ? e.LLM_OPENAI_BASE_URL : e.LLM_ANTHROPIC_BASE_URL) ?? e.LLM_BASE_URL ?? (openai ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"),
    apiKey: e.LLM_API_KEY ?? e.OPENAI_API_KEY ?? "",
  };
}
export const legacyGlobalLLMConfig = b5GlobalLLMConfig;

/** llm.ts intEnv */
function llmIntEnv(name: string, fallback: number, min: number, max: number, env: Env): number {
  return b3Int(env[name], fallback, min, max);
}
export const legacyLlmMaxTokens = (env: Env) => llmIntEnv("ORCHESTRATOR_LLM_MAX_TOKENS", 8192, 256, 200_000, env);
export const legacyLlmTimeoutMs = (env: Env) => llmIntEnv("ORCHESTRATOR_LLM_TIMEOUT_MS", 300_000, 1_000, 3_600_000, env);

/** utils/stallDetector.ts */
function stallIntEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value === 0 && min > 0 && name === "ORCHESTRATOR_STALL_TIMEOUT_MS") return 0;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
export function legacyStallThresholds(env: Env, llmTimeoutMs = 300_000) {
  return {
    agentStallMs: stallIntEnv(env, "ORCHESTRATOR_STALL_TIMEOUT_MS", llmTimeoutMs + 60_000, 10_000, 3_600_000),
    agentStallRetries: stallIntEnv(env, "ORCHESTRATOR_STALL_RETRIES", 1, 0, 3),
    repeatedOutputLimit: stallIntEnv(env, "ORCHESTRATOR_REPEAT_OUTPUT_LIMIT", 2, 2, 10),
  };
}

/** index.ts startup constants (module load, after dotenv) */
export function legacyIndexConstants(env: Env) {
  const POLL_MS = b3Int(env.WORKER_POLL_INTERVAL_MS, 1500, 100);
  return {
    POLL_MS,
    FALLBACK_POLL_MS: Math.max(POLL_MS, b3Int(env.WORKER_FALLBACK_POLL_MS, 10_000, 100)),
    HEARTBEAT_MS: b3Int(env.WORKER_HEARTBEAT_MS, 10_000, 1000),
    LEASE_MS: b3Int(env.WORKER_LEASE_MS, 60_000, 1000),
    CONCURRENCY: b3Int(env.WORKER_CONCURRENCY, 1, 1),
    STALE_GRACE_MS: b3Int(env.WORKER_STALE_GRACE_MS, 30_000, 0),
    PUSH_POLL_MS: b3Int(env.WORKER_PUSH_POLL_MS, 5000, 1000),
    MCP_TEST_POLL_MS: b3Int(env.WORKER_MCP_TEST_POLL_MS, 3000, 1000),
    REPO_TOOL_IDLE_POLL_MS: b3Int(env.WORKER_REPO_TOOL_POLL_MS, 1000, 250),
    OPENCODE_CATALOG_POLL_MS: b3Int(env.WORKER_OPENCODE_CATALOG_POLL_MS, 15_000, 5_000),
    WORKER_ID: env.WORKER_ID,
    CONVEX_SERVICE_TOKEN: env.CONVEX_SERVICE_TOKEN,
    // The startup log shows the CONVEX_URL alias too.
    LOG_CONVEX_URL: env.NEXT_PUBLIC_CONVEX_URL ?? env.CONVEX_URL,
  };
}

/** convexClient.ts */
export const legacyConvexUrl = (env: Env) => env.NEXT_PUBLIC_CONVEX_URL ?? env.CONVEX_URL;
export const legacySubscribe = (env: Env) => b2Bool(env.WORKER_SUBSCRIBE, true);

/** direct/index.ts */
export const legacyDirectPollMs = (env: Env) => b3Int(env.DIRECT_POLL_MS, 750, 250);
export function legacyDirectIdleMs(env: Env): number {
  const minutes = Number(env.DIRECT_IDLE_MIN ?? 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
}
export function legacyDirectMaxLive(env: Env): number {
  const n = Math.floor(Number(env.DIRECT_MAX_LIVE ?? 4));
  return Math.min(8, Math.max(1, Number.isFinite(n) ? n : 4));
}
export const legacyDirectEngineApiLoop = (env: Env) => (env.DIRECT_ENGINE ?? "").trim() === "api-loop";

/** effects/llmCall.ts workerGateLimitFromEnv */
export function legacyWorkerGateLimit(env: Env): number {
  const raw = env.WORKER_LLM_MAX_CONCURRENCY ?? env.ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 1;
}

/** llm/roundRobin.ts */
export const legacyStickyLimit = (env: Env) => Number(env.LLM_ROUND_ROBIN_STICKY_LIMIT) || 1;

/** execution/nativeProvider.ts */
export const legacyNativeProviderCommand = (env: Env) => env.ORCHESTRATOR_NATIVE_PROVIDER_COMMAND ?? "opencode";
export function legacyNativeTimeoutMs(env: Env): number {
  const parsed = Number(env.ORCHESTRATOR_NATIVE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10 * 60 * 1000;
}
export const legacyVerifyPolicy = (env: Env) => b2Bool(env.FHARA_OPENCODE_VERIFY_POLICY, true);

/** execution/opencodeDetect.ts */
export const legacyAllowUnisolated = (env: Env) => b2Bool(env.ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED, false);

/** execution/opencodeHome.ts (default dir part) */
export const legacyOpencodeCacheDir = (env: Env) => env.FHARA_OPENCODE_CACHE_DIR?.trim() || "<tmp>";

/** execution/qa.ts */
export function legacyQaStartupTimeoutMs(get: Get): number {
  const fromEnv = Number(get("QA_STARTUP_TIMEOUT_MS") ?? get("QA_SERVER_START_TIMEOUT_MS"));
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 90_000;
}
export const legacyQaChromiumPath = (get: Get) => get("QA_CHROMIUM_PATH")?.trim() || undefined;
/** noSandbox for (isRoot || inContainer) = auto */
// Since the knob became auto/true/false: "auto" and unknown words mean auto, the bool words force it.
export function legacyNoSandbox(get: Get, auto: boolean): boolean {
  const flag = (get("QA_CHROMIUM_NO_SANDBOX") ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(flag)) return false;
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  return auto;
}
export const legacyQaBaseUrl = (env: Env) => env.QA_BASE_URL;

/** execution/repoMap.ts */
export function legacyRepoMapEnabled(env: Env): boolean {
  return b2Bool(env.REPO_MAP, true);
}
export function legacyRepoMapMaxChars(env: Env): number {
  const value = Number(env.REPO_MAP_MAX_CHARS);
  return Number.isFinite(value) && value >= 200 ? Math.floor(value) : 4_000;
}
export const legacyCacheDir = (env: Env) => env.FHARA_CACHE_DIR ?? "<home>";

/** execution/verifyBaseline.ts */
export function legacyBaselineEnabled(env: Env): boolean {
  return b2Bool(env.ORCHESTRATOR_VERIFY_BASELINE, true);
}

/** services/runner/commandApproval.ts */
export function legacyCommandApprovalTimeoutMs(env: Env): number {
  const raw = Number(env.ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 10 * 60_000;
}

/** commitMessage / memoryReconcile / roleLearnings / WORKER_SUBSCRIBE */
export const legacyNeq0 = (env: Env, name: string) => b2Bool(env[name], true);

/** tools/gitPush.ts envFlag, tools/githubPr.ts draft */
export const legacyEnvFlag = (get: Get, name: string) => b2Bool(get(name), false);
export const legacyPrDraft = (get: Get) => b2Bool(get("FHARA_PR_DRAFT"), true);

/** tools/webClient.ts */
export const legacyStagehandModel = (env: Env) => env.STAGEHAND_MODEL ?? "anthropic/claude-sonnet-4-20250514";
export const legacyStagehandKey = (env: Env) => env.STAGEHAND_API_KEY ?? "";

/** services/appSettings.ts */
// B7: the root is absolute, measured from packages/worker (file-relative).
export const legacyWorkspaceRoot = (get: Get) => nodePath.resolve(WORKER_DIR, get("WORKSPACE_ROOT")?.trim() || "./workspaces");

/** llm/crypto.ts */
export const legacyEncryptionKey = (env: Env) => env.PROVIDER_ENCRYPTION_KEY;
