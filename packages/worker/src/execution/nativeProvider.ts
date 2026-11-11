import { schemaDefault } from "@fhara/config";
import { wenv } from "@fhara/config/worker";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventSink } from "@/types/events";
import { NATIVE_PROMPT_MESSAGE, workspaceHeader } from "@/prompts/native";
import { opencodePermissionBlock, parseRuleRows, READ_ONLY_OPENCODE_POLICY, rulesetPolicyViolation, type OpencodePolicy } from "./opencodePolicy";
import { OpencodeCredentialError, prepareOpencodeHome } from "./opencodeHome";

// Prompt text lives in `@/prompts/native`; re-exported for existing importers.
export { NATIVE_PROMPT_MESSAGE, workspaceHeader, buildNativePrompt } from "@/prompts/native";

/**
 * Provider-native runtime (plan 014): executes a subtask through a
 * provider CLI (OpenCode) running its own native tools inside the task
 * workspace. Returns structured output + usage for observability.
 * Provider sessions are per-call processes — no long-lived session id.
 *
 * OpenCode specifics (opencode-ai 1.x, `opencode run`):
 *  - `--format json` streams one JSON event per line (`text`, `tool_use`,
 *    `step_start`, `step_finish` with `part.tokens`, `error`). Plain-text
 *    output is still accepted as a fallback.
 *  - A temporary config (OPENCODE_CONFIG, 0600, deleted after the run)
 *    carries the safety permissions and — when the agent has no explicit
 *    OpenCode model — a custom provider pointing at Fhara's own LLM
 *    endpoint. The API key never lands in argv or in that file: the config
 *    references `{env:MOAGENT_OPENCODE_API_KEY}` and the key travels only in
 *    the child's environment.
 */

/** Per-agent runtime choice as stored on the agent row. */
export type AgentRuntimeChoice = "api" | "opencode";
/** Runtime the executor actually uses. */
export type ExecutionRuntime = "api" | "native-provider";

/**
 * Per-agent runtime overrides the global policy default:
 * agent "opencode" → native-provider, agent "api" → api, unset → global.
 */
export function resolveExecutionRuntime(
  agent: { executionRuntime?: AgentRuntimeChoice | string | null } | undefined,
  globalRuntime: ExecutionRuntime | undefined
): ExecutionRuntime {
  const choice = agent?.executionRuntime;
  if (choice === "opencode") return "native-provider";
  if (choice === "api") return "api";
  return globalRuntime ?? "api";
}

/** Global default from env. ORCHESTRATOR_EXECUTION_RUNTIME wins over the
 *  legacy ORCHESTRATOR_RUNTIME; "opencode" is an alias of "native-provider". */
export function executionRuntimeFromEnv(env?: Record<string, string | undefined>): ExecutionRuntime {
  return wenv("ORCHESTRATOR_EXECUTION_RUNTIME", env);
}

/**
 * Plan 035: the effective runtime and the model the CLI runs.
 *
 * The app-wide setting (Settings → LLM & Models) wins. The per-agent value
 * is legacy: it only applies when the setting was never written, so a
 * deployment that never opened the setting keeps its current behaviour.
 * The env default is the last resort for the runtime.
 */
export function resolveOpencodeSelection(input: {
  /** The app-wide setting; undefined = never configured. */
  globalRuntime?: "api" | "opencode";
  globalModel?: string;
  /** Legacy per-agent values. */
  agentRuntime?: AgentRuntimeChoice | string | null;
  agentModel?: string;
  /** The worker's env default (ORCHESTRATOR_EXECUTION_RUNTIME). */
  envDefault?: ExecutionRuntime;
}): { runtime: ExecutionRuntime; model?: string } {
  const hasGlobal = input.globalRuntime !== undefined;
  const runtime: ExecutionRuntime = hasGlobal
    ? input.globalRuntime === "opencode"
      ? "native-provider"
      : "api"
    : resolveExecutionRuntime({ executionRuntime: input.agentRuntime }, input.envDefault);
  const model = hasGlobal ? input.globalModel : input.agentModel;
  return { runtime, ...(model ? { model } : {}) };
}

export interface NativeRunResult {
  status: "completed" | "failed";
  output: string;
  /** Best-effort token usage; 0 when the provider does not report it. */
  inputTokens: number;
  outputTokens: number;
  rawExitCode?: number;
  timedOut?: boolean;
  /** Model the run was pinned to (`provider/model`), when any. */
  model?: string;
  /**
   * Plan 040 P3 breakdown, summed over `step_finish` events, each set only
   * when OpenCode reported it. `inputTokens` includes cache read + write;
   * `outputTokens` includes reasoning (subsets below).
   */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Sum of OpenCode's per-step `part.cost` (USD), when any step reported one. */
  costUsd?: number;
  /** Wall time of the whole `opencode run`. */
  durationMs?: number;
}

