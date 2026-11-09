import { describe, expect, test } from "vitest";
import { extractRouting, type RoutingEventInput } from "./routing";

const subtasks = [
  { key: "api", title: "Theme API", capability: "backend-development", kind: "code_change", dependencies: [], role: "backend" },
  { key: "ui", title: "Toggle", capability: "frontend-development", kind: "code_change", dependencies: ["api"], role: null },
  { key: "review", title: "Review", capability: "code-review", kind: "review", dependencies: ["ui"], role: null, origin: "review_fix" },
];

const ev = (type: string, payload: unknown, createdAt: number, subtaskKey?: string): RoutingEventInput => ({
  type,
  payload,
  createdAt,
  subtaskKey: subtaskKey ?? null,
});

describe("extractRouting", () => {
  test("classification, CTO planner, routed subtasks with reasons, hand-offs", () => {
    const view = extractRouting({
      events: [
        ev("task.classified", { kind: "change", complexity: "low", strategy: "single", reasons: ["old"] }, 1),
        // Re-claim after plan review: the latest classification wins.
        ev("task.classified", { kind: "change", complexity: "medium", strategy: "dag", reasons: ["frontend", "backend"], concerns: ["tests"] }, 10),
        ev("orchestrator.plan", { strategy: "dag", reasoning: "Two domains" }, 11),
        ev("plan.created", { version: 2, strategy: "dag", createdBy: "user" }, 12),
        ev("subtask.routed", { subtaskKey: "api", capability: "backend-development", agent: "BACKEND", capabilities: ["backend-development"] }, 20),
        ev("subtask.routed", { subtaskKey: "ui", capability: "frontend-development", agent: "DESIGN", capabilities: ["ui-ux-design"] }, 21),
        ev("orchestrator.decision", { subtaskKey: "ui", action: "execute", reasoning: "Ready" }, 30, "ui"),
        ev("orchestrator.decision_fallback", { subtaskKey: "ui", reason: "delegate refused" }, 31, "ui"),
      ],
      subtasks,
      delegations: [{ fromRole: "frontend", toRole: "reviewer", decision: "APPROVE", reason: "Needs a review", createdAt: 40 }],
      roleByAgentName: { BACKEND: "backend", DESIGN: "designer" },
    });

    expect(view.classification).toEqual({
      kind: "change",
      complexity: "medium",
      concerns: ["tests"],
      reasons: ["frontend", "backend"],
      strategy: "dag",
    });
    expect(view.planner).toMatchObject({ mode: "cto", strategy: "dag", reasoning: "Two domains", planVersion: 2, createdBy: "user" });

    const [api, ui, review] = view.subtasks;
    expect(api).toMatchObject({ role: "backend", match: "exact" });
    expect(api.why[0]).toBe("Declares backend-development");
    expect(ui).toMatchObject({ role: "designer", match: "fallback" });
    expect(ui.why).toEqual([
      "No agent declares frontend-development; routed to the closest available agent",
      "Decision: execute — Ready",
      "Decision fallback: delegate refused",
    ]);
    expect(review).toMatchObject({ role: null, match: null });
    expect(review.why).toEqual(["Added during the run (review fix)"]);

    expect(view.handoffs).toEqual([
      { from: "cto", to: "backend", kind: "dependency" },
      { from: "backend", to: "designer", kind: "dependency" },
      { from: "frontend", to: "reviewer", kind: "delegation", decision: "APPROVE", reason: "Needs a review" },
    ]);
  });

  test("planner fallback and degraded plans", () => {
    const fallback = extractRouting({
      events: [ev("plan.planner_fallback", { reason: "CTO not in project team", planner: "CTO" }, 1), ev("plan.created", { version: 1 }, 2)],
      subtasks: [],
      delegations: [],
      roleByAgentName: {},
    });
    expect(fallback.planner).toMatchObject({ mode: "fallback", reason: "CTO not in project team" });

    const degraded = extractRouting({
      events: [
        ev("plan.planner_fallback", { reason: "CTO not in project team; no enabled CTO agent exists", planner: null }, 1),
        ev("plan.degraded", { reason: "LLM planner failed: timeout" }, 2),
      ],
      subtasks: [],
      delegations: [],
      roleByAgentName: {},
    });
    expect(degraded.planner).toMatchObject({ mode: "heuristic", reason: "LLM planner failed: timeout" });

    const empty = extractRouting({ events: [], subtasks: [], delegations: [], roleByAgentName: {} });
    expect(empty.classification).toBeNull();
    expect(empty.planner.mode).toBe("unknown");
  });

  test("an explicit role/match on the routed event wins over name lookup", () => {
    const view = extractRouting({
      events: [ev("subtask.routed", { subtaskKey: "api", capability: "backend-development", agent: "X", role: "devops", match: "fallback", capabilities: ["backend-development"] }, 1)],
      subtasks: [subtasks[0]],
      delegations: [],
      roleByAgentName: { X: "backend" },
    });
    expect(view.subtasks[0]).toMatchObject({ role: "devops", match: "fallback" });
  });
});
