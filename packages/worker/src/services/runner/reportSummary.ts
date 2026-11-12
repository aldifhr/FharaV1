/**
 * P2: the cross-role summary inside the final report (finalize.ts).
 *
 * Built by the system from the run's own records (subtask rows, applied file
 * changes, review / QA verdicts), never by an LLM. One line per working role
 * (capped), then the Review and QA evidence and any unfinished nodes. Role
 * labels only: the report never @mentions an agent.
 */
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/types";
import { ROLES, type RoleKey } from "@/api/convex/lib/roles";
import { resolveRoleKey } from "@/utils/rolePolicy";
import { isGateNode, roleForSubtask } from "@/orchestrator/responseOwner";
import type { RunState } from "./types";

/** At most this many role lines; the last one names the overflow. */
export const MAX_ROLE_LINES = 3;
const MAX_FILES = 3;
const MAX_UNFINISHED = 3;
const MAX_QA_LABELS = 4;

type SummaryRow = {
  key: string;
  kind: string;
  status: string;
  title?: string;
  capability?: string;
  error?: string;
  origin?: string;
  assignedAgentId?: string;
};

export interface ReportSummaryInput {
  plan: Pick<ExecutionPlan, "subtasks">;
  subtasks: readonly SummaryRow[];
  state: Pick<RunState, "reviewVerdicts" | "qaVerdicts" | "qaChecks" | "fileChanges" | "appliedFilesBySubtask">;
  agents: readonly AgentDefinition[];
  /** The task's file-change rows; applied rows count, attributed by subtaskKey. */
  changes?: ReadonlyArray<{ filePath: string; subtaskKey?: string; appliedAt?: number }>;
}

