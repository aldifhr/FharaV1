import { describe, expect, it } from "vitest";
import { createSharedTaskContext, appendExecution, normalizeFindings } from "@/orchestrator/taskContext";
import { buildAgentExecutionContext } from "@/orchestrator/agentContext";
import { classifyCommand } from "@/orchestrator/classifier";
import type { AgentDefinition } from "@/orchestrator/types";

const dev: AgentDefinition = { _id: "dev1", name: "Developer", role: "developer", capabilities: ["frontend-development"], systemPrompt: "You are dev" };
const qa: AgentDefinition = { _id: "qa1", name: "QA", role: "qa", capabilities: ["browser-testing"], systemPrompt: "You are qa" };

describe("agent context", () => {
  it("same task id, previous results available, relevant only", () => {
    const cmd = "Implement and thoroughly test a complex feature";
    const ctx = createSharedTaskContext({
      taskId: "AUTH-001",
      projectId: "p1",
      originalRequest: cmd,
      title: "Feature",
      classification: classifyCommand(cmd),
    });

    const withDev = appendExecution(ctx, {
      agentId: "dev1",
      agentName: "Developer",
      capability: "frontend-development",
      subtaskKey: "implement",
      title: "Implement",
      status: "COMPLETED",
      summary: "Implemented auth",
    });

    const devCtx = buildAgentExecutionContext({ taskContext: withDev, agent: dev, assignment: cmd });
    expect(devCtx.taskId).toBe("AUTH-001");
    expect(devCtx.previousResults).toHaveLength(1);

    const qaCtx = buildAgentExecutionContext({ taskContext: withDev, agent: qa, assignment: "Test auth" });
    expect(qaCtx.taskId).toBe("AUTH-001");
    // QA should see developer summary, not full raw history
    expect(qaCtx.previousResults[0].summary).toBe("Implemented auth");
    // Exclude irrelevant? QA does not get developer internal reasoning — only summary
    expect(qaCtx.previousResults.length).toBeLessThanOrEqual(3);
  });
});

describe("normalizeFindings", () => {
  it("converts plain strings to medium-severity structured findings", () => {
    expect(normalizeFindings(["something is off"])).toEqual([
      { severity: "medium", filePath: "", description: "something is off", suggestion: "" },
    ]);
  });

  it("preserves structured review findings", () => {
    const structured = [
      { severity: "critical", filePath: "a.ts", description: "boom", suggestion: "fix it" },
    ];
    expect(normalizeFindings(structured)).toEqual(structured);
  });

  it("drops unusable entries and non-arrays", () => {
    expect(normalizeFindings(undefined)).toEqual([]);
    expect(normalizeFindings([42, null, { noDescription: true }])).toEqual([]);
  });
});
