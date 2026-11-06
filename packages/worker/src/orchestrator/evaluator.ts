import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashContent } from "@/tools/gitDiff";
import { resolveSandboxPathAsync } from "@/tools/sandbox";

export type EvaluationVerdict = "passed" | "failed" | "inconclusive";

export interface EvaluationCheck {
  name: string;
  status: EvaluationVerdict;
  details?: string;
}

export interface EvaluationFileChange {
  filePath: string;
  changeType: "new" | "modified" | "deleted";
  newContentHash?: string;
  newContent?: string;
  appliedAt?: number;
}

export interface EvaluationSubtask {
  key: string;
  kind: string;
  status: string;
  error?: string;
}

export interface EvaluationInput {
  workspacePath: string;
  subtasks: EvaluationSubtask[];
  fileChanges: EvaluationFileChange[];
  hasApprovalPlan: boolean;
  qaVerdicts: Record<string, EvaluationVerdict>;
  verificationChecks?: EvaluationCheck[];
}

export interface EvaluationResult {
  verdict: EvaluationVerdict;
  checks: EvaluationCheck[];
  notes: string[];
}

export async function evaluateTask(input: EvaluationInput): Promise<EvaluationResult> {
  const checks: EvaluationCheck[] = [];
  const notes: string[] = [];

  const failedSubtasks = input.subtasks.filter((subtask) => subtask.status === "failed");
  checks.push({
    name: "subtasks",
    status: failedSubtasks.length === 0 ? "passed" : "failed",
    details:
      failedSubtasks.length === 0
        ? `${input.subtasks.length} subtask(s) completed`
        : failedSubtasks
            .map((subtask) => `${subtask.key}: ${subtask.error ?? "failed"}`)
            .join("; "),
  });

  const pendingSubtasks = input.subtasks.filter(
    (subtask) => subtask.status !== "completed" && subtask.status !== "failed"
  );
  if (pendingSubtasks.length > 0) {
    checks.push({
      name: "subtask-completion",
      status: "failed",
      details: `Subtasks did not complete: ${pendingSubtasks.map((subtask) => subtask.key).join(", ")}`,
    });
  }

  const codeSubtasks = input.subtasks.filter((subtask) => subtask.kind === "code_change");
  if (codeSubtasks.length > 0) {
    if (input.fileChanges.length === 0) {
      checks.push({
        name: "file-changes",
        status: "failed",
        details: "Implementation subtasks completed without producing any file changes",
      });
    } else {
      const unapplied = input.fileChanges.filter((change) => !change.appliedAt);
      if (unapplied.length > 0) {
        checks.push({
          name: "file-changes-applied",
          status: input.hasApprovalPlan ? "failed" : "inconclusive",
          details: `Not applied: ${unapplied.map((change) => change.filePath).join(", ")}`,
        });
      } else {
        checks.push({
          name: "file-changes-applied",
          status: "passed",
          details: input.fileChanges.map((change) => change.filePath).join(", "),
        });
      }

      const verification = await verifyOnDisk(input.workspacePath, input.fileChanges);
      checks.push(verification);
      if (verification.status !== "passed") notes.push(verification.details ?? "");
    }
  }

  if (input.verificationChecks && input.verificationChecks.length > 0) {
    checks.push(...input.verificationChecks);
    notes.push(
      ...input.verificationChecks
        .filter((check) => check.status !== "passed")
        .map((check) => `${check.name}: ${check.details ?? ""}`)
    );
  }

  const qaEntries = Object.entries(input.qaVerdicts);
  if (qaEntries.length > 0) {
    const failedQa = qaEntries.filter(([, verdict]) => verdict === "failed");
    const inconclusiveQa = qaEntries.filter(([, verdict]) => verdict === "inconclusive");
    checks.push({
      name: "qa",
      status:
        failedQa.length > 0 ? "failed" : inconclusiveQa.length > 0 ? "inconclusive" : "passed",
      details: qaEntries.map(([key, verdict]) => `${key}=${verdict}`).join(", "),
    });
  } else {
    const hasQaSubtask = input.subtasks.some((subtask) => subtask.kind === "qa");
    if (hasQaSubtask) {
      checks.push({
        name: "qa",
        status: "inconclusive",
        details: "QA was planned but did not run",
      });
    }
  }

  const verdict: EvaluationVerdict = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "inconclusive")
      ? "inconclusive"
      : "passed";

  return { verdict, checks, notes: notes.filter(Boolean) };
}

async function verifyOnDisk(
  workspacePath: string,
  changes: EvaluationFileChange[]
): Promise<EvaluationCheck> {
  const problems: string[] = [];
  for (const change of changes) {
    if (!change.appliedAt) continue;
    try {
      const resolved = await resolveSandboxPathAsync(workspacePath, change.filePath);
      if (change.changeType === "deleted") {
        try {
          await fs.stat(resolved);
          problems.push(`${change.filePath} still exists after deletion`);
        } catch {
          // Expected.
        }
        continue;
      }
      const content = await fs.readFile(resolved, "utf-8");
      const expected = change.newContentHash;
      if (expected && hashContent(content) !== expected) {
        problems.push(`${change.filePath} content does not match the approved diff`);
      }
    } catch (error) {
      problems.push(
        `${change.filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    name: "disk-verification",
    status: problems.length === 0 ? "passed" : "failed",
    details:
      problems.length === 0
        ? `Verified ${changes.filter((change) => change.appliedAt).length} applied file(s)`
        : problems.join("; "),
  };
}

export function relativeToWorkspace(workspacePath: string, target: string): string {
  return path.relative(workspacePath, target).replace(/\\/g, "/");
}