export function nativeProviderCommand(): string {
  return wenv("ORCHESTRATOR_NATIVE_PROVIDER_COMMAND");
}

export const DEFAULT_NATIVE_TIMEOUT_MS = schemaDefault("ORCHESTRATOR_NATIVE_TIMEOUT_MS") as number;

export function nativeTimeoutMs(env?: Record<string, string | undefined>): number {
  return wenv("ORCHESTRATOR_NATIVE_TIMEOUT_MS", env);
}

export interface SpawnOptions {
  cwd: string;
  signal?: AbortSignal;
  shell?: boolean;
  /** Full child environment (already scrubbed by buildChildEnv: never the raw process.env). */
  env?: NodeJS.ProcessEnv;
  /** Live stdout chunks, for streaming JSON events. */
  onStdout?: (chunk: string) => void;
}

/**
 * Totally injectable for tests: pass a spawn implementation to test
 * without a real CLI. Default is the real node:child_process spawn.
 */
export type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptions
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** Env var the generated config reads the API key from (never argv/file). */
export const OPENCODE_KEY_ENV = "MOAGENT_OPENCODE_API_KEY";
/** Provider id of the generated Fhara LLM provider (`fhara/<model>`). */
export const OPENCODE_PROVIDER_ID = "fhara";

export interface NativeArgvOptions {
  /** `provider/model` for `-m`. */
  model?: string;
  /** Request `--format json` (default true). */
  json?: boolean;
  /** Pass `--auto`: OpenCode then answers every "ask" with "once". Default
   *  false (L1): without it `opencode run` auto-rejects every "ask", so a
   *  permission Fhara did not list fails closed instead of running. */
  auto?: boolean;
  /** `--agent`: the per-run agent that carries Fhara's rules (L1). */
  agent?: string;
  /** `--dir`: pin OpenCode's project directory explicitly. */
  dir?: string;
}

/** The argv actually executed (exact-argv construction, no string interpolation). */
export function nativeArgv(
  command: string,
  promptFileArgs: string[],
  options: NativeArgvOptions = {}
): { command: string; args: string[] } {
  const args = ["run"];
  if (options.json ?? true) args.push("--format", "json");
  if (options.auto ?? false) args.push("--auto");
  if (options.agent) args.push("--agent", options.agent);
  if (options.dir) args.push("--dir", options.dir);
  if (options.model) args.push("-m", options.model);
  return { command, args: [...args, ...promptFileArgs] };
}

/** Minimal LLM config shape (matches GlobalLLMConfig in @/llm). */
export interface NativeLlmConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * O1: the static rule set (any shell command but `git push`/`git remote`,
 * no edit rule) is gone. Every run gets a per-run, deny-by-default policy
 * from `buildOpencodePolicy` (opencodePolicy.ts); a caller with no role
 * context gets this read-only one (no edits, no shell, no web).
 */
export const OPENCODE_PERMISSIONS: OpencodePolicy = READ_ONLY_OPENCODE_POLICY;

function providerPackageFor(provider: string): string | null {
  const p = provider.toLowerCase();
  if (p === "openai-compatible" || p === "openai") return "@ai-sdk/openai-compatible";
  if (p === "anthropic") return "@ai-sdk/anthropic";
  return null;
}

/**
 * Build the temporary OpenCode config + the model to pin.
 *  - explicit `model` (agent's OpenCode model): permissions only, `-m model`;
 *    OpenCode uses its own credentials for that provider.
 *  - otherwise, with a usable Fhara LLM config: a custom provider
 *    (`fhara`) pointed at that endpoint, `-m fhara/<model>`; the key is
 *    referenced as `{env:MOAGENT_OPENCODE_API_KEY}` and returned in `env`.
 *  - otherwise: permissions only, OpenCode's own default model.
 * The returned `config` never contains key material.
 */
