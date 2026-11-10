import { describe, expect, it } from "vitest";
import { evaluateTask } from "@/orchestrator/evaluator";
import { declinedCommandsOf, finalize } from "@/services/runner/finalize";
import { buildStateFromDb } from "@/services/runner/state";

// live2 1d: a subtask whose command the user declined is `skipped`
// ("Declined by user: …"). It is settled (no "did not complete" failure),
// never re-run on resume, and the CTO summary names it.
describe("declined command → skipped subtask", () => {
  const subtasks = [{ key: "shell", kind: "shell", status: "skipped", error: "Declined by user: npm run typecheck" }];

  it("the evaluator treats skipped as settled and notes it", async () => {
    const result = await evaluateTask({ workspacePath: "/tmp", subtasks, fileChanges: [], hasApprovalPlan: false, qaVerdicts: {} });
    expect(result.checks.find((c) => c.name === "subtask-completion")).toBeUndefined();
    expect(result.checks.find((c) => c.name === "subtasks")?.details).toBe("0 subtask(s) completed, 1 skipped");
    expect(result.notes.join(" ")).toContain("Declined by user: npm run typecheck");
  });

  it("finalize reads the declined commands from the rows", () => {
    expect(declinedCommandsOf(subtasks)).toEqual(["npm run typecheck"]);
    expect(declinedCommandsOf([{ status: "skipped", error: "Skipped: superseded" }, { status: "completed" }])).toEqual([]);
  });

  it("a skipped subtask counts as finished on resume", () => {
    const { completedKeys } = buildStateFromDb({ subtasks: subtasks as any, fileChanges: [] });
    expect(completedKeys.has("shell")).toBe(true);
  });
});

describe("finalize: the CTO summary for a declined command", () => {
  it("says 'Not run' and the declined command, never 'Verification: passed'", async () => {
    const messages: string[] = [];
    const completed: unknown[] = [];
    const deps = {
      policy: { verificationEnabled: true },
      api: {
        getApprovals: async () => [],
        getFileChanges: async () => [],
        recordEvaluation: async () => undefined,
        logEvent: async () => undefined,
        appendAgentMessage: async (m: { content: string }) => {
          messages.push(m.content);
        },
        completeTask: async (c: unknown) => {
          completed.push(c);
        },
      },
    };
    await finalize({
      deps: deps as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: { subtasks: [{ key: "shell", kind: "shell" }], requiresApproval: false } as any,
      planVersion: 1,
      agents: [{ _id: "cto", role: "cto" }] as any,
      subtasks: [{ key: "shell", kind: "shell", status: "skipped", error: "Declined by user: npm run typecheck" }] as any,
      state: { qaVerdicts: {}, reviewVerdicts: {}, fileChanges: new Map(), priorOutputs: new Map(), appliedFilesBySubtask: new Map(), feedback: [] } as any,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Not run.");
    expect(messages[0]).toContain("Declined by user: `npm run typecheck`. That command was not run.");
    expect(messages[0]).toContain("Verification: skipped (the command was declined).");
    expect(messages[0]).not.toContain("Verification: passed");
    expect(completed).toEqual([{ taskId: "t1", status: "done" }]);
  });
});

