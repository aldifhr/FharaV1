import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hashContent } from "@/tools/gitDiff";
import { evaluateTask } from "@/orchestrator/evaluator";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-eval-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("evaluator", () => {
  it("passes a completed task with verified applied changes", async () => {
    const content = "export const ok = true;\n";
    await fs.writeFile(path.join(root, "app.ts"), content, "utf-8");
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [
        { key: "implement", kind: "code_change", status: "completed" },
        { key: "review", kind: "review", status: "completed" },
      ],
      fileChanges: [
        {
          filePath: "app.ts",
          changeType: "modified",
          newContentHash: hashContent(content),
          appliedAt: Date.now(),
        },
      ],
      hasApprovalPlan: true,
      qaVerdicts: {},
    });
    expect(result.verdict).toBe("passed");
  });

  it("fails when an applied file no longer matches the approved content", async () => {
    await fs.writeFile(path.join(root, "app.ts"), "tampered", "utf-8");
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "implement", kind: "code_change", status: "completed" }],
      fileChanges: [
        {
          filePath: "app.ts",
          changeType: "modified",
          newContentHash: hashContent("expected"),
          appliedAt: Date.now(),
        },
      ],
      hasApprovalPlan: true,
      qaVerdicts: {},
    });
    expect(result.verdict).toBe("failed");
    expect(result.checks.map((check) => check.name)).toContain("disk-verification");
  });

  it("fails when implementation produced no changes", async () => {
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "implement", kind: "code_change", status: "completed" }],
      fileChanges: [],
      hasApprovalPlan: true,
      qaVerdicts: {},
    });
    expect(result.verdict).toBe("failed");
  });

  it("fails when a subtask is still pending", async () => {
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "qa", kind: "qa", status: "pending" }],
      fileChanges: [],
      hasApprovalPlan: false,
      qaVerdicts: {},
    });
    expect(result.verdict).toBe("failed");
  });

  it("reports inconclusive when QA was planned but did not run", async () => {
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "qa", kind: "qa", status: "completed" }],
      fileChanges: [],
      hasApprovalPlan: false,
      qaVerdicts: {},
    });
    expect(result.verdict).toBe("inconclusive");
  });

  it("fails when static verification fails", async () => {
    const content = "export const ok = true;\n";
    await fs.writeFile(path.join(root, "app.ts"), content, "utf-8");
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "implement", kind: "code_change", status: "completed" }],
      fileChanges: [
        {
          filePath: "app.ts",
          changeType: "modified",
          newContentHash: hashContent(content),
          appliedAt: Date.now(),
        },
      ],
      hasApprovalPlan: true,
      qaVerdicts: {},
      verificationChecks: [
        { name: "@app/web:typecheck", status: "failed", details: "error TS2322" },
      ],
    });
    expect(result.verdict).toBe("failed");
    expect(result.checks.map((check) => check.name)).toContain("@app/web:typecheck");
  });

  it("fails when QA reports failures", async () => {
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "qa", kind: "qa", status: "completed" }],
      fileChanges: [],
      hasApprovalPlan: false,
      qaVerdicts: { qa: "failed" },
    });
    expect(result.verdict).toBe("failed");
  });

  it("blocks completion on open critical/high issues even with inconclusive verification (plan 013)", async () => {
    const result = await evaluateTask({
      workspacePath: root,
      subtasks: [{ key: "implement", kind: "code_change", status: "completed" }],
      fileChanges: [],
      hasApprovalPlan: true,
      qaVerdicts: {},
      openIssues: [
        { severity: "critical", description: "auth bypass", status: "open" },
        { severity: "medium", description: "cosmetic", status: "open" },
        { severity: "high", description: "ignored one", status: "ignored" },
      ],
      verificationChecks: [{ name: "verify", status: "inconclusive", details: "no data" }],
    });
    expect(result.verdict).toBe("failed");
    const check = result.checks.find((c) => c.name === "open-issues");
    expect(check?.details).toContain("auth bypass");
    expect(check?.details).not.toContain("cosmetic");
  });
});