export function buildOpencodeConfig(input: {
  model?: string;
  llm?: NativeLlmConfig;
  /** Per-run permissions; read-only when omitted. */
  policy?: OpencodePolicy;
  /** Provider blocks copied from the user's global OpenCode config (scoped home). */
  providerConfig?: Record<string, unknown>;
}): {
  config: Record<string, unknown>;
  model?: string;
  env: Record<string, string>;
} {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: opencodePermissionBlock(input.policy ?? OPENCODE_PERMISSIONS),
  };
  const explicit = input.model?.trim();
  if (explicit) {
    if (input.providerConfig && Object.keys(input.providerConfig).length > 0) config.provider = { ...input.providerConfig };
    return { config, model: explicit, env: {} };
  }
  const llm = input.llm;
  const pkg = llm ? providerPackageFor(llm.provider) : null;
  if (!llm || !pkg || !llm.baseUrl || !llm.model) return { config, env: {} };
  config.provider = {
    [OPENCODE_PROVIDER_ID]: {
      npm: pkg,
      name: "Fhara LLM",
      options: {
        baseURL: llm.baseUrl,
        ...(llm.apiKey ? { apiKey: `{env:${OPENCODE_KEY_ENV}}` } : {}),
      },
      models: { [llm.model]: { name: llm.model } },
    },
  };
  const model = `${OPENCODE_PROVIDER_ID}/${llm.model}`;
  config.model = model;
  return { config, model, env: llm.apiKey ? { [OPENCODE_KEY_ENV]: llm.apiKey } : {} };
}

// Availability is checked once per process per command (spawning
// `--version` per subtask costs ~1s with opencode).
const availabilityCache = new Map<string, Promise<boolean>>();

export function resetNativeAvailabilityCache(): void {
  availabilityCache.clear();
}

export function isNativeProviderAvailable(command = nativeProviderCommand()): Promise<boolean> {
  const cached = availabilityCache.get(command);
  if (cached) return cached;
  const probe = probeAvailability(command);
  availabilityCache.set(command, probe);
  return probe;
}

function probeAvailability(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(command, ["--version"], {
        env: buildChildEnv(),
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
      });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, 10_000);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

// ── JSON event parsing ────────────────────────────────────────────────

export type NativeEvent =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      tool: string;
      status: string;
      title?: string;
      target?: string;
      error?: string;
    }
  | {
      kind: "step_finish";
      inputTokens: number;
      outputTokens: number;
      reason?: string;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      cost?: number;
    }
  | { kind: "error"; message: string }
  | { kind: "other"; type: string };

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse one `opencode run --format json` line. Returns null for non-JSON
 * lines (plain-text fallback). Tool events carry only a short target
 * (file path / command / pattern), never full inputs or outputs.
 */
export function parseOpencodeEvent(line: string): NativeEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const rec = asRecord(parsed);
    if (!rec) return null;
    raw = rec;
  } catch {
    return null;
  }
  const type = String(raw.type ?? "");
  const part = asRecord(raw.part);
  if (type === "text") {
    const text = typeof part?.text === "string" ? part.text : typeof raw.text === "string" ? raw.text : "";
    return { kind: "text", text };
  }
  if (type === "tool_use" || type === "tool") {
    const state = asRecord(part?.state) ?? {};
    const input = asRecord(state.input) ?? {};
    const targetRaw = input.filePath ?? input.path ?? input.command ?? input.pattern ?? input.url;
    const target = typeof targetRaw === "string" ? targetRaw.slice(0, 200) : undefined;
    const errorRaw = state.error;
    return {
      kind: "tool",
      tool: String(part?.tool ?? raw.tool ?? "unknown"),
      status: String(state.status ?? "unknown"),
      ...(typeof state.title === "string" ? { title: state.title.slice(0, 200) } : {}),
      ...(target ? { target } : {}),
      ...(typeof errorRaw === "string" ? { error: errorRaw.slice(0, 500) } : {}),
    };
  }
  if (type === "step_finish") {
    // OpenCode StepFinishPart (packages/schema/src/v1/session.ts):
    // tokens { input, output, reasoning, cache { read, write } }, cost (USD).
    // `input` is the NON-cached input and `output` the visible output
    // (core/src/session/usage.ts), so the ledger totals add cache and
    // reasoning back in (plan 040 P3).
    const tokens = asRecord(part?.tokens) ?? asRecord(raw.tokens) ?? {};
    const cache = asRecord(tokens.cache);
    const costRaw = part?.cost ?? raw.cost;
    return {
      kind: "step_finish",
      inputTokens: num(tokens.input) + num(cache?.read) + num(cache?.write),
      outputTokens: num(tokens.output) + num(tokens.reasoning),
      ...(typeof part?.reason === "string" ? { reason: part.reason } : {}),
      ...(cache && cache.read !== undefined ? { cachedInputTokens: num(cache.read) } : {}),
      ...(cache && cache.write !== undefined ? { cacheWriteTokens: num(cache.write) } : {}),
      ...(tokens.reasoning !== undefined ? { reasoningTokens: num(tokens.reasoning) } : {}),
      ...(typeof costRaw === "number" && Number.isFinite(costRaw) ? { cost: costRaw } : {}),
    };
  }
  if (type === "error") {
    const error = asRecord(raw.error);
    const data = asRecord(error?.data);
    const message =
      (typeof data?.message === "string" && data.message) ||
      (typeof error?.message === "string" && error.message) ||
      (typeof raw.message === "string" && raw.message) ||
      String(error?.name ?? "Provider error");
    return { kind: "error", message: message.slice(0, 2000) };
  }
  // Legacy/other providers: usage-bearing objects count as a finished step.
  const usage = asRecord(raw.usage);
  const tokens = asRecord(raw.tokens);
  if (usage || tokens) {
    return {
      kind: "step_finish",
      inputTokens: num(usage?.input_tokens ?? usage?.input) + num(tokens?.input ?? tokens?.input_tokens),
      outputTokens: num(usage?.output_tokens ?? usage?.output) + num(tokens?.output ?? tokens?.output_tokens),
    };
  }
  return { kind: "other", type: type || "unknown" };
}

