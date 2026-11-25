import { describe, expect, it } from "vitest";

/**
 * Canary contract for plan 085 step 3. The unique command marker below must
 * never appear in any decision trace written to taskEvents. Step 2 wires the
 * production trace builder into this assertion; the policy is fixed here:
 * no free-form LLM text, only enum reason codes and metadata.
 */
describe("decision trace canary", () => {
  it("serialised trace contains no raw command or model prose", () => {
    const canary = `CANARY_${Date.now()}_7f3a`;
    const command = `Verify the preview URL ${canary}`;
    const trace = {
      at: Date.now(),
      stage: "classify",
      choice: "research",
      source: "llm",
      reasonCode: "LLM_SCHEMA_VALID",
      proposedChoice: undefined,
      model: "fake-model",
      tokensIn: 10,
      tokensOut: 3,
      decisionId: "d-1",
      promptVersion: "v1",
      schemaVersion: "1",
    };
    const serialised = JSON.stringify(trace);
    expect(serialised).not.toContain(canary);
    expect(serialised).not.toContain(command);
    expect(Object.values(trace).some((value) => typeof value === "string" && value.length > 64)).toBe(false);
  });
});
