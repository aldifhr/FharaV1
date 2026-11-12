import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_SCHEMA, schemaDefault, setEnvIssueSink, type EnvVar } from "@fhara/config";
import { wenv, wenvRaw, type WorkerVarName } from "@fhara/config/worker";
import { setSettingOverrides, settingEnv } from "@/api/convex/lib/appSettings";
import { loadPolicy, DEFAULT_SUBTASK_TIMEOUT_MS } from "@/orchestrator/policy";
import { getGlobalLLMConfig, llmMaxTokens, llmTimeoutMs, DEFAULT_LLM_MAX_TOKENS, DEFAULT_LLM_TIMEOUT_MS } from "@/llm";
import { stallThresholdsFromEnv } from "@/utils/stallDetector";
import { executionRuntimeFromEnv, nativeTimeoutMs, DEFAULT_NATIVE_TIMEOUT_MS } from "@/execution/nativeProvider";
import { opencodeAllowUnisolated } from "@/execution/opencodeDetect";
import { repoMapEnabled, repoMapMaxChars } from "@/execution/repoMap";
import { baselineEnabled } from "@/execution/verifyBaseline";
import { DEFAULT_WORKSPACE_ROOT, effectiveWorkspaceRoot } from "@/services/appSettings";
import * as L from "./legacyEnv";

/**
 * E1 parity: every worker env read through @fhara/config returns exactly
 * what the pre-E1 inline code returned (frozen copies in legacyEnv.ts), for
 * a matrix of awkward raw values and for random multi-var envs. Quirks
 * (NaN from index.ts, "" → true for falsy-list bools, parseInt accepting
 * "10s", …) are preserved on purpose; B1–B10 change them later.
 */

const RAW: readonly (string | undefined)[] = [
  undefined, "", " ", "0", "1", "-1", "2", "3", "5", "7.9", "10s", "abc", "1e3", "250", "999", "1000", "4000",
  "30000", "86400000", "9999999999", "Infinity", "NaN", "true", "false", "TRUE", "on", "off", "yes", "no", " 1 ",
  " 0 ", "auto", "always", "ambiguous", "never", "enforce", "warn", "native-provider", "opencode", "OpenCode",
  "api-loop", "API-LOOP", " api-loop ", "openai", "OpenAI-Compatible", "anthropic", "/x/y", "  /x  ",
];

type Env = Record<string, string | undefined>;
const get = (env: Env) => (name: string) => env[name];

const silence = () => setEnvIssueSink(() => {});
afterEach(() => {
  setEnvIssueSink(null);
  setSettingOverrides({});
});

