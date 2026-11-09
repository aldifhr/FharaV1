import { describe, expect, it } from "vitest";
import { validatePlan, findCycle } from "@/orchestrator/planValidator";

const validPlan = {
  goal: "Ship a feature",
  strategy: "dag",
  subtasks: [
    {
      key: "implement",
      title: "Implement",
      description: "Do the work",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 0,
    },
    {
      key: "review",
      title: "Review",
      description: "Check the work",
      kind: "review",
      capability: "code-review",
      dependencies: ["implement"],
      order: 1,
    },
  ],
};

describe("plan validator", () => {
  it("accepts a valid plan and forces the approval gate for code changes", () => {
    const result = validatePlan({ ...validPlan, requiresApproval: false }, 8);
    expect(result.ok).toBe(true);
    expect(result.plan?.requiresApproval).toBe(true);
    expect(result.plan?.subtasks.map((subtask) => subtask.key)).toEqual([
      "implement",
      "review",
    ]);
  });

  it("rejects duplicate keys", () => {
    const result = validatePlan(
      {
        ...validPlan,
        subtasks: [
          { ...validPlan.subtasks[0] },
          { ...validPlan.subtasks[1], key: "implement", dependencies: [] },
        ],
      },
      8
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate");
  });

  it("rejects unknown dependencies", () => {
    const result = validatePlan(
      {
        ...validPlan,
        subtasks: [{ ...validPlan.subtasks[0], dependencies: ["missing"] }],
      },
      8
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("unknown subtask");
  });

  it("detects dependency cycles", () => {
    const result = validatePlan(
      {
        ...validPlan,
        subtasks: [
          { ...validPlan.subtasks[0], dependencies: ["review"] },
          { ...validPlan.subtasks[1], dependencies: ["implement"] },
        ],
      },
      8
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("cycle");
    expect(
      findCycle([
        { key: "a", title: "", description: "", kind: "analysis", capability: "general", dependencies: ["b"], order: 0 },
        { key: "b", title: "", description: "", kind: "analysis", capability: "general", dependencies: ["a"], order: 1 },
      ])
    ).not.toBeNull();
  });

  it("enforces the subtask budget", () => {
    const result = validatePlan(validPlan, 1);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("limit is 1");
  });

  it("rejects invalid keys", () => {
    const result = validatePlan(
      { ...validPlan, subtasks: [{ ...validPlan.subtasks[0], key: "Bad Key!" }] },
      8
    );
    expect(result.ok).toBe(false);
  });

  it("keeps declared path ownership and rejects escaping entries", () => {
    const subtasks = [
      { ...validPlan.subtasks[0], allowedPaths: ["apps/web"] },
      validPlan.subtasks[1],
    ];
    const ok = validatePlan({ ...validPlan, subtasks }, 8);
    expect(ok.ok).toBe(true);
    expect(ok.plan?.subtasks[0].allowedPaths).toEqual(["apps/web"]);

    const bad = validatePlan(
      {
        ...validPlan,
        subtasks: [{ ...validPlan.subtasks[0], allowedPaths: ["../secret"] }, validPlan.subtasks[1]],
      },
      8
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("allowedPaths");
  });
});
