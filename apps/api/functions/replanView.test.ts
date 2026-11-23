import { describe, expect, it } from "vitest";
import { replansFromPlans } from "./lib/replanView";

describe("replansFromPlans (Replan section on /runs)", () => {
  it("reads the replan record of each replanned version, oldest first, ignoring versions without one", () => {
    const views = replansFromPlans([
      {
        version: 2,
        createdAt: 20,
        payload: {
          replan: {
            fromVersion: 1,
            toVersion: 2,
            reason: "implement: boom",
            failedKeys: ["implement"],
            impactKeys: ["qa"],
            frozenKeys: ["analyze"],
            attempts: 2,
            rejected: ["\"implement\" repeats failed node"],
            reasoningMissing: [],
            diff: {
              added: [{ key: "implement_small", title: "Implement (narrow)", kind: "code_change", capability: "frontend-development", reasoning: "narrower scope" }],
              removed: [{ key: "implement", title: "Implement", kind: "code_change", capability: "frontend-development", reasoning: "replaced" }],
              modified: [{ key: "docs", title: "Docs", kind: "code_change", capability: "docs", fields: ["description"], outsideImpact: true }],
              preserved: [{ key: "analyze", title: "Analyze", kind: "analysis", capability: "frontend-development", frozen: true, restored: true }],
            },
          },
        },
      },
      { version: 1, createdAt: 10, payload: { subtasks: [] } },
      { version: 3, createdAt: 30, payload: { replan: "garbage" } },
      { version: 4, createdAt: 40, payload: null },
    ]);
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view).toMatchObject({ fromVersion: 1, toVersion: 2, attempts: 2, failedKeys: ["implement"], frozenKeys: ["analyze"] });
    expect(view.added[0]).toMatchObject({ key: "implement_small", reasoning: "narrower scope", frozen: false });
    expect(view.modified[0]).toMatchObject({ fields: ["description"], outsideImpact: true, reasoning: null });
    expect(view.preserved[0]).toMatchObject({ frozen: true, restored: true });
  });
});
