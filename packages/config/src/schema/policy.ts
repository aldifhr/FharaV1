import type { EnvGet, EnvVar, KnobMeta } from "./types";

/**
 * orchestrator/policy.ts loadPolicy(): every var is read through the knob
 * override source (settingEnv), parsed with intFromEnv ("clamp") or
 * boolFromEnv ("falsyList"). Bounds and defaults are today's literals.
 */
function pint<const N extends string>(
  name: N,
  def: number | ((get: EnvGet) => number),
  min: number,
  max: number,
  doc: string,
  extra: { knob?: KnobMeta; quirk?: string; deprecated?: string } = {}
) {
  return {
    name,
    type: "int" as const,
    parse: "clamp" as const,
    default: def,
    min,
    max,
    runtimes: ["worker"] as const,
    group: "policy" as const,
    doc,
    ...extra,
  };
}

function pbool<const N extends string>(
  name: N,
  def: boolean | ((get: EnvGet) => boolean),
  doc: string,
  extra: { knob?: KnobMeta; quirk?: string; runtimes?: readonly ("worker" | "scripts")[]; deprecated?: string } = {}
) {
  return {
    name,
    type: "bool" as const,
    parse: "falsyList" as const,
    default: def,
    runtimes: extra.runtimes ?? (["worker"] as const),
    group: "policy" as const,
    doc,
    ...(extra.knob ? { knob: extra.knob } : {}),
    ...(extra.quirk ? { quirk: extra.quirk } : {}),
    ...(extra.deprecated ? { deprecated: extra.deprecated } : {}),
  };
}

function penum<const N extends string, const O extends readonly string[]>(
  name: N,
  options: O,
  def: O[number],
  doc: string,
  extra: { knob?: KnobMeta } = {}
) {
  return {
    name,
    type: "enum" as const,
    options,
    default: def,
    runtimes: ["worker"] as const,
    group: "policy" as const,
    doc,
    ...extra,
  };
}

const num = (get: EnvGet, name: string) => get(name) as number;
/** Sequential unless worktree isolation is on (policy.ts defaultParallelism). */
const parallelism = (get: EnvGet) => (get("ORCHESTRATOR_WORKTREE_ISOLATION") ? num(get, "ORCHESTRATOR_PARALLEL_DEFAULT") : 1);

export const DEFAULT_SUBTASK_TIMEOUT_MS = 900_000;