export type NativeUsage = Pick<
  NativeRunResult,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens" | "costUsd"
>;

/** Add one step_finish event into a running usage total (optional fields stay absent until reported). */
export function addNativeUsage(total: NativeUsage, event: Extract<NativeEvent, { kind: "step_finish" }>): NativeUsage {
  const plus = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);
  const next: NativeUsage = {
    inputTokens: total.inputTokens + event.inputTokens,
    outputTokens: total.outputTokens + event.outputTokens,
  };
  const cached = plus(total.cachedInputTokens, event.cachedInputTokens);
  const write = plus(total.cacheWriteTokens, event.cacheWriteTokens);
  const reasoning = plus(total.reasoningTokens, event.reasoningTokens);
  const cost = plus(total.costUsd, event.cost);
  if (cached !== undefined) next.cachedInputTokens = cached;
  if (write !== undefined) next.cacheWriteTokens = write;
  if (reasoning !== undefined) next.reasoningTokens = reasoning;
  if (cost !== undefined) next.costUsd = cost;
  return next;
}

/** Token usage summed over every JSON line (legacy + opencode shapes). */
export function parseNativeUsage(stdout: string): NativeUsage {
  let usage: NativeUsage = { inputTokens: 0, outputTokens: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseOpencodeEvent(line);
    if (event?.kind === "step_finish") usage = addNativeUsage(usage, event);
  }
  return usage;
}

// ── process handling ──────────────────────────────────────────────────

export async function defaultSpawn(
  command: string,
  args: string[],
  options: SpawnOptions
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Never fall back to inheriting the worker's process.env.
      env: options.env ?? buildChildEnv(),
      shell: options.shell ?? process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
      // stdin MUST be closed: `opencode run` reads piped stdin as extra
      // message input and blocks forever on an open, never-ended pipe.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => killTree(child);
    if (options.signal?.aborted) {
      killTree(child);
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      try {
        options.onStdout?.(text);
      } catch {}
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      // L1: end the process group after a normal exit too, so a server or
      // watcher the agent started in the background does not outlive the
      // run (POSIX; the child leads its own group because it is detached).
      endProcessGroup(child);
      resolve({ stdout, stderr, code });
    });
  });
}

/** SIGKILL whatever is left in a finished child's process group (POSIX only; no-op when empty). */
export function endProcessGroup(child: import("node:child_process").ChildProcess): void {
  if (process.platform === "win32" || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already empty.
  }
}

/**
 * Kill a child process AND its whole process tree: on POSIX the child was
 * spawned `detached` (own process group) so SIGKILL targets the group; on
 * Windows `taskkill /T /F` walks the tree. Without this, aborting a native
 * run (subtask timeout / cancel) leaves `opencode.exe` orphaned and still
 * writing to the workspace, since with `shell: true` the abort only kills
 * the cmd wrapper. Same pattern as verification.ts `killTree`.
 */
