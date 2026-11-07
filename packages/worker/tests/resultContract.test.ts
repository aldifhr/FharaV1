import { describe, expect, it } from "vitest";
import { hasEvidence, toStructuredResult } from "@/execution/resultContract";
import type { AgentResult } from "@/orchestrator/taskContext";

describe("resultContract: structured execution result", () => {
  it("completed result carries status/summary/files/tools/evidence", () => {
    const r: AgentResult = {
      agentName: "Dev",
      capability: "frontend-development",
      success: true,
      summary: "created Button.tsx",
      meta: { filePaths: ["Button.tsx"] },
    };
    const s = toStructuredResult(r, { toolsExecuted: ["write_file"], evidence: ["file Button.tsx written"] });
    expect(s.status).toBe("COMPLETED");
    expect(s.filesModified).toEqual(["Button.tsx"]);
    expect(s.toolsExecuted).toEqual(["write_file"]);
    expect(hasEvidence(s)).toBe(true);
  });
  it("failed result carries errors, no files", () => {
    const r: AgentResult = { agentName: "Dev", capability: "frontend-development", success: false, summary: "boom" };
    const s = toStructuredResult(r);
    expect(s.status).toBe("FAILED");
    expect(s.errors).toEqual(["boom"]);
    expect(s.filesModified).toEqual([]);
    expect(hasEvidence(s)).toBe(false);
  });
  it("findings are flattened from reviews", () => {
    const r: AgentResult = {
      agentName: "Rev", capability: "code-review", success: true, summary: "reviewed",
      findings: [{ severity: "high", filePath: "a.ts", description: "bug found", suggestion: "fix" }],
    };
    const s = toStructuredResult(r);
    expect(s.findings).toEqual(["bug found"]);
  });
  it("agent response alone never implies orchestrator completion (evidence gate)", () => {
    // Orchestrator's evaluateObjective gates on evidence; contract exposes it.
    const r: AgentResult = { agentName: "Dev", capability: "frontend-development", success: true, summary: "claims done" };
    const s = toStructuredResult(r);
    expect(s.status).toBe("COMPLETED");
    expect(hasEvidence(s)).toBe(false); // no evidence → orchestrator must not complete
  });
});