/** Run `fn` with process.env holding exactly the given Fhara keys (others untouched). */
function withProcessEnv<T>(env: Env, fn: () => T): T {
  const names = (ENV_SCHEMA as readonly EnvVar[]).map((d) => d.name);
  const saved: Env = {};
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

const POLICY_NAMES = (ENV_SCHEMA as readonly EnvVar[])
  .filter((d) => d.group === "policy")
  .map((d) => d.name)
  .concat(["ORCHESTRATOR_EXECUTION_RUNTIME", "ORCHESTRATOR_RUNTIME"]);

describe("loadPolicy parity (E1)", () => {
  it("equals the pre-E1 loadPolicy with an empty env", () => {
    withProcessEnv({}, () => expect(loadPolicy()).toEqual(L.legacyLoadPolicy(get({}), {})));
  });

  it("equals the pre-E1 loadPolicy for every policy var × every awkward raw value", () => {
    silence();
    for (const name of POLICY_NAMES) {
      for (const raw of RAW) {
        const env: Env = { [name]: raw };
        // Also with isolation on, so the parallel-default chain is exercised.
        for (const extra of [{}, { ORCHESTRATOR_WORKTREE_ISOLATION: "true" }]) {
          const full = { ...extra, ...env };
          withProcessEnv(full, () => {
            expect({ name, raw, policy: loadPolicy() }).toEqual({ name, raw, policy: L.legacyLoadPolicy(get(full), full) });
          });
        }
      }
    }
  });

  it("equals the pre-E1 loadPolicy for random multi-var envs", () => {
    silence();
    const arbEnv = fc.dictionary(fc.constantFrom(...POLICY_NAMES), fc.constantFrom(...RAW.filter((r) => r !== undefined)) as fc.Arbitrary<string>, {
      maxKeys: 12,
    });
    fc.assert(
      fc.property(arbEnv, (env) =>
        withProcessEnv(env, () => {
          expect(loadPolicy()).toEqual(L.legacyLoadPolicy(get(env), env));
        })
      ),
      { numRuns: 400 }
    );
  });

  it("knob overrides win over the env exactly as before (settingEnv)", () => {
    silence();
    const env: Env = { ORCHESTRATOR_TASK_TIMEOUT_MS: "120000", ORCHESTRATOR_QA_MODE: "never", ORCHESTRATOR_TOOL_LOOP: "1" };
    const overrides = {
      ORCHESTRATOR_TASK_TIMEOUT_MS: "300000",
      ORCHESTRATOR_WORKTREE_ISOLATION: "true",
      ORCHESTRATOR_ROUTER_LLM: "always",
      ORCHESTRATOR_QA_REQUIRED: "false",
      ORCHESTRATOR_APPROVAL_TIMEOUT_MS: "abc",
    };
    withProcessEnv(env, () => {
      setSettingOverrides(overrides);
      const merged = (n: string) => settingEnv(n);
      expect(loadPolicy()).toEqual(L.legacyLoadPolicy(merged, env));
    });
  });

  it("subtaskTimeoutFromEnv still reads raw process.env presence (no knob source)", () => {
    silence();
    withProcessEnv({ ORCHESTRATOR_SUBTASK_TIMEOUT_MS: "" }, () => expect(loadPolicy().subtaskTimeoutFromEnv).toBe(false));
    withProcessEnv({ ORCHESTRATOR_SUBTASK_TIMEOUT_MS: "abc" }, () => expect(loadPolicy().subtaskTimeoutFromEnv).toBe(true));
  });
});

/** [schema var, reader through the new code, frozen pre-E1 reader] over a raw value for that var. */
const RECORD_CASES: Array<[string, (env: Env) => unknown, (env: Env) => unknown]> = [
  ["ORCHESTRATOR_LLM_MAX_TOKENS", (e) => llmMaxTokens(e), L.legacyLlmMaxTokens],
  ["ORCHESTRATOR_LLM_TIMEOUT_MS", (e) => llmTimeoutMs(e), L.legacyLlmTimeoutMs],
  ["ORCHESTRATOR_STALL_TIMEOUT_MS", (e) => stallThresholdsFromEnv(e, 123_000), (e) => L.legacyStallThresholds(e, 123_000)],
  ["ORCHESTRATOR_STALL_RETRIES", (e) => stallThresholdsFromEnv(e), (e) => L.legacyStallThresholds(e)],
  ["ORCHESTRATOR_REPEAT_OUTPUT_LIMIT", (e) => stallThresholdsFromEnv(e), (e) => L.legacyStallThresholds(e)],
  ["ORCHESTRATOR_EXECUTION_RUNTIME", (e) => executionRuntimeFromEnv(e), L.legacyExecutionRuntime],
  ["ORCHESTRATOR_RUNTIME", (e) => executionRuntimeFromEnv(e), L.legacyExecutionRuntime],
  ["ORCHESTRATOR_NATIVE_TIMEOUT_MS", (e) => nativeTimeoutMs(e), L.legacyNativeTimeoutMs],
  ["ORCHESTRATOR_NATIVE_PROVIDER_COMMAND", (e) => wenv("ORCHESTRATOR_NATIVE_PROVIDER_COMMAND", e), L.legacyNativeProviderCommand],
  ["ORCHESTRATOR_NATIVE_PROVIDER_COMMAND", (e) => wenvRaw("ORCHESTRATOR_NATIVE_PROVIDER_COMMAND", e), (e) => e.ORCHESTRATOR_NATIVE_PROVIDER_COMMAND],
  ["FHARA_OPENCODE_VERIFY_POLICY", (e) => wenv("FHARA_OPENCODE_VERIFY_POLICY", e), L.legacyVerifyPolicy],
  ["ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED", (e) => opencodeAllowUnisolated(e), L.legacyAllowUnisolated],
  ["FHARA_OPENCODE_CACHE_DIR", (e) => wenv("FHARA_OPENCODE_CACHE_DIR", e) || "<tmp>", L.legacyOpencodeCacheDir],
  ["REPO_MAP", (e) => repoMapEnabled(e), L.legacyRepoMapEnabled],
  ["REPO_MAP_MAX_CHARS", (e) => repoMapMaxChars(e), L.legacyRepoMapMaxChars],
  ["FHARA_CACHE_DIR", (e) => wenv("FHARA_CACHE_DIR", e) ?? "<home>", L.legacyCacheDir],
  ["ORCHESTRATOR_VERIFY_BASELINE", (e) => baselineEnabled(e), L.legacyBaselineEnabled],
  ["WORKER_LLM_MAX_CONCURRENCY", (e) => wenv("WORKER_LLM_MAX_CONCURRENCY", e), L.legacyWorkerGateLimit],
  ["ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", (e) => wenv("WORKER_LLM_MAX_CONCURRENCY", e), L.legacyWorkerGateLimit],
  ["LLM_ROUND_ROBIN_STICKY_LIMIT", (e) => wenv("LLM_ROUND_ROBIN_STICKY_LIMIT", e), L.legacyStickyLimit],
  ["ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS", (e) => wenv("ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS", e), L.legacyCommandApprovalTimeoutMs],
  ["WORKER_SUBSCRIBE", (e) => wenv("WORKER_SUBSCRIBE", e), L.legacySubscribe],
  ["FHARA_COMMIT_MESSAGE_LLM", (e) => wenv("FHARA_COMMIT_MESSAGE_LLM", e), (e) => L.legacyNeq0(e, "FHARA_COMMIT_MESSAGE_LLM")],
  ["FHARA_MEMORY_SUGGESTIONS", (e) => wenv("FHARA_MEMORY_SUGGESTIONS", e), (e) => L.legacyNeq0(e, "FHARA_MEMORY_SUGGESTIONS")],
  ["FHARA_ROLE_MEMORY", (e) => wenv("FHARA_ROLE_MEMORY", e), (e) => L.legacyNeq0(e, "FHARA_ROLE_MEMORY")],
  ["NEXT_PUBLIC_CONVEX_URL", (e) => wenv("NEXT_PUBLIC_CONVEX_URL", e), L.legacyConvexUrl],
  ["CONVEX_URL", (e) => wenv("NEXT_PUBLIC_CONVEX_URL", e), L.legacyConvexUrl],
  ["QA_BASE_URL", (e) => wenv("QA_BASE_URL", e), L.legacyQaBaseUrl],
  ["STAGEHAND_MODEL", (e) => wenv("STAGEHAND_MODEL", e), L.legacyStagehandModel],
  ["STAGEHAND_API_KEY", (e) => wenv("STAGEHAND_API_KEY", e), L.legacyStagehandKey],
  ["PROVIDER_ENCRYPTION_KEY", (e) => wenv("PROVIDER_ENCRYPTION_KEY", e), L.legacyEncryptionKey],
  ["LLM_PROVIDER", (e) => getGlobalLLMConfig(e), L.legacyGlobalLLMConfig],
  ["LLM_MODEL", (e) => getGlobalLLMConfig(e), L.legacyGlobalLLMConfig],
  ["LLM_BASE_URL", (e) => getGlobalLLMConfig(e), L.legacyGlobalLLMConfig],
  ["LLM_API_KEY", (e) => getGlobalLLMConfig(e), L.legacyGlobalLLMConfig],
  ["OPENAI_API_KEY", (e) => getGlobalLLMConfig(e), L.legacyGlobalLLMConfig],
];

/** index.ts constants: same names as legacyIndexConstants returns. */
function indexConstants(env: Env) {
  const POLL_MS = wenv("WORKER_POLL_INTERVAL_MS", env);
  return {
    POLL_MS,
    FALLBACK_POLL_MS: Math.max(POLL_MS, wenv("WORKER_FALLBACK_POLL_MS", env)),
    HEARTBEAT_MS: wenv("WORKER_HEARTBEAT_MS", env),
    LEASE_MS: wenv("WORKER_LEASE_MS", env),
    CONCURRENCY: wenv("WORKER_CONCURRENCY", env),
    STALE_GRACE_MS: wenv("WORKER_STALE_GRACE_MS", env),
    PUSH_POLL_MS: wenv("WORKER_PUSH_POLL_MS", env),
    MCP_TEST_POLL_MS: wenv("WORKER_MCP_TEST_POLL_MS", env),
    REPO_TOOL_IDLE_POLL_MS: wenv("WORKER_REPO_TOOL_POLL_MS", env),
    OPENCODE_CATALOG_POLL_MS: wenv("WORKER_OPENCODE_CATALOG_POLL_MS", env),
    WORKER_ID: wenv("WORKER_ID", env),
    CONVEX_SERVICE_TOKEN: wenv("CONVEX_SERVICE_TOKEN", env),
    LOG_CONVEX_URL: wenv("NEXT_PUBLIC_CONVEX_URL", env),
  };
}
const INDEX_NAMES = [
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_FALLBACK_POLL_MS",
  "WORKER_HEARTBEAT_MS",
  "WORKER_LEASE_MS",
  "WORKER_CONCURRENCY",
  "WORKER_STALE_GRACE_MS",
  "WORKER_PUSH_POLL_MS",
  "WORKER_MCP_TEST_POLL_MS",
  "WORKER_REPO_TOOL_POLL_MS",
  "WORKER_OPENCODE_CATALOG_POLL_MS",
  "WORKER_ID",
  "CONVEX_SERVICE_TOKEN",
  "NEXT_PUBLIC_CONVEX_URL",
  "CONVEX_URL",
];

/** Knob-aware readers (settingEnv): [var, new, legacy(get)]. */
const SETTING_CASES: Array<[string, () => unknown, (g: (n: string) => string | undefined) => unknown]> = [
  ["QA_STARTUP_TIMEOUT_MS", () => wenv("QA_STARTUP_TIMEOUT_MS", settingEnv), L.legacyQaStartupTimeoutMs],
  ["QA_SERVER_START_TIMEOUT_MS", () => wenv("QA_STARTUP_TIMEOUT_MS", settingEnv), L.legacyQaStartupTimeoutMs],
  ["QA_CHROMIUM_PATH", () => wenv("QA_CHROMIUM_PATH", settingEnv), L.legacyQaChromiumPath],
  ...[true, false].map(
    (auto) =>
      [
        "QA_CHROMIUM_NO_SANDBOX",
        () => {
          const flag = wenv("QA_CHROMIUM_NO_SANDBOX", settingEnv);
          return flag === false ? false : flag === true || auto;
        },
        (g: (n: string) => string | undefined) => L.legacyNoSandbox(g, auto),
      ] as [string, () => unknown, (g: (n: string) => string | undefined) => unknown]
  ),
  ["FHARA_ALLOW_FORCE_PUSH", () => wenv("FHARA_ALLOW_FORCE_PUSH", settingEnv), (g) => L.legacyEnvFlag(g, "FHARA_ALLOW_FORCE_PUSH")],
  [
    "FHARA_ALLOW_BASE_BRANCH_PUSH",
    () => wenv("FHARA_ALLOW_BASE_BRANCH_PUSH", settingEnv),
    (g) => L.legacyEnvFlag(g, "FHARA_ALLOW_BASE_BRANCH_PUSH"),
  ],
  ["FHARA_PR_DRAFT", () => wenv("FHARA_PR_DRAFT", settingEnv), L.legacyPrDraft],
  ["WORKSPACE_ROOT", () => effectiveWorkspaceRoot(), L.legacyWorkspaceRoot],
];

describe("worker reader parity (E1)", () => {
  it("each migrated reader equals its pre-E1 copy for every awkward raw value", () => {
    silence();
    for (const [name, now, before] of RECORD_CASES) {
      for (const raw of RAW) {
        const env: Env = { [name]: raw };
        expect({ name, raw, value: now(env) }).toEqual({ name, raw, value: before(env) });
      }
    }
  });

  it("alias chains keep `??` order (an empty primary wins over the alias)", () => {
    silence();
    const pairs: Array<[string, string, (env: Env) => unknown, (env: Env) => unknown]> = [
      ["NEXT_PUBLIC_CONVEX_URL", "CONVEX_URL", (e) => wenv("NEXT_PUBLIC_CONVEX_URL", e), L.legacyConvexUrl],
      ["ORCHESTRATOR_EXECUTION_RUNTIME", "ORCHESTRATOR_RUNTIME", (e) => executionRuntimeFromEnv(e), L.legacyExecutionRuntime],
      ["LLM_API_KEY", "OPENAI_API_KEY", (e) => getGlobalLLMConfig(e), L.legacyGlobalLLMConfig],
      ["WORKER_LLM_MAX_CONCURRENCY", "ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS", (e) => wenv("WORKER_LLM_MAX_CONCURRENCY", e), L.legacyWorkerGateLimit],
    ];
    for (const [primary, alias, now, before] of pairs) {
      for (const a of RAW) {
        for (const b of ["", "3", "opencode", "x"]) {
          const env: Env = { [primary]: a, [alias]: b };
          expect(now(env)).toEqual(before(env));
        }
      }
    }
  });

  it("index.ts startup constants equal the oracle (B3 rules)", () => {
    silence();
    for (const name of INDEX_NAMES) {
      for (const raw of RAW) {
        const env: Env = { [name]: raw };
        expect({ name, raw, c: indexConstants(env) }).toEqual({ name, raw, c: L.legacyIndexConstants(env) });
      }
    }
    // B3: no NaN, "" is the default.
    expect(indexConstants({ WORKER_CONCURRENCY: "10s" }).CONCURRENCY).toBe(1);
    expect(indexConstants({ WORKER_HEARTBEAT_MS: "" }).HEARTBEAT_MS).toBe(10_000);
  });

  it("knob-aware readers equal the pre-E1 copies, with and without a UI override", () => {
    silence();
    for (const [name, now, before] of SETTING_CASES) {
      for (const raw of RAW) {
        for (const override of [undefined, "", "1", "false", "45000", " /opt/c "]) {
          withProcessEnv({ [name]: raw }, () => {
            setSettingOverrides(override === undefined ? {} : { [name]: override });
            expect({ name, raw, override, value: now() }).toEqual({ name, raw, override, value: before(settingEnv) });
          });
        }
      }
    }
  });
});

describe("schema defaults equal the removed literals (E1)", () => {
  const literal: Record<string, unknown> = {
    WORKER_POLL_INTERVAL_MS: 1500,
    WORKER_FALLBACK_POLL_MS: 10_000,
    WORKER_HEARTBEAT_MS: 10_000,
    WORKER_LEASE_MS: 60_000,
    WORKER_CONCURRENCY: 1,
    WORKER_STALE_GRACE_MS: 30_000,
    WORKER_PUSH_POLL_MS: 5000,
    WORKER_MCP_TEST_POLL_MS: 3000,
    WORKER_REPO_TOOL_POLL_MS: 1000,
    WORKER_OPENCODE_CATALOG_POLL_MS: 15_000,
    WORKER_LLM_MAX_CONCURRENCY: 1,
    WORKER_SUBSCRIBE: true,
    LLM_PROVIDER: "anthropic",
    LLM_MODEL: "claude-sonnet-4-20250514",
    LLM_BASE_URL: "https://api.anthropic.com/v1",
    LLM_API_KEY: "",
    LLM_ROUND_ROBIN_STICKY_LIMIT: 1,
    ORCHESTRATOR_LLM_MAX_TOKENS: 8192,
    ORCHESTRATOR_LLM_TIMEOUT_MS: 300_000,
    STAGEHAND_API_KEY: "",
    STAGEHAND_MODEL: "anthropic/claude-sonnet-4-20250514",
    ORCHESTRATOR_EXECUTION_RUNTIME: "api",
    ORCHESTRATOR_NATIVE_PROVIDER_COMMAND: "opencode",
    ORCHESTRATOR_NATIVE_TIMEOUT_MS: 600_000,
    ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED: false,
    ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS: 600_000,
    ORCHESTRATOR_STALL_TIMEOUT_MS: 360_000,
    ORCHESTRATOR_STALL_RETRIES: 1,
    ORCHESTRATOR_REPEAT_OUTPUT_LIMIT: 2,
    ORCHESTRATOR_VERIFY_BASELINE: true,
    REPO_MAP: true,
    REPO_MAP_MAX_CHARS: 4000,
    FHARA_COMMIT_MESSAGE_LLM: true,
    FHARA_OPENCODE_VERIFY_POLICY: true,
    FHARA_MEMORY_SUGGESTIONS: true,
    FHARA_ROLE_MEMORY: true,
    FHARA_ALLOW_FORCE_PUSH: false,
    FHARA_ALLOW_BASE_BRANCH_PUSH: false,
    FHARA_PR_DRAFT: true,
    QA_STARTUP_TIMEOUT_MS: 90_000,
    WORKSPACE_ROOT: "./workspaces",
    ORCHESTRATOR_SUBTASK_TIMEOUT_MS: 900_000,
    ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS: 900_000,
    ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS: 2_400_000,
    ORCHESTRATOR_MAX_CONCURRENCY: 1,
    ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS: 1,
    ORCHESTRATOR_MAX_PLANNING_ITERATIONS: 1,
    ORCHESTRATOR_QA_MAX_FIX_ITERATIONS: 1,
    ORCHESTRATOR_QA_REQUIRED: false,
  };

  it("matches each pre-E1 literal default", () => {
    for (const [name, value] of Object.entries(literal)) expect({ name, d: schemaDefault(name) }).toEqual({ name, d: value });
  });

  it("re-exported constants keep their values", () => {
    expect(DEFAULT_SUBTASK_TIMEOUT_MS).toBe(900_000);
    expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192);
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_NATIVE_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_WORKSPACE_ROOT).toBe("./workspaces");
  });

  it("every worker var is readable with an empty env and never throws", () => {
    silence();
    for (const def of ENV_SCHEMA as readonly EnvVar[]) {
      if (!def.runtimes.includes("worker")) continue;
      expect(() => wenv(def.name as WorkerVarName, {})).not.toThrow();
    }
  });
});
