import { describe, expect, it } from "vitest";
import { BudgetSnapshotSchema, DraftSchema, McpCallResultSchema, McpToolSchema, ReviewSchema } from "@/utils/schemas";
import { parseDraft, parseReview } from "@/utils/json";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";

describe("worker boundary schemas", () => {
  it("parses a valid draft and rejects an empty filePath", () => {
    expect(DraftSchema.safeParse({ files: [{ filePath: "a.ts", newContent: "hi" }] }).success).toBe(true);
    expect(DraftSchema.safeParse({ files: [{ filePath: "", newContent: "hi" }] }).success).toBe(false);
    expect(parseDraft(JSON.stringify({ files: [{ filePath: "a.ts", newContent: "hi" }] }))).toEqual({
      files: [{ filePath: "a.ts", newContent: "hi" }],
    });
  });

  it("parses a review verdict", () => {
    const content = JSON.stringify({ verdict: "approved", findings: [] });
    expect(parseReview(content)).toEqual({ verdict: "approved", findings: [] });
    expect(ReviewSchema.safeParse({ verdict: "approved", findings: [] }).success).toBe(true);
  });

  it("validates MCP tool entries and call results", () => {
    expect(McpToolSchema.safeParse({ name: "read_file", description: "d", inputSchema: {} }).success).toBe(true);
    expect(McpToolSchema.safeParse({ name: "" }).success).toBe(false);
    expect(McpCallResultSchema.safeParse({ isError: false, content: [{ type: "text", text: "ok" }] }).success).toBe(true);
  });

  it("validates policy-derived budget snapshots", () => {
    const tracker = new BudgetTracker(loadPolicy());
    tracker.recordLLMCall({ inputTokens: 10, outputTokens: 5, model: "m", agentName: "A" });
    const snapshot = tracker.snapshot();
    expect(BudgetSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(loadPolicy().maxSubtasks).toBeGreaterThanOrEqual(1);
  });
});
