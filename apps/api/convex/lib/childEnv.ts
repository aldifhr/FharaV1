/**
 * Child-process environment scrubbing (shared by the worker, the API's Node
 * actions and the web terminal route).
 *
 * Every process Fhara spawns (OpenCode / native agents, run_command, QA dev
 * servers, verification commands, MCP stdio servers, git) used to inherit
 * the parent's full `process.env`. A prompt-injected task could then
 * `printenv` and read CONVEX_SERVICE_TOKEN, PROVIDER_ENCRYPTION_KEY, the
 * Convex admin key, GitHub OAuth secrets and LLM provider keys.
 *
 * `buildChildEnv` starts from an empty env and copies only:
 *   1. an allowlist of harmless, non-secret vars (PATH, HOME, locale,
 *      TERM, temp dirs, NODE_ENV, CI, proxy + CA vars, OS essentials),
 *   2. names the operator opts into with FHARA_CHILD_ENV_PASSTHROUGH
 *      (comma separated, e.g. `FHARA_CHILD_ENV_PASSTHROUGH=FOO,BAR`),
 *   3. user-defined vars from Settings → Environments (lib/appSettings.ts),
 *   4. per-run `extra` vars the caller adds explicitly (e.g. the LLM key
 *      the agent itself needs).
 * Worker-only secrets (WORKER_SECRET_ENV_KEYS) are dropped from all three,
 * including passthrough and extras. Pure: no Node imports, safe to bundle.
 */
import { getChildEnvOverrides } from "./appSettings";

/** Exact names forwarded from the parent env when set. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  // POSIX basics
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // XDG dirs (OpenCode and npm keep config/cache here)
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Runtime mode
  "NODE_ENV",
  "CI",
  // Network: proxies and corporate CAs (not secrets, needed to reach LLMs/npm)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Playwright browsers installed outside the default cache
  "PLAYWRIGHT_BROWSERS_PATH",
  // Windows essentials (spawning anything breaks without these)
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "Path",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "PUBLIC",
  "ALLUSERSPROFILE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
];

/** Prefixes forwarded from the parent env (locale categories). */
export const CHILD_ENV_ALLOWED_PREFIXES: readonly string[] = ["LC_"];

/** Operator opt-in list of extra var names to forward. */
export const CHILD_ENV_PASSTHROUGH_VAR = "FHARA_CHILD_ENV_PASSTHROUGH";

/**
 * Never forwarded, not even through passthrough or explicit extras. These
 * belong to the worker / control plane; no child has a legitimate need.
 */
export const WORKER_SECRET_ENV_KEYS: readonly string[] = [
  "CONVEX_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "PROVIDER_ENCRYPTION_KEY_OLD",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_ADMIN_KEY",
  "CONVEX_DEPLOY_KEY",
  "OAUTH_STATE_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "AUTH_GITHUB_SECRET",
  "JWT_PRIVATE_KEY",
];

/**
 * Secret-shaped names that are dropped from the parent env by default but
 * that an operator may deliberately opt into via passthrough (e.g. a test
 * suite that needs OPENAI_API_KEY). Listed so the denylist test covers them.
 */
export const DEFAULT_DENIED_SECRET_ENV_KEYS: readonly string[] = [
  "LLM_API_KEY",
  "STAGEHAND_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
];

const WORKER_SECRET_SET = new Set(WORKER_SECRET_ENV_KEYS.map((k) => k.toUpperCase()));
const ALLOWLIST_SET = new Set(CHILD_ENV_ALLOWLIST);
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_().]*$/;

export function isWorkerSecretEnvKey(key: string): boolean {
  return WORKER_SECRET_SET.has(key.toUpperCase());
}

function isAllowlisted(key: string): boolean {
  if (ALLOWLIST_SET.has(key)) return true;
  return CHILD_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Names from FHARA_CHILD_ENV_PASSTHROUGH (worker secrets removed). */
export function childEnvPassthroughKeys(source: Record<string, string | undefined>): string[] {
  const raw = source[CHILD_ENV_PASSTHROUGH_VAR] ?? "";
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && VALID_NAME.test(name) && !isWorkerSecretEnvKey(name));
}

/** A scrubbed child env, usable wherever `NodeJS.ProcessEnv` is expected. */
export type ChildEnv = Record<string, string> & NodeJS.ProcessEnv;

export interface BuildChildEnvOptions {
  /** Parent env to copy from. Defaults to `process.env`. */
  source?: Record<string, string | undefined>;
}

function defaultSource(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * Minimal env for a child process. `extra` vars are added last (they win
 * over inherited values) except worker secrets, which are always dropped;
 * an `undefined` extra removes the var.
 */
export function buildChildEnv(
  extra?: Record<string, string | undefined>,
  options: BuildChildEnvOptions = {}
): ChildEnv {
  const source = options.source ?? defaultSource();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isWorkerSecretEnvKey(key)) continue;
    if (isAllowlisted(key)) env[key] = value;
  }
  for (const key of childEnvPassthroughKeys(source)) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // Settings → Environments: user-defined vars for every spawned process
  // (set by the worker from the appSettings row; empty elsewhere).
  for (const [key, value] of Object.entries(getChildEnvOverrides())) {
    if (!isWorkerSecretEnvKey(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (isWorkerSecretEnvKey(key)) continue;
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // Typed as ProcessEnv too, so it fits spawn/execFile even where a
  // framework (Next.js) augments ProcessEnv with required keys.
  return env as ChildEnv;
}
