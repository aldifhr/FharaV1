import { afterEach, describe, expect, it } from "vitest";
import { ENV_SCHEMA, type EnvVar, readVar, schemaDefault, setEnvIssueSink } from "@fhara/config";
import { setSettingOverrides } from "@/api/convex/lib/appSettings";
import { toolLoopEnabled } from "@/execution/toolLoopFlag";
import { loadPolicy } from "@/orchestrator/policy";

/**
 * The labelled behaviour changes after E4 (B1–B10), one describe per fix.
 * Each pins the NEW behaviour; the E1 parity oracles keep pinning every
 * read that did not change.
 */
describe("B1: ORCHESTRATOR_TOOL_LOOP honours the bool parser and the UI override", () => {
  const saved = process.env.ORCHESTRATOR_TOOL_LOOP;
  afterEach(() => {
    setSettingOverrides({});
    if (saved === undefined) delete process.env.ORCHESTRATOR_TOOL_LOOP;
    else process.env.ORCHESTRATOR_TOOL_LOOP = saved;
  });

  it("accepts 1 / true / yes / on, not only the literal \"true\"", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) expect(toolLoopEnabled({ ORCHESTRATOR_TOOL_LOOP: raw }), raw).toBe(true);
    for (const raw of ["0", "false", "off", "no"]) expect(toolLoopEnabled({ ORCHESTRATOR_TOOL_LOOP: raw }), raw).toBe(false);
    expect(toolLoopEnabled({})).toBe(false);
  });

  it("a Settings override wins over the env, and agrees with loadPolicy().toolLoop", () => {
    process.env.ORCHESTRATOR_TOOL_LOOP = "0";
    setSettingOverrides({ ORCHESTRATOR_TOOL_LOOP: "true" });
    expect(toolLoopEnabled()).toBe(true);
    expect(loadPolicy().toolLoop).toBe(true);
    setSettingOverrides({ ORCHESTRATOR_TOOL_LOOP: "false" });
    process.env.ORCHESTRATOR_TOOL_LOOP = "1";
    expect(toolLoopEnabled()).toBe(false);
    expect(loadPolicy().toolLoop).toBe(false);
  });
});

describe("B2: one bool dialect for every bool var", () => {
  const bools = (ENV_SCHEMA as readonly EnvVar[]).filter((d) => d.type === "bool");

  it("every bool var uses it (no per-var dialect left)", () => {
    for (const def of bools) expect((def as { parse?: string }).parse ?? "bool", def.name).toBe("bool");
  });

  it("unset/blank → default; 1|true|yes|on → true; 0|false|no|off → false; anything else → default + a warning", () => {
    const issues: string[] = [];
    const previous = setEnvIssueSink((issue) => issues.push(issue.name));
    try {
      for (const def of bools) {
        const d = schemaDefault(def.name);
        const read = (raw: string | undefined) => readVar(def.name, raw === undefined ? {} : { [def.name]: raw });
        expect(read(undefined), def.name).toBe(d);
        expect(read(""), def.name).toBe(d);
        expect(read("  "), def.name).toBe(d);
        for (const raw of ["1", "true", "TRUE", " yes ", "on"]) expect(read(raw), `${def.name}=${raw}`).toBe(true);
        for (const raw of ["0", "false", "False", " no", "off"]) expect(read(raw), `${def.name}=${raw}`).toBe(false);
        issues.length = 0;
        expect(read("maybe"), def.name).toBe(d);
        expect(issues).toEqual([def.name]);
      }
    } finally {
      setEnvIssueSink(previous);
    }
  });

  it("the edge cases that changed (pre-B2 → now)", () => {
    // falsyList: "" was true, garbage was true.
    expect(readVar("ORCHESTRATOR_VERIFICATION_ENABLED", { ORCHESTRATOR_VERIFICATION_ENABLED: "maybe" })).toBe(true);
    expect(readVar("ORCHESTRATOR_WORKTREE_ISOLATION", { ORCHESTRATOR_WORKTREE_ISOLATION: "" })).toBe(false);
    expect(readVar("ORCHESTRATOR_WORKTREE_ISOLATION", { ORCHESTRATOR_WORKTREE_ISOLATION: "maybe" })).toBe(false);
    // neq0: "false" / "off" used to read as ON.
    expect(readVar("WORKER_SUBSCRIBE", { WORKER_SUBSCRIBE: "false" })).toBe(false);
    expect(readVar("FHARA_COMMIT_MESSAGE_LLM", { FHARA_COMMIT_MESSAGE_LLM: "off" })).toBe(false);
    // eq1: "true" used to read as OFF.
    expect(readVar("FHARA_ALLOW_LOCAL_MCP", { FHARA_ALLOW_LOCAL_MCP: "true" })).toBe(true);
    // The legacy alias chain is kept: QA_REQUIRED feeds ORCHESTRATOR_QA_REQUIRED's default.
    expect(readVar("ORCHESTRATOR_QA_REQUIRED", { QA_REQUIRED: "yes" })).toBe(true);
    expect(readVar("ORCHESTRATOR_QA_REQUIRED", { QA_REQUIRED: "yes", ORCHESTRATOR_QA_REQUIRED: "0" })).toBe(false);
  });
});
