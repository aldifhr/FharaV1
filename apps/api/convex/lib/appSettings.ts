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

import { KNOBS_FROM_SCHEMA, type KnobName, type SettingKnob, type SettingKnobType } from "@fhara/config";

export type { SettingKnob, SettingKnobType };

/**
 * The knobs the Settings modal may write, derived from the env schema in
 * @fhara/config (type, default, reader, bounds). Same keys, values and
 * order as the literal that lived here before E1 (knobsParity test).
 */
export const SETTING_KNOBS: Readonly<Record<KnobName, SettingKnob>> = KNOBS_FROM_SCHEMA;

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
