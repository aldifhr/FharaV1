import { describe, expect, it } from "vitest";
import { ENV_SCHEMA, KNOB_ORDER, KNOBS_FROM_SCHEMA, type EnvVar } from "@fhara/config";

/**
 * E1 parity: SETTING_KNOBS derived from the schema must equal, key for key
 * and in the same order, the literal that lived in
 * apps/api/convex/lib/appSettings.ts at 4d2dfb7 (frozen copy below).
 */
// prettier-ignore
const OLD_SETTING_KNOBS = {
  // Source control
  FHARA_GIT_AUTHOR_NAME: { type: "string", defaultValue: "Fhara", reader: "both", maxLength: 100 },
  FHARA_GIT_AUTHOR_EMAIL: { type: "string", defaultValue: "fhara@users.noreply.github.com", reader: "both", maxLength: 200 },
  FHARA_ALLOW_FORCE_PUSH: { type: "bool", defaultValue: "false", reader: "worker" },
  FHARA_ALLOW_BASE_BRANCH_PUSH: { type: "bool", defaultValue: "false", reader: "worker" },
  // Pull requests
  FHARA_PR_DRAFT: { type: "bool", defaultValue: "true", reader: "worker" },
  FHARA_PR_FIX_MAX_ATTEMPTS: { type: "int", defaultValue: "3", reader: "api", min: 0, max: 20 },
  // O2 supervised auto-merge (per project switch; these shape the gate)
  FHARA_AUTO_MERGE_MAX_LINES: { type: "int", defaultValue: "400", reader: "api", min: 0, max: 100_000 },
  FHARA_AUTO_MERGE_SENSITIVE: {
    type: "string",
    defaultValue: ".github/**, **/.env*, **/*.env, **/*.pem, **/*.key, infra/**, apps/api/convex/schema.ts",
    reader: "api",
    maxLength: 1000,
  },
  FHARA_AUTO_MERGE_METHOD: { type: "enum", defaultValue: "squash", reader: "api", options: ["squash", "merge", "rebase"] },
  // Worktrees
  FHARA_WORKTREE_RETENTION_HOURS: { type: "int", defaultValue: "72", reader: "api", min: 1, max: 720 },
  // L3: tristate, auto by default (was a bool, off).
  ORCHESTRATOR_WORKTREE_ISOLATION: { type: "enum", defaultValue: "auto", reader: "worker", options: ["auto", "true", "false"] },
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
  // Was { type: "bool", defaultValue: "false" }, which hid the code default (auto).
  QA_CHROMIUM_NO_SANDBOX: { type: "enum", defaultValue: "auto", reader: "worker", options: ["auto", "true", "false"] },
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
  // LLM & Models (L4: per-role model override, off by default)
  FHARA_LLM_ROLE_OVERRIDE: { type: "bool", defaultValue: "false", reader: "both" },
  // Workspace
  WORKSPACE_ROOT: { type: "string", defaultValue: "./workspaces", reader: "worker", maxLength: 500 },
} as const;


describe("knobs parity (E1)", () => {
  it("deep-equals the pre-E1 SETTING_KNOBS literal", () => {
    expect(KNOBS_FROM_SCHEMA).toEqual(OLD_SETTING_KNOBS);
  });

  it("keeps the key order (Settings UI, appSettings.get and knobEnvSnapshot iterate it)", () => {
    expect(Object.keys(KNOBS_FROM_SCHEMA)).toEqual(Object.keys(OLD_SETTING_KNOBS));
  });

  it("every schema var with knob metadata is in KNOB_ORDER and vice versa", () => {
    const withKnob = (ENV_SCHEMA as readonly EnvVar[]).filter((def) => def.knob).map((def) => def.name).sort();
    expect(withKnob).toEqual([...KNOB_ORDER].sort());
  });

  it("each worker knob's UI default equals the code default (except the documented D11 case)", () => {
    for (const def of ENV_SCHEMA as readonly EnvVar[]) {
      if (!def.knob || def.knob.defaultValue === undefined) continue;
      expect(["QA_CHROMIUM_NO_SANDBOX", "QA_CHROMIUM_PATH", "ORCHESTRATOR_QA_REQUIRED", "ORCHESTRATOR_WORKTREE_ISOLATION"]).toContain(def.name);
    }
  });
});
