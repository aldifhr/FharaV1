import { describe, expect, it } from "vitest";
import { routeMessage } from "@/router/route";
import { parseIntentResult } from "@/router/semantic";
import { classifyCommand } from "@/orchestrator/classifier";

describe("semantic: Stage B", () => {
  it("migrate/convert now fast-path to code_change via expanded verb list", () => {
    expect(classifyCommand("Migrate this project to React.").kind).toBe("code_change");
    expect(classifyCommand("Can we move the frontend to Vue?").kind).toBe("code_change");
  });
  it("parseIntentResult accepts execute_task JSON", () => {
    const r = parseIntentResult('{"intent":"execute_task","confidence":0.9,"summary":"migrate"}');
    expect(r?.intent).toBe("execute_task");
    expect(r?.confidence).toBe(0.9);
  });
  it("parseIntentResult rejects garbage", () => {
    expect(parseIntentResult("not json")).toBeNull();
  });
  it("advisor IntentResult execute_task → task intent", async () => {
    const r = await routeMessage({
      text: "something-weird-xyz",
      agents: [],
      advise: async () => ({ intent: "execute_task", confidence: 0.92, actionability: "implied" as const, projectScope: "current_project" as const, requiresConfirmation: false, summary: "migrate" }),
    });
    expect(r.intent).toBe("task");
  });
  it("advisor clarify stays chat", async () => {
    const r = await routeMessage({
      text: "something-weird-xyz",
      agents: [],
      advise: async () => ({ intent: "clarify", confidence: 0.4, actionability: "uncertain" as const, projectScope: "current_project" as const, requiresConfirmation: true, clarificationQuestion: "Which stack?", summary: "ambiguous" }),
    });
    expect(r.intent).toBe("chat");
    expect(r.reasons.join(" ")).toContain("clarify");
  });
  it("advisor invalid output fails closed to chat", async () => {
    const r = await routeMessage({
      text: "something-weird-xyz",
      agents: [],
      advise: async () => "TASK", // uppercase — not in ALL_INTENTS
    });
    expect(r.intent).toBe("chat");
  });
});
