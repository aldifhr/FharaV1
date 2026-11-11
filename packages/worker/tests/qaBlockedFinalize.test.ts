import { describe, expect, it } from "vitest";
import { finalize } from "@/services/runner/finalize";

// fx-ui 2026-11-11 #4: QA that could not run (no Chromium) still ends Done
// (policy.qaRequired decides failing), but the Done carries a visible
// "QA blocked" warning and the summary says so.
describe("finalize: environment-blocked QA", () => {
  it("completes done with a completionWarning and a 'QA blocked' summary line", async () => {
    const messages: string[] = [];
    const completed: any[] = [];
    const deps = {
      policy: { verificationEnabled: false },
      api: {
        getApprovals: async () => [],
        getFileChanges: async () => [],
        recordEvaluation: async () => undefined,
        logEvent: async () => undefined,
        appendAgentMessage: async (m: { content: string }) => void messages.push(m.content),
        completeTask: async (c: unknown) => void completed.push(c),
      },
    };
    await finalize({
      deps: deps as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: { subtasks: [{ key: "qa", kind: "qa" }], requiresApproval: false } as any,
      planVersion: 1,
      agents: [{ _id: "cto", role: "cto" }] as any,
      subtasks: [{ key: "qa", kind: "qa", status: "completed" }] as any,
      state: {
        qaVerdicts: { qa: "blocked" },
        qaChecks: { qa: [{ label: "qa-environment", status: "failed", details: "Chromium is not installed on the worker" }] },
        reviewVerdicts: {},
        fileChanges: new Map(),
        priorOutputs: new Map(),
        appliedFilesBySubtask: new Map(),
        feedback: [],
      } as any,
    });
    expect(completed).toEqual([
      { taskId: "t1", status: "done", completionWarning: "QA blocked: Chromium is not installed on the worker" },
    ]);
    expect(messages[0]).toContain("QA blocked — Chromium is not installed on the worker.");
  });

  it("a passed QA run carries no warning", async () => {
    const completed: any[] = [];
    const deps = {
      policy: { verificationEnabled: false },
      api: {
        getApprovals: async () => [],
        getFileChanges: async () => [],
        recordEvaluation: async () => undefined,
        logEvent: async () => undefined,
        appendAgentMessage: async () => undefined,
        completeTask: async (c: unknown) => void completed.push(c),
      },
    };
    await finalize({
      deps: deps as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: { subtasks: [{ key: "qa", kind: "qa" }], requiresApproval: false } as any,
      planVersion: 1,
      agents: [] as any,
      subtasks: [{ key: "qa", kind: "qa", status: "completed" }] as any,
      state: { qaVerdicts: { qa: "passed" }, reviewVerdicts: {}, fileChanges: new Map(), priorOutputs: new Map(), appliedFilesBySubtask: new Map(), feedback: [] } as any,
    });
    expect(completed[0]).not.toHaveProperty("completionWarning");
  });
});
