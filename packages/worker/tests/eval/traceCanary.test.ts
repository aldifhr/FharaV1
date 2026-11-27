import { describe, expect, it } from "vitest";
import { buildDecisionTrace, reasonCodeFor } from "@/orchestrator/decisionTrace";

/** Canary: a unique command marker must never appear in a production trace. */
describe("decision trace canary (production builder)", () => {
  it("no trace path contains the raw command or model prose", () => {
    const canary = `CANARY_${Date.now()}_7f3a`;
    const command = `Verify the preview URL ${canary}`;
    const cases = [
      { source: "fast-path" as const, reasonCode: "UNAMBIGUOUS_SHAPE" as const },
      { source: "llm" as const, reasonCode: "LLM_SCHEMA_VALID" as const },
      { source: "fallback" as const, reasonCode: "LLM_INVALID" as const },
      { source: "fallback" as const, reasonCode: "BUDGET_VETO" as const },
      { source: "validator-override" as const, reasonCode: "VALIDATOR_OVERRIDE" as const, proposedChoice: "code_change" },
    ];
    for (const entry of cases) {
      const trace = buildDecisionTrace({
        stage: "decide",
        choice: "research",
        ...entry,
        decisionId: "d-1",
      });
      const serialised = JSON.stringify(trace);
      expect(serialised).not.toContain(canary);
      expect(serialised).not.toContain(command);
      expect(Object.values(trace).some((value) => typeof value === "string" && value.length > 64)).toBe(false);
    }
  });

  it("reason codes are enum-only, including fallback and step limit", () => {
    expect(reasonCodeFor("complete", { stepLimit: true })).toBe("STEP_LIMIT");
    expect(reasonCodeFor("execute", { fallback: true })).toBe("FALLBACK_RECORDED");
    expect(reasonCodeFor("delegate", { override: true })).toBe("VALIDATOR_OVERRIDE");
  });
});
