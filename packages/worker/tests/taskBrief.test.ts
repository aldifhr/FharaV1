import { describe, expect, it, vi } from "vitest";
import { createSharedTaskContext } from "@/orchestrator/taskContext";
import { buildAgentExecutionContext, formatAgentContextForPrompt } from "@/execution/agentContext";
import { nextPendingSubtask, pullTaskBrief, recordBriefAfterNode } from "@/services/runner/brief";
import type { RunnerDeps } from "@/services/runner/types";
import type { AgentDefinition, PlanSubtask } from "@/types";

const agent = { _id: "a1", name: "Frontend", role: "frontend", capabilities: ["frontend"] } as unknown as AgentDefinition;

function sub(key: string, order: number, title = key): PlanSubtask {
  return { key, title, description: "", kind: "code_change", capability: "frontend", dependencies: [], order } as PlanSubtask;
}

function shared() {
  return createSharedTaskContext({
    taskId: "t1",
    projectId: "p1",
    originalRequest: "Add dark mode",
    title: "Dark mode",
    classification: { type: "feature", complexity: "simple", suggestedCapabilities: [] } as never,
  });
}

describe("task brief on the worker (plan L3)", () => {
  it("a user-edited next step reaches the next subtask's prompt, first", async () => {
    const ctx = shared();
    const getTaskBrief = vi.fn(async () => ({
      objective: "Add dark mode",
      nextStep: "Use CSS variables, not a second stylesheet",
      openQuestions: ["Default to system theme?"],
      updatedBy: "user",
    }));
    await pullTaskBrief({ api: { getTaskBrief } } as unknown as RunnerDeps, "t1", ctx);
    const prompt = formatAgentContextForPrompt(buildAgentExecutionContext({ taskContext: ctx, agent, assignment: "s2" }));
    expect(prompt.startsWith("Task brief")).toBe(true);
    expect(prompt).toContain("Next step: Use CSS variables, not a second stylesheet");
    expect(prompt).toContain("Default to system theme?");
  });

  it("no brief means no section, and a failed read leaves the context alone", async () => {
    const ctx = shared();
    expect(formatAgentContextForPrompt(buildAgentExecutionContext({ taskContext: ctx, agent, assignment: "x" }))).not.toContain(
      "Task brief"
    );
    await pullTaskBrief({ api: { getTaskBrief: async () => { throw new Error("down"); } } } as unknown as RunnerDeps, "t1", ctx);
    expect(ctx.brief).toBeUndefined();
    // Legacy harness without the brief API: a no-op.
    await pullTaskBrief({ api: {} } as unknown as RunnerDeps, "t1", ctx);
    expect(ctx.brief).toBeUndefined();
  });

  it("after a node, latest result names the node and outcome without any LLM call", async () => {
    const updateTaskBrief = vi.fn(async (patch: Record<string, unknown>) => ({ openQuestions: [], ...patch }));
    const llm = vi.fn();
    const deps = { api: { updateTaskBrief }, llm } as unknown as RunnerDeps;
    const subtasks = [sub("s1", 1, "Write toggle"), sub("s2", 2, "Review toggle")];
    const ctx = shared();
    await recordBriefAfterNode({
      deps,
      taskId: "t1",
      subtask: subtasks[0],
      nodeKey: "s1",
      role: "frontend",
      outcome: { status: "completed", output: "Added Toggle.tsx\nmore detail" },
      next: nextPendingSubtask(subtasks, new Set(["s1"]), "s1"),
      nextRole: "reviewer",
      sharedContext: ctx,
    });
    expect(llm).not.toHaveBeenCalled();
    const arg = updateTaskBrief.mock.calls[0][0] as Record<string, string>;
    expect(arg.latestResult).toBe("Frontend · s1 (Write toggle) completed: Added Toggle.tsx");
    expect(arg.nextStep).toBe("Reviewer · s2 (Review toggle)");
    expect(arg.owner).toBe("reviewer");
    expect(arg).not.toHaveProperty("objective");
    expect(arg).not.toHaveProperty("openQuestions");
    expect(ctx.brief?.latestResult).toContain("s1");
  });

  it("a failed node is recorded as failed; a write failure never throws", async () => {
    const updateTaskBrief = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      recordBriefAfterNode({
        deps: { api: { updateTaskBrief } } as unknown as RunnerDeps,
        taskId: "t1",
        subtask: sub("s1", 1),
        nodeKey: "s1",
        outcome: { status: "failed", error: "tsc failed" },
        next: null,
      })
    ).resolves.toBeUndefined();
    expect((updateTaskBrief.mock.calls[0] as unknown[])[0]).toMatchObject({ latestResult: "s1 (s1) failed: tsc failed" });
  });

  it("nextPendingSubtask picks the lowest order that is not done", () => {
    const subtasks = [sub("c", 3), sub("a", 1), sub("b", 2)];
    expect(nextPendingSubtask(subtasks, new Set(["a"]), "b")?.key).toBe("c");
    expect(nextPendingSubtask(subtasks, new Set(["a", "b", "c"]), "c")).toBeNull();
  });
});
