import type {
  ChangesCardData,
  QaCardData,
  QaCardRow,
  VerificationCardCheck,
  VerificationCardData,
} from "@/api/convex/cardTypes";
import type { VerificationResult } from "@/execution/verification";
import { QA_VIEWPORTS } from "@/execution/qa";
import type { FileDiff } from "@/tools/gitDiff";
import type { WorkerApi } from "@/workerApi";

/**
 * Plan 019: chat cards for the verification and QA stages.
 *
 * Builders are pure so the "never fake passed" rule is unit-testable: a
 * step without a script, a step skipped after an earlier failure, and the
 * "nothing applicable" placeholder are all reported as `not_run`.
 */

const LOG_TAIL_LIMIT = 2_000;
const DETAIL_LIMIT = 240;
const ISSUE_LIMIT = 20;

const firstLine = (text: string | undefined, limit = DETAIL_LIMIT) => {
  const line = (text ?? "").trim().split("\n")[0] ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
};

function splitName(full: string): { target?: string; name: string } {
  const at = full.lastIndexOf(":");
  if (at <= 0) return { name: full };
  return { target: full.slice(0, at), name: full.slice(at + 1) };
}

export function buildVerificationCard(
  result: VerificationResult,
  options: { iteration: number; durationMs?: number; steps?: string[]; idempotencyKey?: string }
): VerificationCardData {
  const steps = options.steps ?? ["typecheck", "lint", "test", "build"];
  const checks: VerificationCardCheck[] = [];
  const seen = new Set<string>();
  const targets: string[] = [];
  let logTail: string | undefined;

  for (const check of result.checks ?? []) {
    const { target, name } = splitName(check.name);
    if (target && !targets.includes(target)) targets.push(target);
    seen.add(check.name);
    const placeholder = check.name === "verification";
    let status: VerificationCardCheck["status"] =
      check.status === "failed" ? "failed" : check.status === "passed" && !placeholder ? "passed" : "not_run";
    // The "no package.json" placeholder is recorded as passed upstream,
    // but nothing actually ran: the card says so.
    if (placeholder) status = "not_run";
    if (status === "failed" && !logTail && check.details) {
      logTail = check.details.length <= LOG_TAIL_LIMIT ? check.details : `…${check.details.slice(-LOG_TAIL_LIMIT)}`;
    }
    checks.push({
      name,
      ...(target ? { target } : {}),
      status,
      ...(typeof check.durationMs === "number" ? { durationMs: check.durationMs } : {}),
      ...(check.counts ? { counts: check.counts } : {}),
      ...(status === "passed" ? {} : { detail: firstLine(check.details) }),
    });
  }

  for (const entry of result.skipped ?? []) {
    if (seen.has(entry)) continue;
    const { target, name } = splitName(entry);
    if (target && !targets.includes(target)) targets.push(target);
    seen.add(entry);
    checks.push({ name, ...(target ? { target } : {}), status: "not_run", detail: "no script" });
  }

  // Steps neither run nor skipped were cut short by an earlier failure
  // (runVerification stops at the first failing step).
  const anyFailed = checks.some((c) => c.status === "failed");
  if (anyFailed) {
    for (const target of targets) {
      for (const step of steps) {
        const key = `${target}:${step}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ name: step, target, status: "not_run", detail: "not run after an earlier failure" });
      }
    }
  }

  const ranAny = checks.some((c) => c.status === "passed");
  const outcome: VerificationCardData["outcome"] = anyFailed
    ? "failed"
    : ranAny && (result.checks ?? []).every((c) => c.status === "passed" && c.name !== "verification")
      ? "passed"
      : "inconclusive";

  return {
    taskId: "",
    iteration: options.iteration,
    outcome,
    checks,
    ...(typeof options.durationMs === "number" ? { durationMs: options.durationMs } : {}),
    ...(logTail ? { logTail } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  };
}

const VIEWPORT_NAMES: Record<string, string> = { desktop: "desktop", tablet: "tablet", mobile: "iPhone" };

/** The checklist QA will work through: one row per viewport in visual mode. */
export function plannedQaRows(visual: boolean): QaCardRow[] {
  if (!visual) return [{ label: "structural check", status: "running" }];
  return QA_VIEWPORTS.map((viewport, index) => ({
    label: `${viewport.width} px, ${VIEWPORT_NAMES[viewport.label] ?? viewport.label}`,
    width: viewport.width,
    status: index === 0 ? ("running" as const) : ("pending" as const),
  }));
}

function rowIndexForCheck(rows: QaCardRow[], label: string): number {
  const viewport = /^(\w+) viewport$/.exec(label)?.[1];
  if (viewport) {
    const width = QA_VIEWPORTS.find((v) => v.label === viewport)?.width;
    return rows.findIndex((row) => row.width === width);
  }
  if (label === "structural check") return rows.findIndex((row) => row.label === "structural check");
  return -1;
}

/**
 * Fold one QA check into the checklist: the matching row settles, and the
 * next pending row becomes the one running. Checks that are not a row
 * (reachability, environment) only matter when they fail — they surface as
 * issues on the final card.
 */
export function applyQaCheck(
  rows: QaCardRow[],
  check: { label: string; status: string; details?: string }
): QaCardRow[] {
  const next = rows.map((row) => ({ ...row }));
  const index = rowIndexForCheck(next, check.label);
  if (index < 0) return next;
  next[index].status = check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "not_run";
  if (check.status !== "passed" && check.details) next[index].detail = firstLine(check.details, 160);
  const pending = next.findIndex((row) => row.status === "pending");
  if (pending >= 0 && !next.some((row) => row.status === "running")) next[pending].status = "running";
  return next;
}

/** Rows still pending/running when QA settles did not run. */
function settleRows(rows: QaCardRow[] | undefined): QaCardRow[] | undefined {
  return rows?.map((row) =>
    row.status === "pending" || row.status === "running" ? { ...row, status: "not_run" as const } : row
  );
}

export function buildQaCard(input: {
  outcome: QaCardData["outcome"];
  iteration: number;
  reason?: string;
  checks: Array<{ label: string; status: string; details?: string }>;
  rows?: QaCardRow[];
  issues?: string[];
  fallbackUrl?: string;
  idempotencyKey?: string;
}): QaCardData {
  const urls: string[] = [];
  for (const check of input.checks) {
    for (const match of (check.details ?? "").matchAll(/https?:\/\/[^\s)'"`]+/g)) {
      const url = match[0].replace(/[.,;:]+$/, "");
      if (!urls.includes(url)) urls.push(url);
    }
  }
  if (urls.length === 0 && input.fallbackUrl) urls.push(input.fallbackUrl);
  const issues =
    input.issues ??
    input.checks.filter((c) => c.status === "failed").map((c) => `${c.label}: ${firstLine(c.details) || "failed"}`);
  return {
    taskId: "",
    iteration: input.iteration,
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.rows ? { rows: input.outcome === "running" ? input.rows : settleRows(input.rows) } : {}),
    urls: urls.slice(0, 5),
    issues: issues.slice(0, ISSUE_LIMIT).map((issue) => firstLine(issue, 400)),
    checks: input.checks.slice(0, 30).map((c) => ({
      label: c.label,
      status: c.status,
      ...(c.details ? { detail: firstLine(c.details) } : {}),
    })),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}