export const POLICY_VARS = [
  pint("ORCHESTRATOR_MAX_REPLANS", 1, 0, 3, "Max replans per task (0–3)."),
  pbool("ORCHESTRATOR_WORKTREE_ISOLATION", false, "Run each task in its own git worktree.", {
    knob: { reader: "worker" },
  }),
  pint("ORCHESTRATOR_PARALLEL_DEFAULT", 2, 1, 3, "Default parallel DAG nodes when worktree isolation is on (1–3)."),
  pint("ORCHESTRATOR_MAX_SUBTASKS", 8, 1, 20, "Max subtasks per plan (1–20)."),
  pint("ORCHESTRATOR_MAX_CONCURRENCY", parallelism, 1, 8, "Max subtasks running at once (1–8); defaults to the parallel default."),
  pint(
    "ORCHESTRATOR_MAX_PLANNING_ITERATIONS",
    (get) => num(get, "ORCHESTRATOR_MAX_REPLANS"),
    0,
    3,
    "Planning iteration bound (0–3); defaults to ORCHESTRATOR_MAX_REPLANS."
  ),
  pint("ORCHESTRATOR_MAX_REVIEW_ITERATIONS", 2, 0, 5, "Max review fix rounds (0–5)."),
  pint(
    "ORCHESTRATOR_SUBTASK_TIMEOUT_MS",
    DEFAULT_SUBTASK_TIMEOUT_MS,
    30_000,
    3_600_000,
    "Subtask timeout (ms); when set explicitly the runner does not grow it from observed latency.",
    { quirk: "docs say 300000 (D1, B9); the explicit-value check reads raw process.env without the knob source" }
  ),
  pint(
    "ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS",
    (get) => Math.max(900_000, num(get, "ORCHESTRATOR_SUBTASK_TIMEOUT_MS")),
    30_000,
    3_600_000,
    "Subtask timeout for high/ultra complexity tasks (ms); default max(900000, ORCHESTRATOR_SUBTASK_TIMEOUT_MS)."
  ),
  pint("ORCHESTRATOR_SUBTASK_RETRIES", 1, 0, 3, "Retries per failed subtask (0–3)."),
  pint("ORCHESTRATOR_APPROVAL_TIMEOUT_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000, "How long a pending approval waits (ms).", {
    knob: { reader: "worker" },
  }),
  pint("ORCHESTRATOR_TASK_TIMEOUT_MS", 20 * 60_000, 60_000, 3 * 60 * 60_000, "Live task deadline (ms).", {
    knob: { reader: "worker" },
  }),
  pint(
    "ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS",
    (get) => Math.max(40 * 60_000, num(get, "ORCHESTRATOR_TASK_TIMEOUT_MS")),
    60_000,
    3 * 60 * 60_000,
    "Task deadline for high/ultra complexity tasks (ms); default max(2400000, ORCHESTRATOR_TASK_TIMEOUT_MS)."
  ),
  pint(
    "ORCHESTRATOR_IDLE_TIMEOUT_MS",
    10 * 60_000,
    60_000,
    24 * 60 * 60_000,
    "Abort a task after this long without observable progress (ms).",
    { knob: { reader: "worker" } }
  ),
  pint("ORCHESTRATOR_PLANNING_STALL_MS", 12 * 60_000, 0, 3 * 60 * 60_000, "Planner-call stall watchdog (ms, 0 = off)."),
  pbool("ORCHESTRATOR_VERIFICATION_ENABLED", true, "Run verification after code changes."),
  pbool("ORCHESTRATOR_VERIFICATION_BUILD", true, "Include the build in verification."),
  pint("ORCHESTRATOR_VERIFICATION_TIMEOUT_MS", 300_000, 30_000, 300_000, "Verification timeout (ms; can only be lowered).", {
    quirk: "max equals the default (D13)",
  }),
  pint("ORCHESTRATOR_MAX_AGENTS_PER_TASK", 3, 1, 10, "Max agents per task (1–10)."),
  pint("ORCHESTRATOR_MAX_LLM_CALLS_PER_TASK", 400, 1, 1_000, "LLM call budget per task (1–1000)."),
  pint("ORCHESTRATOR_MAX_DELEGATION_DEPTH", 2, 0, 10, "Max delegation chain depth (0–10)."),
  pint("ORCHESTRATOR_MAX_DELEGATIONS", 10, 0, 100, "Max approved delegations per task (0–100)."),
  penum("ORCHESTRATOR_BUDGET_MODE", ["warn", "enforce"] as const, "warn", "Budget exhaustion: warn (default) or enforce."),
  pint(
    "ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS",
    parallelism,
    1,
    8,
    "Per-task LLM gate (1–8); defaults to the parallel default."
  ),
  pint("ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK", 2_000_000, 1_000, 100_000_000, "Token budget per task."),
  pbool("ORCHESTRATOR_ALLOW_FALLBACK", false, "Let routing fall back to the top agent when no agent serves a capability."),
  pbool("ORCHESTRATOR_AUTHORITATIVE", true, "The orchestrator's plan and decisions are the ones executed."),
  penum("ORCHESTRATOR_ROUTER_LLM", ["off", "ambiguous", "always"] as const, "off", "When the intent router consults the LLM advisor.", {
    knob: { reader: "worker" },
  }),
  pint("ORCHESTRATOR_CHAT_MAX_AGENTS", 1, 1, 5, "Max agents answering one chat message (1–5)."),
  penum(
    "ORCHESTRATOR_DECISION_LLM",
    ["off", "ambiguous", "always"] as const,
    "ambiguous",
    "When the decision engine consults the LLM advisor.",
    { knob: { reader: "worker" } }
  ),
  pint("ORCHESTRATOR_MAX_DECISION_STEPS", 20, 1, 200, "Max decision steps per task run (1–200)."),
  pbool("ORCHESTRATOR_TOOL_LOOP", false, "Labs: dynamic tool discovery for research/audit agents.", {
    knob: { reader: "worker" },
  }),
  pbool("ORCHESTRATOR_MCP_TOOL_LOOP", true, "Read-only agents may use discovered MCP tools mid-task."),
  pbool("ORCHESTRATOR_MCP_WRITE_TOOLS", false, "Allow MCP write tools (otherwise filtered for every role).", {
    knob: { reader: "worker" },
  }),
  pint("ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS", 6, 1, 20, "MCP tool-loop rounds per subtask (1–20)."),
  pint("ORCHESTRATOR_MCP_TIMEOUT_MS", 30_000, 1_000, 300_000, "Per-MCP-request timeout (ms)."),
  pint("ORCHESTRATOR_MCP_MAX_RESULT_CHARS", 8_000, 500, 200_000, "Cap on one MCP tool result (chars)."),
  pbool("ORCHESTRATOR_AGENT_REACH_ENABLED", true, "Agent Reach web tool for agents that declare web_reach.", {
    knob: { reader: "worker" },
  }),
  {
    name: "ORCHESTRATOR_AGENT_REACH_COMMAND",
    type: "string",
    parse: "trimOr",
    default: "agent-reach",
    runtimes: ["worker"],
    group: "policy",
    doc: "Agent Reach binary.",
  },
  pint("ORCHESTRATOR_AGENT_REACH_TIMEOUT_MS", 60_000, 1_000, 300_000, "Wall-clock limit per Agent Reach call (ms)."),
  pint("ORCHESTRATOR_AGENT_REACH_MAX_ITEMS", 10, 1, 20, "Items one Agent Reach call returns (1–20)."),
  pint("ORCHESTRATOR_AGENT_REACH_MAX_TOOL_ITERATIONS", 4, 1, 20, "Agent Reach tool-loop rounds (1–20)."),
  penum("ORCHESTRATOR_REVIEW_MODE", ["always", "auto", "never"] as const, "auto", "When a review node is added for a code change."),
  penum("ORCHESTRATOR_QA_MODE", ["always", "auto", "never"] as const, "auto", "When a browser QA node is added for a code change.", {
    knob: { reader: "worker" },
  }),
  pint(
    "ORCHESTRATOR_QA_MAX_FIX_ITERATIONS",
    (get) => num(get, "QA_MAX_FIX_ITERATIONS"),
    0,
    5,
    "Max automatic QA fix rounds (0–5); falls back to the legacy QA_MAX_FIX_ITERATIONS."
  ),
  pint("QA_MAX_FIX_ITERATIONS", 1, 0, 5, "Legacy name of ORCHESTRATOR_QA_MAX_FIX_ITERATIONS.", {
    deprecated: "use ORCHESTRATOR_QA_MAX_FIX_ITERATIONS",
  }),
  pbool(
    "ORCHESTRATOR_QA_REQUIRED",
    (get) => get("QA_REQUIRED") as boolean,
    "An environment-blocked QA run fails the task; falls back to the legacy QA_REQUIRED.",
    { knob: { reader: "worker", defaultValue: "false" }, runtimes: ["worker", "scripts"], quirk: "doctor.mjs only accepts \"1\" (D5)" }
  ),
  pbool("QA_REQUIRED", false, "Legacy name of ORCHESTRATOR_QA_REQUIRED.", {
    runtimes: ["worker", "scripts"],
    deprecated: "use ORCHESTRATOR_QA_REQUIRED",
  }),
  pbool("ORCHESTRATOR_LOAD_AWARE_ROUTING", false, "Load-aware routing default when the project has none.", {
    knob: { reader: "worker" },
  }),
  pbool("ORCHESTRATOR_PERFORMANCE_ROUTING", false, "Performance routing default when the project has none.", {
    knob: { reader: "worker" },
  }),
] as const satisfies readonly EnvVar[];
