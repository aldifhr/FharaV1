import { describe, expect, it } from "vitest";

import type { AgentRoleId, OrchestrationPlan } from "@fhara/contracts";

import {
  orchestrationPlanLevels,
  topologicalOrder,
  validateOrchestrationPlan,
} from "./orchestrationPlan.ts";

const step = (
  id: string,
  dependsOn: ReadonlyArray<string> = [],
  roleId = "backend",
): OrchestrationPlan["steps"][number] => ({
  id,
  roleId: roleId as AgentRoleId,
  task: `do ${id}`,
  dependsOn: [...dependsOn],
  requiresApproval: false,
});

const plan = (...steps: Array<OrchestrationPlan["steps"][number]>): OrchestrationPlan => ({
  summary: "test plan",
  steps,
});

describe("validateOrchestrationPlan", () => {
  it("accepts a linear plan and orders the steps", () => {
    const result = validateOrchestrationPlan(plan(step("a"), step("b", ["a"]), step("c", ["b"])));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.executionOrder).toEqual(["a", "b", "c"]);
  });

  it("accepts a diamond and keeps the sink last", () => {
    const result = validateOrchestrationPlan(
      plan(step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])),
    );
    expect(result.valid).toBe(true);
    expect(result.executionOrder[0]).toBe("a");
    expect(result.executionOrder[3]).toBe("d");
    expect(result.executionOrder).toHaveLength(4);
  });

  it("breaks ties between ready steps by input order", () => {
    const result = validateOrchestrationPlan(plan(step("b"), step("a"), step("c", ["a", "b"])));
    expect(result.executionOrder).toEqual(["b", "a", "c"]);
  });

  it("reports a two-sided cycle and no execution order", () => {
    const result = validateOrchestrationPlan(plan(step("a", ["b"]), step("b", ["a"])));
    expect(result.valid).toBe(false);
    expect(result.executionOrder).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["cycle"]);
    expect(result.diagnostics[0]!.message).toContain("a");
    expect(result.diagnostics[0]!.message).toContain("b");
  });

  it("reports every member of a longer cycle", () => {
    const result = validateOrchestrationPlan(
      plan(step("a", ["c"]), step("b", ["a"]), step("c", ["b"])),
    );
    expect(result.valid).toBe(false);
    const message = result.diagnostics.find((entry) => entry.code === "cycle")!.message;
    expect(message).toContain("a");
    expect(message).toContain("b");
    expect(message).toContain("c");
  });

  it("marks nodes downstream of a cycle as blocked too", () => {
    const result = validateOrchestrationPlan(
      plan(step("a", ["b"]), step("b", ["a"]), step("d", ["b"])),
    );
    expect(result.valid).toBe(false);
    const message = result.diagnostics.find((entry) => entry.code === "cycle")!.message;
    expect(message).toContain("d");
  });

  it("reports a self dependency without a duplicate cycle diagnostic", () => {
    const result = validateOrchestrationPlan(plan(step("a", ["a"]), step("b")));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["self-dependency"]);
  });

  it("reports dependencies on unknown steps", () => {
    const result = validateOrchestrationPlan(plan(step("a", ["ghost"])));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["missing-dependency"]);
    expect(result.diagnostics[0]!.stepId).toBe("a");
  });

  it("reports duplicate step ids", () => {
    const result = validateOrchestrationPlan(plan(step("a"), step("a"), step("b", ["a"])));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("duplicate-step-id");
  });

  it("reports unregistered roles", () => {
    const result = validateOrchestrationPlan(plan(step("a", [], "ghost-role")));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["unknown-role"]);
    expect(result.diagnostics[0]!.stepId).toBe("a");
  });

  it("reports an empty plan", () => {
    const result = validateOrchestrationPlan(plan());
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["empty-plan"]);
  });

  it("collects multiple independent problems in one pass", () => {
    const result = validateOrchestrationPlan(
      plan(step("a", ["missing"]), step("a"), step("b", [], "ghost-role")),
    );
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("duplicate-step-id");
    expect(codes).toContain("missing-dependency");
    expect(codes).toContain("unknown-role");
  });
});

describe("topologicalOrder", () => {
  it("returns null for cyclic graphs", () => {
    expect(topologicalOrder([step("a", ["b"]), step("b", ["a"])])).toBeNull();
  });
});

describe("orchestrationPlanLevels", () => {
  it("layers a diamond into three levels", () => {
    const levels = orchestrationPlanLevels(
      plan(step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])),
    );
    expect(levels.get("a")).toBe(0);
    expect(levels.get("b")).toBe(1);
    expect(levels.get("c")).toBe(1);
    expect(levels.get("d")).toBe(2);
  });

  it("terminates on cyclic input", () => {
    const levels = orchestrationPlanLevels(
      plan(step("a", ["b"]), step("b", ["a"]), step("d", ["a"])),
    );
    expect(levels.get("a")).toBeTypeOf("number");
    expect(levels.get("b")).toBeTypeOf("number");
    expect(levels.get("d")).toBeTypeOf("number");
  });
});