/** Count added/removed lines of a unified diff (headers excluded). */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function buildChangesCard(
  files: FileDiff[],
  options: { subtaskKey?: string; idempotencyKey?: string }
): ChangesCardData {
  const rows = files.map((file) => ({
    path: file.filePath,
    changeType: file.changeType,
    ...diffStats(file.diff),
  }));
  return {
    taskId: "",
    ...(options.subtaskKey ? { subtaskKey: options.subtaskKey } : {}),
    files: rows,
    additions: rows.reduce((sum, row) => sum + row.additions, 0),
    deletions: rows.reduce((sum, row) => sum + row.deletions, 0),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  };
}

/**
 * Post a stage card. Best-effort: a card is a view of state the task
 * already recorded in taskEvents, so a failed post never fails the stage.
 */
export async function postStageCard(
  api: Pick<WorkerApi, "postTaskCard" | "logEvent">,
  input: {
    taskId: string;
    projectId: string;
    agentId?: string;
    kind: "verification" | "qa" | "changes";
    content?: string;
    data: VerificationCardData | QaCardData | ChangesCardData;
  }
): Promise<void> {
  try {
    await api.postTaskCard({
      taskId: input.taskId,
      projectId: input.projectId,
      agentId: input.agentId,
      kind: input.kind,
      content: input.content,
      data: input.data,
    });
  } catch (error) {
    try {
      await api.logEvent({
        taskId: input.taskId,
        projectId: input.projectId,
        type: "card.post_failed",
        payload: { kind: input.kind, message: error instanceof Error ? error.message : String(error) },
        level: "warn",
      });
    } catch {
      // Card posting is best-effort; the stage result stands on its own.
    }
  }
}
