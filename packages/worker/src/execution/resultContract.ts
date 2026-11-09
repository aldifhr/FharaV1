/**
 * Plan 008 — Structured execution result contract.
 *
 * Every agent must return this shape so the Orchestrator can gate
 * completion on evidence (not on an agent's self-declaration). The
 * Orchestrator owns the lifecycle; an agent response alone never marks
 * a task completed.
 */
import type { AgentResult } from "@/types";

export interface StructuredResult {
  status: "COMPLETED" | "FAILED" | "SKIPPED";
  summary: string;
  filesModified: string[];
  toolsExecuted: string[];
  evidence: string[];
  findings: string[];
  errors: string[];
  remainingWork: string[];
  recommendations: string[];
}

export function toStructuredResult(
  result: AgentResult,
  meta?: { filesModified?: string[]; toolsExecuted?: string[]; evidence?: string[]; remainingWork?: string[]; recommendations?: string[] }
): StructuredResult {
  const filesModified =
    meta?.filesModified ??
    (result.meta?.filePaths as string[] | undefined) ??
    (Array.isArray(result.meta?.filesModified) ? (result.meta!.filesModified as string[]) : []);
  return {
    status: result.success ? "COMPLETED" : "FAILED",
    summary: result.summary ?? "",
    filesModified: Array.isArray(filesModified) ? filesModified : [],
    toolsExecuted: meta?.toolsExecuted ?? [],
    evidence: meta?.evidence ?? (result.meta?.evidence as string[] | undefined) ?? [],
    findings: (result.findings ?? []).map((f) => f.description).filter(Boolean),
    errors: result.success ? [] : [result.summary ?? "failed"],
    remainingWork: meta?.remainingWork ?? [],
    recommendations: meta?.recommendations ?? [],
  };
}

export function hasEvidence(r: StructuredResult): boolean {
  return r.evidence.length > 0 || r.filesModified.length > 0 || r.toolsExecuted.length > 0;
}
