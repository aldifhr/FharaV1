/**
 * App-wide settings (Settings modal) — pure rules, shared by Convex, the
 * worker and the web app.
 *
 * Fhara is a personal, single-user, localhost app. Most of its behaviour
 * is tuned by environment variables (FHARA_*, ORCHESTRATOR_*, QA_*). The
 * Settings modal can override a fixed set of them from the UI: the value
 * is stored in the `appSettings` row (Convex) and wins over the process
 * env wherever the knob is read.
 *
 *  - Worker knobs: the worker fetches the row on every heartbeat and calls
 *    `setSettingOverrides`; its readers go through `settingEnv(name)` /
 *    `settingEnvSource()` instead of `process.env`.
 *  - API knobs: Convex functions run in their own isolates, so they read
 *    the row from the database (`loadSettingValues` in appSettings.ts) and
 *    pass the raw value to the pure reader.
 *  - Child env: user-defined KEY=VALUE pairs that every process the worker
 *    spawns receives (buildChildEnv merges them; secrets stay blocked).
 *
 * Only the knobs listed in SETTING_KNOBS can be written; anything else is
 * refused, so the UI can never set an arbitrary worker variable.
 */

export type SettingKnobType = "bool" | "int" | "enum" | "string";

export interface SettingKnob {
  type: SettingKnobType;
  /** The value the code uses when neither the UI nor the env sets one. */
  defaultValue: string;
  /** Who reads it: the worker process, or a Convex function. */
  reader: "worker" | "api" | "both";
  min?: number;
  max?: number;
  options?: readonly string[];
  maxLength?: number;
}

export const SETTING_KNOBS = {
  // Source control
  FHARA_GIT_AUTHOR_NAME: { type: "string", defaultValue: "Fhara", reader: "both", maxLength: 100 },
  FHARA_GIT_AUTHOR_EMAIL: { type: "string", defaultValue: "fhara@users.noreply.github.com", reader: "both", maxLength: 200 },
  FHARA_ALLOW_FORCE_PUSH: { type: "bool", defaultValue: "false", reader: "worker" },
  FHARA_ALLOW_BASE_BRANCH_PUSH: { type: "bool", defaultValue: "false", reader: "worker" },
  // Pull requests
  FHARA_PR_DRAFT: { type: "bool", defaultValue: "true", reader: "worker" },
  FHARA_PR_FIX_MAX_ATTEMPTS: { type: "int", defaultValue: "3", reader: "api", min: 0, max: 20 },
  // Worktrees
  FHARA_WORKTREE_RETENTION_HOURS: { type: "int", defaultValue: "72", reader: "api", min: 1, max: 720 },
  ORCHESTRATOR_WORKTREE_ISOLATION: { type: "bool", defaultValue: "false", reader: "worker" },
  // Snapshots
  CONTEXT_SNAPSHOTS: { type: "bool", defaultValue: "true", reader: "both" },
  FHARA_SNAPSHOT_RETENTION_DAYS: { type: "int", defaultValue: "14", reader: "api", min: 1, max: 365 },
  // Threads
  CHAT_REPLY_STALE_MS: { type: "int", defaultValue: String(15 * 60_000), reader: "api", min: 11 * 60_000, max: 24 * 60 * 60_000 },
  ORCHESTRATOR_IDLE_TIMEOUT_MS: { type: "int", defaultValue: String(10 * 60_000), reader: "worker", min: 60_000, max: 24 * 60 * 60_000 },
  ORCHESTRATOR_TASK_TIMEOUT_MS: { type: "int", defaultValue: String(20 * 60_000), reader: "worker", min: 60_000, max: 3 * 60 * 60_000 },
  // Browser (QA)
  ORCHESTRATOR_QA_MODE: { type: "enum", defaultValue: "auto", reader: "worker", options: ["always", "auto", "never"] },
  ORCHESTRATOR_QA_REQUIRED: { type: "bool", defaultValue: "false", reader: "worker" },
  QA_CHROMIUM_PATH: { type: "string", defaultValue: "", reader: "worker", maxLength: 500 },
  QA_CHROMIUM_NO_SANDBOX: { type: "bool", defaultValue: "false", reader: "worker" },
  QA_STARTUP_TIMEOUT_MS: { type: "int", defaultValue: "90000", reader: "worker", min: 5_000, max: 600_000 },
  // Sharing & access (what agents may do)
  ORCHESTRATOR_APPROVAL_TIMEOUT_MS: { type: "int", defaultValue: String(30 * 60_000), reader: "worker", min: 60_000, max: 24 * 60 * 60_000 },
  ORCHESTRATOR_MCP_WRITE_TOOLS: { type: "bool", defaultValue: "false", reader: "worker" },
  ORCHESTRATOR_AGENT_REACH_ENABLED: { type: "bool", defaultValue: "true", reader: "worker" },
  // Labs
  ORCHESTRATOR_TOOL_LOOP: { type: "bool", defaultValue: "false", reader: "worker" },
  ORCHESTRATOR_PERFORMANCE_ROUTING: { type: "bool", defaultValue: "false", reader: "worker" },
  ORCHESTRATOR_LOAD_AWARE_ROUTING: { type: "bool", defaultValue: "false", reader: "worker" },
  ORCHESTRATOR_ROUTER_LLM: { type: "enum", defaultValue: "off", reader: "worker", options: ["off", "ambiguous", "always"] },
  ORCHESTRATOR_DECISION_LLM: { type: "enum", defaultValue: "ambiguous", reader: "worker", options: ["off", "ambiguous", "always"] },
  // Workspace
  WORKSPACE_ROOT: { type: "string", defaultValue: "./workspaces", reader: "worker", maxLength: 500 },
} as const satisfies Record<string, SettingKnob>;

