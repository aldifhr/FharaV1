import { describe, expect, it } from "vitest";
import { parseIntentResult } from "@/router/semantic";
import { classifyCommand } from "@/orchestrator/classifier";

describe("semantic: Stage B", () => {
  it("migrate/convert now fast-path to code_change via expanded verb list", () => {
    expect(classifyCommand("Migrate this project to React.").kind).toBe("code_change");
    expect(classifyCommand("Can we move the frontend to Vue?").kind).toBe("code_change");
  });
  it("parseIntentResult accepts task JSON", () => {
    const r = parseIntentResult('{"intent":"task","subtype":"implementation","confidence":0.9,"reasoning":"migrate"}');
    expect(r?.intent).toBe("task");
    expect(r?.subtype).toBe("implementation");
    expect(r?.confidence).toBe(0.9);
    expect(r?.requiresExecution).toBe(true);
  });
  it("parseIntentResult accepts ask JSON and rejects garbage", () => {
    const r = parseIntentResult('{"intent":"ask","subtype":"explanation","confidence":0.7}');
    expect(r?.intent).toBe("ask");
    expect(parseIntentResult("not json")).toBeNull();
  });
  it("parseIntentResult accepts lifecycle intents", () => {
    const cancel = parseIntentResult('{"intent":"cancel","subtype":"cancel","confidence":0.9}');
    expect(cancel?.intent).toBe("cancel");
    expect(cancel?.requiresExecution).toBe(false);
    const approve = parseIntentResult('{"intent":"approve","subtype":"approve","confidence":0.9}');
    expect(approve?.requiresExecution).toBe(true);
  });
});
