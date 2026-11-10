import { afterEach, describe, expect, it } from "vitest";
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