export function killTree(child: import("node:child_process").ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

export interface NativeRunInput {
  workspacePath: string;
  prompt: string;
  command?: string;
  /** Agent's OpenCode model (`provider/model`); wins over `llm`. */
  model?: string;
  /** Fhara's resolved LLM config, used when no `model` is set. */
  llm?: NativeLlmConfig;
  /** Hard wall-clock limit; default ORCHESTRATOR_NATIVE_TIMEOUT_MS or 10 min. */
  timeoutMs?: number;
  /** Request JSON events (default true). */
  json?: boolean;
  signal?: AbortSignal;
  onEvent?: EventSink;
  onChunk?: (delta: string) => Promise<void>;
  onMessage?: (text: string) => Promise<void>;
  spawnImpl?: SpawnImpl;
  /** O1: per-run permissions (buildOpencodePolicy); read-only when omitted. */
  policy?: OpencodePolicy;
  /**
   * O1: run with a throwaway HOME/XDG tree holding only the provider login
   * the run needs (opencodeHome.ts). Default true; false only for tests
   * that inspect the plain env.
   */
  scopedHome?: boolean;
  /** The user's real env used to locate OpenCode's auth/config (tests). Defaults to process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Persistent OpenCode cache dir (tests); default defaultOpencodeCacheDir(). */
  opencodeCacheDir?: string;
  /**
   * L1: before the run, ask the CLI for the rules it will evaluate
   * (`opencode debug agent <run agent>`, same env and cwd) and refuse to run when it
   * is looser than Fhara's policy. Default: on for a real `opencode`
   * binary (basename starts with "opencode") without an injected spawn;
   * FHARA_OPENCODE_VERIFY_POLICY=0 turns it off.
   */
  verifyPolicy?: boolean;
}

/** A fresh, unguessable agent name per run, so no repo file can pre-define or loosen it (L1). */
export function opencodeRunAgentName(): string {
  return `fhara-${randomBytes(6).toString("hex")}`;
}

/**
 * Env that makes Fhara's permission block the last word (L1; layering
 * notes in opencodePolicy.ts). The per-run agent's own rules are appended
 * after every config-level rule; the same block also rides in
 * OPENCODE_CONFIG_CONTENT and OPENCODE_PERMISSION (the last config layer);
 * the worktree's opencode.json and .opencode/ are not loaded; external
 * plugins (which can answer permission prompts) are off.
 */
export function opencodeSafetyEnv(policy: OpencodePolicy, agentName: string): Record<string, string> {
  const block = opencodePermissionBlock(policy);
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: block,
      agent: { [agentName]: { mode: "primary", description: "Fhara task run", permission: block } },
    }),
    OPENCODE_PERMISSION: JSON.stringify(block),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    ...OPENCODE_SKILL_LOCKDOWN_ENV,
  };
}

/**
 * Skills plan S1: OpenCode's own skill discovery off, so a target repo's
 * `.claude/skills` / `.agents/skills` (or `~/.claude`, `~/.agents`) never
 * load in a run. Fhara's skills reach OpenCode only through the prompt
 * file. Names from OpenCode's CLI env table (v1 docs cli.mdx) and
 * packages/cli/src/server-process.ts. Measured on 1.19.5:
 * OPENCODE_DISABLE_EXTERNAL_SKILLS alone took `opencode debug skill` in this
 * repo from 36 skills to the one built-in; the CLAUDE_CODE flags also stop
 * `.claude` prompt reading. The global `~/.config/opencode/skills` folder is
 * not covered by these flags: the throwaway HOME keeps it empty, and the
 * `skill: "deny"` permission hides and rejects whatever is left.
 */
export const OPENCODE_SKILL_LOCKDOWN_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
});

function shouldVerifyPolicy(input: NativeRunInput, command: string): boolean {
  if (input.verifyPolicy !== undefined) return input.verifyPolicy;
  if (input.spawnImpl) return false;
  if (!wenv("FHARA_OPENCODE_VERIFY_POLICY")) return false;
  return path.basename(command).toLowerCase().startsWith("opencode");
}

/** Parse `opencode debug config` stdout (JSON, possibly after a banner). */
export function parseDebugConfig(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Null when the rules OpenCode will actually evaluate for `agent`
 * (`opencode debug agent <agent>`, same env and cwd) keep Fhara's rules,
 * else why not (fail closed).
 */
export async function verifyLoadedPolicy(input: {
  command: string;
  agent: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: OpencodePolicy;
  signal?: AbortSignal;
  spawnImpl?: SpawnImpl;
}): Promise<string | null> {
  const debug = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number | null } | string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await (input.spawnImpl ?? defaultSpawn)(input.command, args, {
        cwd: input.cwd,
        env: input.env,
        signal: controller.signal,
      });
    } catch (error) {
      return `could not read OpenCode's loaded config: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  };
  const ran = await debug(["debug", "agent", input.agent]);
  if (typeof ran === "string") return ran;
  if (ran.code !== 0) return `could not read OpenCode's loaded agent rules (exit ${ran.code ?? "signal"})`;
  const agent = parseDebugConfig(ran.stdout);
  if (!agent) return "could not parse OpenCode's loaded agent rules";
  if (agent.name !== input.agent) return `OpenCode resolved agent "${String(agent.name)}", expected "${input.agent}"`;
  const rows = parseRuleRows(agent.permission);
  if (!rows) return "OpenCode's loaded agent has no permission rules";
  const violation = rulesetPolicyViolation(input.policy, rows);
  if (violation) return violation;
  // Skills plan S1: no skill from the repo, the machine or a plugin may be
  // discoverable at all (the `skill` deny above is the second wall).
  const skills = await debug(["debug", "skill"]);
  if (typeof skills === "string") return skills;
  if (skills.code !== 0) return `could not list OpenCode's skills (exit ${skills.code ?? "signal"})`;
  const listed = parseDebugSkills(skills.stdout);
  if (!listed) return "could not parse OpenCode's skill list";
  return externalSkillViolation(listed);
}

