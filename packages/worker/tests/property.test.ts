import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import * as path from "node:path";
import { isWithinWorkspace, resolveSandboxPath, SandboxError } from "@/tools/sandbox";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";
import { nodesConflict, type SchedulerNode } from "@/scheduler/dagScheduler";
import { findCycle, validatePlan } from "@/orchestrator/planValidator";

const RUNS = { numRuns: 50 };

const ROOT = path.resolve("./workspaces/test-project");

describe("property: sandbox containment", () => {
  it("never resolves outside the workspace", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "src", "file.txt", "index.ts", "."), { minLength: 1, maxLength: 4 }),
        (segments) => {
          const requested = segments.join("/");
          try {
            const resolved = resolveSandboxPath(ROOT, requested);
            expect(isWithinWorkspace(ROOT, resolved)).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(SandboxError);
          }
        }
      ),
      RUNS
    );
  });

  it("always rejects ../ escapes", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b"), { minLength: 1, maxLength: 3 }), (segments) => {
        const requested = `../${segments.join("/")}`;
        expect(() => resolveSandboxPath(ROOT, requested)).toThrow(SandboxError);
      }),
      RUNS
    );
  });
});

describe("property: budget tracker", () => {
  it("counts calls and tokens monotonically", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            inputTokens: fc.integer({ min: 0, max: 10_000 }),
            outputTokens: fc.integer({ min: 0, max: 10_000 }),
          }),
          { maxLength: 20 }
        ),
        (calls) => {
          const tracker = new BudgetTracker(loadPolicy());
          let expectedTokens = 0;
          for (const usage of calls) {
            tracker.recordLLMCall({ ...usage, model: "m", agentName: "A" });
            expectedTokens += usage.inputTokens + usage.outputTokens;
            expect(tracker.llmCallCount).toBeLessThanOrEqual(calls.length);
            expect(tracker.totalTokens).toBe(expectedTokens);
          }
          expect(tracker.llmCallCount).toBe(calls.length);
          expect(tracker.totalTokens).toBe(expectedTokens);
          expect(tracker.canCallLLM()).toBe(tracker.llmCallCount < loadPolicy().maxLLMCallsPerTask);
        }
      ),
      RUNS
    );
  });
});

describe("property: scheduler conflicts", () => {
  const arbNode = fc
    .record({
      id: fc.stringMatching(/^[a-z][a-z0-9]*$/),
      paths: fc.option(fc.array(fc.stringMatching(/^[a-z]+\/[a-z]+$/), { maxLength: 2 }), { nil: undefined }),
      writes: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map((n): SchedulerNode => ({ id: n.id, dependencies: [], paths: n.paths, writes: n.writes }));

  it("conflict is symmetric", () => {
    fc.assert(
      fc.property(arbNode, arbNode, (a, b) => {
        expect(nodesConflict(a, b)).toBe(nodesConflict(b, a));
      }),
      RUNS
    );
  });

  it("disjoint scoped paths never conflict", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]+$/),
        fc.stringMatching(/^[a-z]+$/),
        (prefixA, prefixB) => {
          const a: SchedulerNode = { id: "a", dependencies: [], paths: [`${prefixA}/x.ts`], writes: true };
          const b: SchedulerNode = { id: "b", dependencies: [], paths: [`${prefixB}/y.ts`], writes: true };
          if (prefixA !== prefixB) expect(nodesConflict(a, b)).toBe(false);
          if (prefixA === prefixB && prefixA.length > 0) {
            // Same directory scope: at least no crash / boolean result.
            expect(typeof nodesConflict(a, b)).toBe("boolean");
          }
        }
      ),
      RUNS
    );
  });
});

describe("property: plan validation", () => {
  it("accepts chains where every subtask depends on the previous one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (length) => {
        const subtasks = Array.from({ length }, (_, i) => ({
          key: `s${i}`,
          title: `Step ${i}`,
          description: `Do step ${i}`,
          kind: i === 0 ? "code_change" : "analysis",
          capability: "frontend-development",
          dependencies: i === 0 ? [] : [`s${i - 1}`],
          order: i,
        }));
        const result = validatePlan({ goal: "Ship", strategy: "dag", subtasks }, 8);
        expect(result.ok).toBe(true);
        expect(result.plan?.subtasks).toHaveLength(length);
        expect(findCycle(subtasks.map((s) => ({ key: s.key, dependencies: s.dependencies })))).toBeNull();
      }),
      RUNS
    );
  });

  it("detects a full-cycle dependency", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (length) => {
        const subtasks = Array.from({ length }, (_, i) => ({
          key: `s${i}`,
          title: `Step ${i}`,
          description: `Do step ${i}`,
          kind: "analysis",
          capability: "frontend-development",
          dependencies: [`s${(i + 1) % length}`],
          order: i,
        }));
        const result = validatePlan({ goal: "Ship", strategy: "dag", subtasks }, 8);
        expect(result.ok).toBe(false);
        expect(result.errors.join(" ")).toMatch(/cycle/i);
      }),
      RUNS
    );
  });
});
