import { describe, expect, it } from "vitest";

import {
  FHARA_MCP_TOOL_NAMES,
  resolveFharaMcpSummaryAction,
  resolveFharaMcpToolDefinition,
  resolveFharaMcpToolPresentation,
} from "./fharaMcpToolPresentation.ts";

describe("resolveFharaMcpToolPresentation", () => {
  it("recognizes every Fhara tool across provider prefixes and completion suffixes", () => {
    for (const tool of FHARA_MCP_TOOL_NAMES) {
      const presentation = resolveFharaMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__fhara__",
        "mcp__t3_code__",
        "mcp__fhracode__",
        "Fhara-code.",
        "fhara.",
        "fhara-direct.",
        "mcp__t3_code_direct__",
        "fhara_code/",
        "fhara:",
        "mcp_t3-code_",
        "Fhara ",
        "fhara · ",
      ]) {
        expect(resolveFharaMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveFharaMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveFharaMcpToolPresentation("fhara-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveFharaMcpToolPresentation("fhara-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("resolveFharaMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveFharaMcpToolDefinition("mcp__fhara__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveFharaMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveFharaMcpToolDefinition("fhara_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveFharaMcpToolDefinition("fhara_thread_fork")?.displayName);
    expect(resolveFharaMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveFharaMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveFharaMcpSummaryAction("mcp__fhara__t3_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveFharaMcpSummaryAction("fhara_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveFharaMcpSummaryAction("fhara_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveFharaMcpSummaryAction("fhara_thread_configure", {})).toBe("thread-configuration");
    expect(resolveFharaMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveFharaMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