/** One entry of `opencode debug skill` (1.19.5: a JSON array of {name, description, location, content}). */
export interface OpencodeDebugSkill {
  name: string;
  location: string;
}

/** OpenCode's own bundled skills report this location; they are hidden by `skill: "deny"`. */
export const OPENCODE_BUILTIN_SKILL_LOCATION = "<built-in>";

/** Parse `opencode debug skill` stdout (JSON array, possibly after a banner); null when unreadable. */
export function parseDebugSkills(stdout: string): OpencodeDebugSkill[] | null {
  const start = stdout.indexOf("[");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: OpencodeDebugSkill[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    out.push({ name: typeof r.name === "string" ? r.name : "?", location: typeof r.location === "string" ? r.location : "" });
  }
  return out;
}

/** Null when every listed skill is an OpenCode built-in, else the first outside skill (fail closed). */
export function externalSkillViolation(skills: readonly OpencodeDebugSkill[]): string | null {
  const outside = skills.filter((s) => s.location !== OPENCODE_BUILTIN_SKILL_LOCATION);
  if (outside.length === 0) return null;
  const first = outside[0]!;
  return `OpenCode can see ${outside.length} skill(s) Fhara did not assign, e.g. "${first.name}" at ${first.location || "an unknown location"}`;
}

export class OpencodePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodePolicyError";
  }
}

/** OpenCode tool errors that mean a permission rule refused the call. */
const PERMISSION_DENIED_RE = /permission denied|prevents you from using|rule which prevents|Permission\.(Blocked|Declined)|not allowed by (the )?permission/i;

export function isOpencodePermissionDenial(error: string | undefined): boolean {
  return !!error && PERMISSION_DENIED_RE.test(error);
}

function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 6) return text;
  return text.split(secret).join("***");
}

