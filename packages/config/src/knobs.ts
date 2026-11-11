/**
 * The Settings-modal knobs, derived from the schema. KNOBS_FROM_SCHEMA has
 * exactly the shape of the SETTING_KNOBS literal that lived in
 * apps/api/convex/lib/appSettings.ts before E1 (a parity test pins it).
 */
import { envVar } from "./schema";
import type { EnvVar } from "./schema/types";

/** A tristate knob (QA_CHROMIUM_NO_SANDBOX) in Settings: auto, or forced on / off. */
export const TRISTATE_OPTIONS = ["auto", "true", "false"] as const;

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

/**
 * Knob order: the Settings UI, appSettings.get and knobEnvSnapshot iterate
 * SETTING_KNOBS in this order. Every name here must carry `knob` metadata
 * in the schema and vice versa (guarded by the knobs parity test).
 */
export const KNOB_ORDER = [
  // Source control
  "FHARA_GIT_AUTHOR_NAME",
  "FHARA_GIT_AUTHOR_EMAIL",
  "FHARA_ALLOW_FORCE_PUSH",
  "FHARA_ALLOW_BASE_BRANCH_PUSH",
  // Pull requests
  "FHARA_PR_DRAFT",
  "FHARA_PR_FIX_MAX_ATTEMPTS",
  // O2 supervised auto-merge
  "FHARA_AUTO_MERGE_MAX_LINES",
  "FHARA_AUTO_MERGE_SENSITIVE",
  "FHARA_AUTO_MERGE_METHOD",
  // Worktrees
  "FHARA_WORKTREE_RETENTION_HOURS",
  "ORCHESTRATOR_WORKTREE_ISOLATION",
  // Snapshots
  "CONTEXT_SNAPSHOTS",
  "FHARA_SNAPSHOT_RETENTION_DAYS",
  // Threads
  "CHAT_REPLY_STALE_MS",
  "ORCHESTRATOR_IDLE_TIMEOUT_MS",
  "ORCHESTRATOR_TASK_TIMEOUT_MS",
  // Browser (QA)
  "ORCHESTRATOR_QA_MODE",
  "ORCHESTRATOR_QA_REQUIRED",
  "QA_CHROMIUM_PATH",
  "QA_CHROMIUM_NO_SANDBOX",
  "QA_STARTUP_TIMEOUT_MS",
  // Sharing & access
  "ORCHESTRATOR_APPROVAL_TIMEOUT_MS",
  "ORCHESTRATOR_MCP_WRITE_TOOLS",
  "ORCHESTRATOR_AGENT_REACH_ENABLED",
  // Labs
  "ORCHESTRATOR_TOOL_LOOP",
  "ORCHESTRATOR_PERFORMANCE_ROUTING",
  "ORCHESTRATOR_LOAD_AWARE_ROUTING",
  "ORCHESTRATOR_ROUTER_LLM",
  "ORCHESTRATOR_DECISION_LLM",
  // Workspace
  "WORKSPACE_ROOT",
] as const;

export type KnobName = (typeof KNOB_ORDER)[number];

function knobType(def: EnvVar): SettingKnobType {
  switch (def.type) {
    case "int":
      return "int";
    case "bool":
      return "bool";
    case "enum":
    case "tristate":
      return "enum";
    default:
      return "string";
  }
}

export function knobFromDef(def: EnvVar): SettingKnob {
  const meta = def.knob;
  if (!meta) throw new Error(`@fhara/config: ${def.name} is not a knob`);
  const raw = (def as { default?: unknown }).default;
  let defaultValue = meta.defaultValue;
  if (defaultValue === undefined) {
    if (typeof raw === "function" || raw === undefined) {
      throw new Error(`@fhara/config: knob ${def.name} needs knob.defaultValue (its default is derived or unset)`);
    }
    defaultValue = String(raw);
  }
  const knob: SettingKnob = { type: knobType(def), defaultValue, reader: meta.reader };
  if (def.type === "int") {
    const min = meta.min ?? def.min;
    const max = meta.max ?? def.max;
    if (min !== undefined) knob.min = min;
    if (max !== undefined) knob.max = max;
  }
  if (def.type === "enum") knob.options = def.options;
  if (def.type === "tristate") knob.options = TRISTATE_OPTIONS;
  if (def.type !== "int" && def.type !== "bool" && def.type !== "tristate" && def.type !== "enum") {
    const maxLength = meta.maxLength ?? def.maxLength;
    if (maxLength !== undefined) knob.maxLength = maxLength;
  }
  return knob;
}

/** SETTING_KNOBS, in KNOB_ORDER. */
export function knobsFromSchema(): Record<KnobName, SettingKnob> {
  const out = {} as Record<KnobName, SettingKnob>;
  for (const name of KNOB_ORDER) {
    const def = envVar(name);
    if (!def) throw new Error(`@fhara/config: knob ${name} is not in the schema`);
    out[name] = knobFromDef(def);
  }
  return out;
}

export const KNOBS_FROM_SCHEMA: Readonly<Record<KnobName, SettingKnob>> = knobsFromSchema();