export interface ReportSummary {
  roleLines: string[];
  reviewLine: string;
  qaLine: string;
  unfinishedLine: string;
  /** Short QA-blocked reason, when a QA node was blocked by its environment. */
  qaBlockedDetail?: string;
  qaBlocked: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const baseName = (filePath: string) => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
/** Never @mention anyone in the report. */
const noMention = (text: string) => text.replace(/@(?=\w)/g, "");

function roleLabel(role: string): string {
  const known = ROLES[role as RoleKey]?.label;
  if (known) return known;
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : "Team";
}

function roleOfRow(row: SummaryRow, input: ReportSummaryInput): string | null {
  if (row.assignedAgentId) {
    const agent = input.agents.find((a) => String(a._id) === String(row.assignedAgentId));
    const raw = agent?.role ?? "";
    if (raw.trim()) return resolveRoleKey(raw) ?? raw.trim().toLowerCase();
  }
  const planned = input.plan.subtasks.find((s) => s.key === row.key);
  const capability = row.capability ?? planned?.capability;
  return capability ? roleForSubtask({ capability }, input.agents as AgentDefinition[]) : null;
}

function filesOf(keys: Set<string>, input: ReportSummaryInput): string[] {
  const files = new Set<string>();
  for (const change of input.changes ?? []) {
    if (change.appliedAt && change.subtaskKey && keys.has(change.subtaskKey)) files.add(change.filePath);
  }
  for (const key of keys) for (const file of input.state.appliedFilesBySubtask?.get(key) ?? []) files.add(file);
  return [...files];
}

/** One line per working role (gate nodes are reported by the Review/QA lines). */
export function buildRoleLines(input: ReportSummaryInput): string[] {
  const byRole = new Map<string, SummaryRow[]>();
  for (const row of input.subtasks) {
    if (isGateNode(row as Pick<PlanSubtask, "key" | "kind">)) continue;
    const role = roleOfRow(row, input);
    if (!role) continue;
    byRole.set(role, [...(byRole.get(role) ?? []), row]);
  }
  const lines = [...byRole.entries()].map(([role, rows]) => {
    const done = rows.filter((row) => row.status === "completed").length;
    const count = done === rows.length ? `${plural(done, "subtask")} done` : `${done} of ${plural(rows.length, "subtask")} done`;
    const files = filesOf(new Set(rows.map((row) => row.key)), input);
    const shown = files.slice(0, MAX_FILES).map(baseName);
    const more = files.length > MAX_FILES ? `, +${files.length - MAX_FILES} more` : "";
    const fileText = files.length > 0 ? `, ${plural(files.length, "file")} changed (${shown.join(", ")}${more})` : "";
    const fixes = rows.filter((row) => row.origin === "fix" || row.origin === "review_fix").length;
    const fixText = fixes > 0 ? `, incl. ${plural(fixes, "fix")}` : "";
    return noMention(`${roleLabel(role)}: ${count}${fixText}${fileText}.`);
  });
  if (lines.length <= MAX_ROLE_LINES) return lines;
  const rest = [...byRole.keys()].slice(MAX_ROLE_LINES - 1).map(roleLabel);
  return [...lines.slice(0, MAX_ROLE_LINES - 1), `Also worked: ${rest.join(", ")}.`];
}

export function buildReviewLine(state: ReportSummaryInput["state"]): string {
  const verdicts = Object.values(state.reviewVerdicts);
  if (verdicts.length === 0) return "";
  if (verdicts.every((r) => r.verdict === "approved")) {
    const files = state.fileChanges.size;
    return `Review: approved${files > 0 ? ` (${plural(files, "file")} reviewed, no blocking findings)` : ""}.`;
  }
  const findings = verdicts.filter((r) => r.verdict !== "approved").reduce((n, r) => n + (r.findings?.length ?? 0), 0);
  return `Review: changes requested${findings > 0 ? ` (${plural(findings, "finding")})` : ""}.`;
}

function qaLabels(state: ReportSummaryInput["state"], keys: string[], status?: string): string[] {
  const labels = keys
    .flatMap((key) => state.qaChecks?.[key] ?? [])
    .filter((check) => check.label !== "qa-environment" && (!status || check.status === status))
    .map((check) => check.label);
  return [...new Set(labels)];
}

function listed(labels: string[]): string {
  const shown = labels.slice(0, MAX_QA_LABELS).join(", ");
  return labels.length > MAX_QA_LABELS ? `${shown}, +${labels.length - MAX_QA_LABELS} more` : shown;
}

export function buildQaLine(state: ReportSummaryInput["state"]): { line: string; blocked: boolean; blockedDetail?: string } {
  const entries = Object.entries(state.qaVerdicts);
  if (entries.length === 0) return { line: "", blocked: false };
  const keys = entries.map(([key]) => key);
  const blocked = entries.filter(([, verdict]) => verdict === "blocked");
  if (blocked.length > 0) {
    const blockedDetail = blocked
      .flatMap(([key]) => state.qaChecks?.[key] ?? [])
      .find((check) => check.label === "qa-environment")?.details;
    return {
      line: `QA blocked — ${blockedDetail ?? "the QA environment could not run browser checks"}. Browser checks did not run.`,
      blocked: true,
      blockedDetail,
    };
  }
  if (entries.some(([, verdict]) => verdict === "failed")) {
    const failed = qaLabels(state, keys, "failed");
    return { line: `QA: failed${failed.length > 0 ? ` (${listed(failed)})` : ""}.`, blocked: false };
  }
  if (entries.some(([, verdict]) => verdict === "inconclusive")) {
    const open = qaLabels(state, keys, "inconclusive");
    return { line: `QA: inconclusive${open.length > 0 ? ` (${listed(open)})` : ""}.`, blocked: false };
  }
  const tested = qaLabels(state, keys);
  const what = tested.length > 0 ? ` Tested ${plural(tested.length, "check")}: ${listed(tested)}.` : "";
  return { line: `QA: structural browser checks passed.${what}`, blocked: false };
}

/** Failed, blocked, or skipped nodes with their reason (declined commands are reported apart). */
export function buildUnfinishedLine(subtasks: readonly SummaryRow[]): string {
  const open = subtasks.filter(
    (row) =>
      (row.status === "failed" || row.status === "blocked" || row.status === "skipped") &&
      !/^Declined by user\b/i.test(row.error ?? "")
  );
  if (open.length === 0) return "";
  const items = open.slice(0, MAX_UNFINISHED).map((row) => {
    const name = clip(row.title?.trim() || row.key, 60);
    const reason = row.error?.trim() ? `: ${clip(row.error.trim().split("\n")[0], 80)}` : "";
    return `${name} (${row.status}${reason})`;
  });
  const more = open.length > MAX_UNFINISHED ? `; +${open.length - MAX_UNFINISHED} more` : "";
  return noMention(`Not finished: ${items.join("; ")}${more}.`);
}

export function buildReportSummary(input: ReportSummaryInput): ReportSummary {
  const qa = buildQaLine(input.state);
  return {
    roleLines: buildRoleLines(input),
    reviewLine: buildReviewLine(input.state),
    qaLine: qa.line,
    unfinishedLine: buildUnfinishedLine(input.subtasks),
    qaBlocked: qa.blocked,
    ...(qa.blockedDetail ? { qaBlockedDetail: qa.blockedDetail } : {}),
  };
}