export type SettingKey = keyof typeof SETTING_KNOBS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_KNOBS, key);
}

/**
 * Normalize a UI value for a knob. Returns the stored string, or throws
 * with a plain reason. An empty string means "clear the override".
 */
export function normalizeSettingValue(key: string, raw: string): string {
  if (!isSettingKey(key)) throw new Error(`Unknown setting: ${key}`);
  const knob: SettingKnob = SETTING_KNOBS[key];
  const value = raw.replace(/[\u0000-\u001f]/g, "").trim();
  if (value === "") return "";
  switch (knob.type) {
    case "bool": {
      const lower = value.toLowerCase();
      if (["1", "true", "on", "yes"].includes(lower)) return "true";
      if (["0", "false", "off", "no"].includes(lower)) return "false";
      throw new Error(`${key} must be true or false`);
    }
    case "int": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      const clamped = Math.min(knob.max ?? Number.MAX_SAFE_INTEGER, Math.max(knob.min ?? 0, Math.floor(n)));
      return String(clamped);
    }
    case "enum": {
      const lower = value.toLowerCase();
      if (!knob.options?.includes(lower)) throw new Error(`${key} must be one of ${knob.options?.join(", ")}`);
      return lower;
    }
    case "string": {
      if (value.length > (knob.maxLength ?? 200)) throw new Error(`${key} is too long`);
      return value;
    }
  }
}

// ── Child env (Environments tab) ─────────────────────────────────────────

/** POSIX-ish env var name. */
export const CHILD_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const CHILD_ENV_MAX_ENTRIES = 50;
export const CHILD_ENV_MAX_VALUE = 4_000;

/**
 * Names the Environments tab may never set: the worker's own secrets and
 * the variables that would let a child escape the scrubbed environment or
 * redirect git. buildChildEnv drops WORKER_SECRET_ENV_KEYS on its own too.
 */
const CHILD_ENV_BLOCKED = /^(CONVEX_|PROVIDER_ENCRYPTION_KEY|GITHUB_CLIENT_|GITHUB_WEBHOOK_SECRET|OAUTH_STATE_SECRET|WORKER_|GIT_CONFIG_|GIT_DIR$|GIT_WORK_TREE$|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_|NODE_OPTIONS$)/;

export function childEnvNameAllowed(name: string): boolean {
  return CHILD_ENV_NAME.test(name) && !CHILD_ENV_BLOCKED.test(name);
}

export function normalizeChildEnv(entries: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  if (entries.length > CHILD_ENV_MAX_ENTRIES) throw new Error(`At most ${CHILD_ENV_MAX_ENTRIES} variables`);
  const seen = new Set<string>();
  const out: Array<{ name: string; value: string }> = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) continue;
    if (!CHILD_ENV_NAME.test(name)) throw new Error(`Invalid variable name: ${name}`);
    if (!childEnvNameAllowed(name)) throw new Error(`${name} can not be set from Settings`);
    if (seen.has(name)) throw new Error(`Duplicate variable: ${name}`);
    if (entry.value.length > CHILD_ENV_MAX_VALUE) throw new Error(`${name} is too long`);
    if (/[\u0000]/.test(entry.value)) throw new Error(`${name} contains a NUL byte`);
    seen.add(name);
    out.push({ name, value: entry.value });
  }
  return out;
}

// ── Runtime overrides (worker process) ──────────────────────────────────

let overrides: Record<string, string> = {};
let childEnvOverrides: Record<string, string> = {};

function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * Replace the active knob overrides (worker: after each settings fetch).
 * Unknown keys and empty values are ignored.
 */
export function setSettingOverrides(values: Record<string, string>): void {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSettingKey(key) && value !== "") next[key] = value;
  }
  overrides = next;
}

/** Replace the user-defined child env (worker: after each settings fetch). */
export function setChildEnvOverrides(values: Record<string, string>): void {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (childEnvNameAllowed(name)) next[name] = value;
  }
  childEnvOverrides = next;
}

export function getChildEnvOverrides(): Readonly<Record<string, string>> {
  return childEnvOverrides;
}

/** A knob's effective raw value: UI override, else the process env. */
export function settingEnv(name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
  return readProcessEnv()[name];
}

/** The process env with the UI overrides applied (for readers that take a source). */
export function settingEnvSource(): Record<string, string | undefined> {
  return { ...readProcessEnv(), ...overrides };
}

/**
 * Effective value for an API-side reader: the stored override, else the
 * process env (raw; the pure reader parses and clamps it).
 */
export function settingFrom(values: Record<string, string> | null | undefined, name: SettingKey): string | undefined {
  const stored = values?.[name];
  if (stored !== undefined && stored !== "") return stored;
  return readProcessEnv()[name];
}