export async function runNativeProvider(input: NativeRunInput): Promise<NativeRunResult> {
  const command = input.command ?? nativeProviderCommand();
  const json = input.json ?? true;
  const timeoutMs = input.timeoutMs ?? nativeTimeoutMs();
  // The scoped home decides the pinned model when none was given (the
  // user's OpenCode default lives in a config the scratch home hides), so
  // the config is built after it; this first build only names the mode.
  const first = buildOpencodeConfig({ model: input.model, llm: input.llm, policy: input.policy });
  let { config, model } = first;
  const secretEnv = first.env;
  const secret = secretEnv[OPENCODE_KEY_ENV];
  const homeMode: "pinned" | "fhara" | "default" = input.model?.trim() ? "pinned" : model ? "fhara" : "default";
  await input.onEvent?.(
    "native.run.started",
    {
      provider: command,
      cwd: input.workspacePath,
      ...(model ? { model } : {}),
      llmSource: input.model?.trim() ? "agent-opencode-model" : model ? "fhara-llm" : "opencode-default",
      timeoutMs,
    },
    "info"
  );

  // Timeout + external abort feed one controller; the spawn kills the
  // whole process tree when it fires.
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Streaming JSON state.
  const texts: string[] = [];
  const errors: string[] = [];
  let usage: NativeUsage = { inputTokens: 0, outputTokens: 0 };
  const runStartedAt = Date.now();
  let sawJson = false;
  let streamed = false;
  let pending = "";
  const plainLines: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = parseOpencodeEvent(line);
    if (!event) {
      plainLines.push(line);
      return;
    }
    sawJson = true;
    switch (event.kind) {
      case "text":
        if (event.text) {
          texts.push(event.text);
          // OpenCode emits whole text parts: keep them on their own lines.
          const part = event.text.endsWith("\n") ? event.text : `${event.text}\n`;
          chain = chain.then(() => input.onChunk?.(part)).catch(() => {});
        }
        break;
      case "tool":
        if (event.status === "completed" || event.status === "error") {
          const { kind: _kind, ...payload } = event;
          if (event.status === "error" && isOpencodePermissionDenial(event.error)) {
            // O1: every refusal by the per-run policy is logged (audit row).
            chain = chain
              .then(() =>
                input.onEvent?.(
                  "agent.permission_denied",
                  { provider: command, action: event.tool, tool: event.tool, ...(event.target ? { target: event.target } : {}), reason: `OpenCode policy denied ${event.tool}` },
                  "warn"
                )
              )
              .catch(() => {});
          }
          chain = chain
            .then(() =>
              input.onEvent?.("native.tool", { provider: command, ...payload }, event.status === "error" ? "warn" : "info")
            )
            .catch(() => {});
        }
        break;
      case "step_finish":
        usage = addNativeUsage(usage, event);
        break;
      case "error":
        errors.push(redact(event.message, secret));
        break;
      default:
        break;
    }
  };
  const feed = (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  };

  let tmpDir: string | undefined;
  let ran: { stdout: string; stderr: string; code: number | null };
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-native-"));
    let homeEnv: Record<string, string | undefined> = {};
    if (input.scopedHome ?? true) {
      const home = await prepareOpencodeHome(
        {
          runDir: path.join(tmpDir, "run"),
          mode: homeMode,
          model: input.model?.trim() || undefined,
          sourceEnv: input.sourceEnv,
          cacheDir: input.opencodeCacheDir,
        },
        buildChildEnv(secretEnv, input.sourceEnv ? { source: input.sourceEnv } : {})
      );
      homeEnv = home.env;
      const pinned = model ?? home.defaultModel;
      ({ config, model } = buildOpencodeConfig({
        model: homeMode === "fhara" ? undefined : pinned,
        llm: input.llm,
        policy: input.policy,
        providerConfig: home.providerConfig,
      }));
      await input.onEvent?.(
        "native.home",
        { provider: command, mode: homeMode, copiedProviders: home.copiedProviders, note: home.note, ...(model ? { model } : {}) },
        "info"
      );
    }
    const promptFile = path.join(tmpDir, "prompt.md");
    const configFile = path.join(tmpDir, "opencode.json");
    await fs.writeFile(promptFile, workspaceHeader(input.workspacePath) + input.prompt, { encoding: "utf-8", mode: 0o600 });
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    const agentName = opencodeRunAgentName();
    const { args } = nativeArgv(command, [NATIVE_PROMPT_MESSAGE, "-f", promptFile], {
      model,
      json,
      dir: input.workspacePath,
      agent: agentName,
    });
    const policy = input.policy ?? OPENCODE_PERMISSIONS;
    // Allowlisted env only (buildChildEnv): the worker's service token,
    // encryption key and provider keys never reach the agent. The one
    // LLM key the agent needs arrives explicitly via secretEnv.
    const runEnv = buildChildEnv({
      // O1: throwaway HOME/XDG, no gh/git/ssh credentials.
      ...homeEnv,
      // OpenCode resolves its project dir from $PWD before cwd: an
      // inherited PWD (the worker's own dir) silently redirected every
      // write out of the task worktree in the live smoke run.
      PWD: input.workspacePath,
      OPENCODE_CONFIG: configFile,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      // L1: the permission block wins over any repo config.
      ...opencodeSafetyEnv(policy, agentName),
      ...secretEnv,
    });
    if (shouldVerifyPolicy(input, command)) {
      const violation = await verifyLoadedPolicy({ command, agent: agentName, cwd: input.workspacePath, env: runEnv, policy, signal: controller.signal });
      if (violation) {
        await input.onEvent?.("agent.permission_denied", { provider: command, action: "opencode.config", reason: `refused to run: ${violation}` }, "error");
        throw new OpencodePolicyError(`OpenCode safety rules could not be guaranteed, run refused: ${violation}`);
      }
    }
    ran = await (input.spawnImpl ?? defaultSpawn)(command, args, {
      cwd: input.workspacePath,
      signal: controller.signal,
      env: runEnv,
      onStdout: (chunk) => {
        streamed = true;
        feed(chunk);
      },
    });
  } catch (error) {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
    await cleanup(tmpDir);
    if (error instanceof OpencodePolicyError) {
      return { status: "failed", output: error.message, inputTokens: 0, outputTokens: 0, ...(model ? { model } : {}) };
    }
    if (error instanceof OpencodeCredentialError) {
      await input.onEvent?.("native.credential.missing", { provider: command, reason: error.message }, "error");
      return { status: "failed", output: error.message, inputTokens: 0, outputTokens: 0, ...(model ? { model } : {}) };
    }
    return {
      status: "failed",
      output: `Native provider failed to spawn: ${redact(error instanceof Error ? error.message : String(error), secret)}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", onOuterAbort);
  await cleanup(tmpDir);

  // Injected spawns (tests) may return stdout without streaming it.
  if (!streamed) feed(ran.stdout);
  if (pending) {
    handleLine(pending);
    pending = "";
  }
  await chain;
  const { inputTokens, outputTokens } = usage;
  const ledger = { ...usage, durationMs: Date.now() - runStartedAt };

  const stderr = redact(ran.stderr.trim(), secret);
  const textOutput = sawJson ? texts.join("\n").trim() : redact(ran.stdout.trim(), secret);
  const extraPlain = sawJson ? redact(plainLines.join("\n").trim(), secret) : "";
  const failed = ran.code !== 0 || timedOut || errors.length > 0;

  await input.onEvent?.(
    "native.run.finished",
    {
      provider: command,
      exitCode: ran.code,
      inputTokens,
      outputTokens,
      ...(timedOut ? { timedOut: true, timeoutMs } : {}),
      ...(errors.length > 0 ? { errors: errors.slice(0, 3) } : {}),
    },
    failed ? "warn" : "info"
  );

  if (failed) {
    const reason = timedOut
      ? `Native provider timed out after ${timeoutMs}ms`
      : input.signal?.aborted
        ? "Execution cancelled"
        : "";
    const output = [reason, ...errors, textOutput, extraPlain, ran.code !== 0 ? stderr : ""]
      .filter(Boolean)
      .join("\n")
      .slice(0, 12000);
    return {
      status: "failed",
      output: output || `Native provider exited with code ${ran.code ?? "unknown"}`,
      ...ledger,
      rawExitCode: ran.code ?? undefined,
      ...(timedOut ? { timedOut: true } : {}),
      ...(model ? { model } : {}),
    };
  }
  const output = (textOutput || [extraPlain, stderr].filter(Boolean).join("\n")).slice(0, 12000);
  if (output) await input.onMessage?.(output);
  return {
    status: "completed",
    output,
    ...ledger,
    ...(model ? { model } : {}),
  };
}

async function cleanup(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the run result stands.
  }
}

// ── model catalog (Plan 034) ───────────────────────────────────────────

/** Hard cap on the ids one listing may carry. */
export const MAX_CATALOG_MODELS = 500;

/**
 * `opencode models` prints one `provider/model` per line. Anything else on
 * stdout (a banner, a warning) is dropped, duplicates are removed and the
 * order is kept.
 */
export function parseOpencodeModelList(stdout: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !/^[A-Za-z0-9._-]+\/[^\s]+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    models.push(line);
    if (models.length >= MAX_CATALOG_MODELS) break;
  }
  return models;
}

export interface OpencodeModelCatalog {
  /** `provider/model` ids the CLI reported. */
  models: string[];
  /** False when the CLI is missing, failed or timed out. */
  available: boolean;
  /** Why it is unavailable (never contains credential material). */
  error?: string;
}

export interface ListOpencodeModelsInput {
  /** Binary to ask; defaults to ORCHESTRATOR_NATIVE_PROVIDER_COMMAND. */
  command?: string;
  /** Wall-clock limit; default 15 s. */
  timeoutMs?: number;
  spawnImpl?: SpawnImpl;
}

/**
 * Read the model list from the local OpenCode CLI. The CLI runs with the
 * scrubbed env (`buildChildEnv`), outside any task worktree and without a
 * config override, so it reports the models the user's own OpenCode setup
 * can run. A failure is a value, never an exception: the caller reports
 * "the CLI is unavailable" to the UI.
 */
export async function listOpencodeModels(
  input: ListOpencodeModelsInput = {}
): Promise<OpencodeModelCatalog> {
  const command = input.command ?? nativeProviderCommand();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { stdout, stderr, code } = await (input.spawnImpl ?? defaultSpawn)(
      command,
      ["models"],
      {
        // Not a task worktree: this is a machine-level listing.
        cwd: os.tmpdir(),
        signal: controller.signal,
        env: buildChildEnv(),
      }
    );
    if (code !== 0) {
      return {
        models: [],
        available: false,
        error: (stderr.trim() || `opencode models exited with code ${code}`).slice(0, 300),
      };
    }
    return { models: parseOpencodeModelList(stdout), available: true };
  } catch (error) {
    return {
      models: [],
      available: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

