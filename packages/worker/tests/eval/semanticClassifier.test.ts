import { describe, expect, it } from "vitest";
import { classifyCommandSemantic } from "@/orchestrator/semanticClassifier";

describe("semantic classifier fallback (plan 085)", () => {
  const command = "jelaskan cara kerja scheduler";

  it("invalid LLM output falls back to read-only research, never code_change", async () => {
    const result = await classifyCommandSemantic(command, {
      enabled: true,
      complete: async () => ({ content: "not json" }),
    });
    expect(result.kind).toBe("research");
    expect(result.source).toBe("fallback");
    expect(result.reasonCode).toBe("LLM_INVALID");
  });

  it("budget veto falls back to read-only research", async () => {
    const result = await classifyCommandSemantic(command, {
      enabled: true,
      complete: async () => ({ content: "{}" }),
      assertBudgetForCall: () => { throw new Error("Budget exhausted"); },
    });
    expect(result.kind).toBe("research");
    expect(result.reasonCode).toBe("BUDGET_VETO");
  });

  it("recorded LLM fixture proposes the validated kind", async () => {
    const fixture = JSON.stringify({ kind: "research", capability: "browser-testing", investigation: false });
    const result = await classifyCommandSemantic("periksa apakah halaman dapat diakses", {
      enabled: true,
      complete: async () => ({ content: fixture }),
    });
    expect(result.kind).toBe("research");
    expect(result.source).toBe("llm");
    expect(result.suggestedCapabilities[0]).toBe("browser-testing");
  });

  it("unambiguous shapes stay on the regex fast path", async () => {
    const result = await classifyCommandSemantic("fix typo in README.md", {
      enabled: true,
      complete: async () => { throw new Error("should not be called"); },
    });
    expect(result.source).toBe("fast-path");
  });
});
