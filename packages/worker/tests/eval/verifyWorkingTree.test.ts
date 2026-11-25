import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePlan } from "@/api/functions/lib/planValidation";
import { verificationPlan } from "@/orchestrator/verificationPlan";
import type { ExecutionPlan } from "@/types";

/**
 * Integration guard at the plan-validation boundary: a verification request
 * is locked read-only before it can reach any executor, so the checked-out
 * working tree stays byte-for-byte unchanged.
 */
describe("verification task leaves the working tree untouched", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-verify-tree-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it("read-only lock removes write nodes and produces no git changes", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "verify preview URL",
      strategy: "direct",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "implement",
          title: "Implement the change",
          description: "x",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const forced = verificationPlan(plan, "Verify that the preview URL loads", "testing", "auto", ["r1"]);
    const result = validatePlan(forced, 8, { taskKind: "research" });

    expect(result.ok).toBe(true);
    expect(result.plan?.subtasks.some((node) => node.kind === "code_change" || node.kind === "shell")).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("demo\n");
  });
});
