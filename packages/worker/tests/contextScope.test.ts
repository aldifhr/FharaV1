import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_CHAR_THRESHOLD,
  COMPACT_MESSAGE_THRESHOLD,
  buildChatPrompt,
  buildSummaryPrompt,
  buildTaskPrompt,
  charCount,
  compactIfNeeded,
  messageCount,
  shouldCompact,
} from "@/context/compaction";
import {
  buildAgentExecutionContext,
  formatAgentContextForPrompt,
} from "@/orchestrator/agentContext";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import type { AgentDefinition } from "@/orchestrator/types";

const AGENT: AgentDefinition = {
  _id: "a1",
  name: "Coder",
  role: "developer",
  capabilities: ["frontend-development"],
  systemPrompt: "You are a coder.",
};

const TASK_CTX: SharedTaskContext = {
  taskId: "t1",
  projectId: "p1",
  originalRequest: "build login page",
  objective: "login page ready",
  title: "login",
  classification: {
    kind: "code_change",
    strategy: "single",
    reasons: ["test"],
    suggestedCapabilities: ["frontend-development"],
  } as any,
  status: "RUNNING",
  decisions: [{ decision: "APPROVE", reason: "good", createdAt: 1 }],
  agentExecutions: [
    {
      agentName: "Coder",
      capability: "frontend-development",
      subtaskKey: "impl",
      title: "Implement",
      status: "COMPLETED",
      summary: "created Button.tsx",
    },
  ],
  artifacts: [{ kind: "file_change", path: "Button.tsx", summary: "new button" }],
  outstandingIssues: [],
  updatedAt: 1,
};

describe("contextScope (Plan 006 Phase 3 — C1)", () => {
  it("task prompt contains no conversation-only messages", () => {
    const curated = formatAgentContextForPrompt(
      buildAgentExecutionContext({ taskContext: TASK_CTX, agent: AGENT, assignment: "Do work" })
    );
    const prompt = buildTaskPrompt({ assignment: "Do work", curatedContext: curated });
    expect(prompt).not.toContain("conversation-only-secret");
    expect(prompt).toContain("Button.tsx");
    expect(prompt).toContain("created Button.tsx");
  });

  it("chat prompt contains no decision payloads", () => {
    const chat = buildChatPrompt({
      history: [
        { authorType: "user", content: "hello, how do I do X?" },
        { authorType: "agent", content: "You can do X by Y." },
      ],
      summary: "Earlier chat about X.",
    });
    expect(chat).not.toContain("APPROVE");
    expect(chat).not.toContain("decisions");
    expect(chat).not.toContain("file_change");
    expect(chat).not.toContain("outstandingIssues");
    expect(chat).toContain("Conversation summary: Earlier chat about X.");
    expect(chat).toContain("hello, how do I do X?");
  });

  it("buildAgentExecutionContext filters previous results by capability", () => {
    const ctx = buildAgentExecutionContext({
      taskContext: {
        ...TASK_CTX,
        agentExecutions: [
          {
            agentName: "Other",
            capability: "security-audit",
            subtaskKey: "audit",
            title: "Audit",
            status: "COMPLETED",
            summary: "security finding X",
          },
          {
            agentName: "Coder",
            capability: "frontend-development",
            subtaskKey: "impl",
            title: "Impl",
            status: "COMPLETED",
            summary: "frontend work",
          },
        ],
      },
      agent: AGENT,
      assignment: "work",
    });
    const summaries = ctx.previousResults.map((r) => r.summary ?? "");
    expect(summaries).toContain("frontend work");
    expect(summaries).not.toContain("security finding X");
  });
});

describe("compaction (C2)", () => {
  it("does not compact below thresholds", () => {
    const msgs = Array.from({ length: COMPACT_MESSAGE_THRESHOLD }, (_, i) => ({
      authorType: "user" as const,
      content: `m${i}`,
    }));
    expect(shouldCompact(msgs)).toBe(false);
    expect(messageCount(msgs)).toBe(COMPACT_MESSAGE_THRESHOLD);
    expect(charCount(msgs)).toBeLessThan(COMPACT_CHAR_THRESHOLD);
  });

  it("compacts when message count exceeds 40", () => {
    const msgs = Array.from({ length: COMPACT_MESSAGE_THRESHOLD + 1 }, (_, i) => ({
      authorType: "user" as const,
      content: `m${i}`,
    }));
    expect(shouldCompact(msgs)).toBe(true);
  });

  it("compacts when char count exceeds 24k", () => {
    const msgs = [
      { authorType: "user" as const, content: "x".repeat(COMPACT_CHAR_THRESHOLD + 1) },
    ];
    expect(shouldCompact(msgs)).toBe(true);
  });

  it("compactIfNeeded gates the LLM call on the budget and skips when no trigger", async () => {
    const assertBudgetForCall = vi.fn();
    const summarize = vi.fn(async (_p: string) => "summary text");
    const small = [{ authorType: "user" as const, content: "hi" }];
    const skipped = await compactIfNeeded({ history: small, assertBudgetForCall, summarize });
    expect(skipped.compacted).toBe(false);
    expect(assertBudgetForCall).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();

    const big = Array.from({ length: COMPACT_MESSAGE_THRESHOLD + 1 }, (_, i) => ({
      authorType: "user" as const,
      content: `m${i}`,
    }));
    const done = await compactIfNeeded({ history: big, assertBudgetForCall, summarize });
    expect(done.compacted).toBe(true);
    expect(done.summary).toBe("summary text");
    expect(assertBudgetForCall).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("prompt builder uses summary + last 12 (bounded)", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      authorType: i % 2 === 0 ? ("user" as const) : ("agent" as const),
      content: `msg-${i}`,
    }));
    const prompt = buildChatPrompt({ history, summary: "compacted earlier" });
    expect(prompt.startsWith("Conversation summary: compacted earlier")).toBe(true);
    const lines = prompt.split("\n");
    // last 12 messages only
    expect(lines.join("\n")).toContain("msg-18");
    expect(lines.join("\n")).toContain("msg-29");
    expect(lines.join("\n")).not.toContain("msg-0");
    const summaryPrompt = buildSummaryPrompt(history);
    expect(summaryPrompt).toContain("Summarize the earlier conversation");
  });
});

describe("System lines (O2/O3, one flag: voice \"system\")", () => {
  it("never reach the summary or chat prompt", () => {
    const history = [
      { authorType: "user", content: "add a CSV export" },
      { authorType: "agent", voice: "system", content: "Sent to Backend" },
      { authorType: "agent", content: "Done: export added." },
    ];
    expect(buildSummaryPrompt(history)).not.toContain("Sent to Backend");
    expect(buildChatPrompt({ history })).not.toContain("Sent to Backend");
    expect(buildChatPrompt({ history })).toContain("Done: export added.");
  });
});
