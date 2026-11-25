import { describe, expect, it } from "vitest";
import { ROLES } from "@/api/functions/lib/roles";
import { verificationPlan } from "@/orchestrator/verificationPlan";
import type { ExecutionPlan } from "@/types";

/**
 * Owner-approved label: a verify request is read-only (research + QA). The
 * plan must contain no write node, and QA has no write permission, so the
 * task cannot modify the working tree.
 */
describe("verify does not change the working tree", () => {
  it("forces a single QA node and no code_change", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "verify",
      strategy: "direct",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "implement",
          title: "Implement the change",
          description: "x",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const forced = verificationPlan(plan, "Verify that http://127.0.0.1:5173 loads", "testing", "auto", ["r1"]);
    expect(forced?.subtasks.map((node) => node.kind)).toEqual(["qa"]);
    expect(forced?.subtasks.some((node) => node.kind === "code_change")).toBe(false);
    expect(ROLES.qa.permissions.write).toBe(false);
  });
});
