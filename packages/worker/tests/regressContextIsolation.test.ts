/**
 * Regression lane (regress-tests): context isolation on the worker side.
 *
 * Agent-to-agent hand-offs inside a task read the task's own shared
 * context: a delegated agent's prompt never carries another task's
 * executions, decisions, artifacts or original request, and a plain
 * prior-output hand-off carries only the outputs it was given. The backend
 * half (chat history, summaries, task inputs) is pinned in
 * apps/api/convex/regressContextIsolation.test.ts.
 */
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { executeSubtask, priorContextFor, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import { buildAgentExecutionContext, formatAgentContextForPrompt } from "@/execution/agentContext";
import { appendExecution, addDecision, createSharedTaskContext } from "@/orchestrator/taskContext";
import { classifyCommand } from "@/orchestrator/classifier";
import type { LLMMessage } from "@/types/llm";
import type { AgentDefinition, PlanSubtask, SharedTaskContext } from "@/types";

const REVIEWER: AgentDefinition = { _id: "rv", name: "Reviewer", role: "reviewer", capabilities: ["code-review"], isEnabled: true, priority: 1 };

function taskContext(id: string, marker: string): SharedTaskContext {
  let ctx = createSharedTaskContext({
    taskId: id,
    projectId: "p1",
    originalRequest: `${marker} original request`,
    title: `${marker} title`,
    classification: classifyCommand("add a button"),
  });
  ctx = appendExecution(
    ctx,
    { agentName: "Reviewer", capability: "code-review", subtaskKey: "impl", title: `${marker} impl`, status: "COMPLETED", summary: `${marker} execution summary` },
    [{ type: "file", path: `${marker.toLowerCase()}.ts`, description: `${marker} artifact` } as never],
    [{ id: `${marker}-issue`, severity: "high", description: `${marker} open issue`, status: "open" } as never]
  );
  return addDecision(ctx, { decision: "delegate", reason: `${marker} delegation decision`, createdAt: 1 });
}

const SUBTASK: PlanSubtask = { key: "review", title: "Review", description: "Review the change", kind: "review", capability: "code-review", dependencies: ["impl"], order: 1 };

function input(extra: Partial<SubtaskExecutionInput>): SubtaskExecutionInput {
  return {
    workspacePath: os.tmpdir(),
    command: "add a button",
    plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [SUBTASK] },
    subtask: SUBTASK,
    agent: REVIEWER,
    priorOutputs: new Map(),
    fileChanges: [],
    signal: new AbortController().signal,
    onEvent: async () => undefined,
    onMessage: async () => undefined,
    onChunk: async () => undefined,
    saveFileChange: async () => undefined,
    ...extra,
  } as SubtaskExecutionInput;
}

describe("delegation context stays inside its task", () => {
  it("the curated context of task B carries none of task A", () => {
    taskContext("t-a", "ALPHA");
    const b = taskContext("t-b", "BRAVO");
    const rendered = formatAgentContextForPrompt(buildAgentExecutionContext({ taskContext: b, agent: REVIEWER, assignment: "Review" }));
    expect(rendered).toContain("BRAVO");
    expect(rendered).not.toContain("ALPHA");
  });

  it("the delegated agent's hand-off prompt is built from its own task only", () => {
    const a = taskContext("t-a", "ALPHA");
    const b = taskContext("t-b", "BRAVO");
    const prompt = priorContextFor(input({ taskContext: b }));
    expect(prompt).toContain("BRAVO");
    expect(prompt).not.toContain("ALPHA");
    expect(priorContextFor(input({ taskContext: a }))).not.toContain("BRAVO");
  });

  it("a plain hand-off carries exactly the outputs it was given", () => {
    const prompt = priorContextFor(input({ priorOutputs: new Map([["impl", "BRAVO implementation output"]]) }));
    expect(prompt).toContain("BRAVO implementation output");
    expect(prompt).not.toContain("ALPHA");
  });

  it("the messages sent to the reviewer's LLM never mention another task", async () => {
    taskContext("t-a", "ALPHA");
    const b = taskContext("t-b", "BRAVO");
    const sent: LLMMessage[][] = [];
    const provider = {
      complete: async (messages: LLMMessage[]) => {
        sent.push(messages);
        return { content: '{"verdict":"approved","findings":[]}', inputTokens: 1, outputTokens: 1 };
      },
    };
    await executeSubtask(
      input({
        taskContext: b,
        fileChanges: [{ filePath: "a.ts", changeType: "modified", oldContent: "const a = 1;\n", newContent: "const a = 2;\n", diff: "-const a = 1;\n+const a = 2;\n" }] as never,
        llmHandles: [{ connectionId: "c", connectionName: "t", config: { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" }, provider }],
        deadlineAt: Date.now() + 60_000,
      })
    );
    expect(sent.length).toBeGreaterThan(0);
    const text = JSON.stringify(sent);
    expect(text).toContain("BRAVO");
    expect(text).not.toContain("ALPHA");
  });
});
