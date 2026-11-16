import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  GenerateOrchestrationPlanInput,
  OrchestrationPlan,
  OrchestrationPlanValidation,
} from "./orchestratorPlayground.ts";

const decodePlan = Schema.decodeUnknownSync(OrchestrationPlan);
const decodeInput = Schema.decodeUnknownSync(GenerateOrchestrationPlanInput);

describe("OrchestrationPlan", () => {
  it("decodes a plan and defaults dependsOn and requiresApproval", () => {
    const plan = decodePlan({
      summary: "Ship the thing",
      steps: [
        { id: "step-1", roleId: "backend", task: "Add the endpoint" },
        { id: "step-2", roleId: "frontend", task: "Wire the UI", dependsOn: ["step-1"] },
      ],
    });
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.steps[0]!.requiresApproval).toBe(false);
    expect(plan.steps[1]!.dependsOn).toEqual(["step-1"]);
  });

  it("rejects an unregistered role", () => {
    expect(() =>
      decodePlan({
        summary: "test",
        steps: [{ id: "step-1", roleId: "wizard", task: "cast spells" }],
      }),
    ).toThrow();
  });

  it("rejects an empty step task", () => {
    expect(() =>
      decodePlan({
        summary: "test",
        steps: [{ id: "step-1", roleId: "qa", task: "   " }],
      }),
    ).toThrow();
  });

  it("rejects a blank plan summary", () => {
    expect(() => decodePlan({ summary: "  ", steps: [] })).toThrow();
  });
});

describe("GenerateOrchestrationPlanInput", () => {
  it("accepts a minimal prompt without a model selection", () => {
    expect(decodeInput({ prompt: "Build a settings page" }).prompt).toBe("Build a settings page");
  });

  it("rejects a blank prompt", () => {
    expect(() => decodeInput({ prompt: "   " })).toThrow();
  });
});

describe("OrchestrationPlanValidation", () => {
  it("round-trips with defaults", () => {
    const validation = Schema.decodeSync(OrchestrationPlanValidation)({ valid: true });
    expect(validation.diagnostics).toEqual([]);
    expect(validation.executionOrder).toEqual([]);
  });
});
