/**
 * Plan 019: data carried by structured chat cards (`messages.card`).
 *
 * Type-only module shared by the backend, the worker (which builds the
 * verification / QA payloads) and the web renderer. `messages.card.data`
 * is stored as `v.any()`, so these interfaces are the contract — keep
 * every field optional-safe on the reader side (old rows predate fields).
 */

export type CardKind = "assignment" | "push" | "qa" | "verification";

export interface AssignmentCardData {
  taskId: string;
  title: string;
  assignees: Array<{ agentId: string; name: string; role: string }>;
  assignedBy?: string;
}

/** A check that did not execute is "not_run" — never reported as passed. */
export type CardCheckStatus = "passed" | "failed" | "not_run";

export interface VerificationCardCheck {
  /** Step name: typecheck | lint | test | build | verification. */
  name: string;
  /** Package the step ran in (monorepo target), when known. */
  target?: string;
  status: CardCheckStatus;
  durationMs?: number;
  /** Short reason, e.g. "no script" for a step that did not run. */
  detail?: string;
}

export interface VerificationCardData {
  taskId: string;
  /** 0 for the first run, n for the run after the n-th fix round. */
  iteration: number;
  outcome: "passed" | "failed" | "inconclusive";
  checks: VerificationCardCheck[];
  durationMs?: number;
  /** Bounded tail of the failing step's output (already truncated). */
  logTail?: string;
  idempotencyKey?: string;
}

export interface QaCardData {
  taskId: string;
  iteration: number;
  outcome: "passed" | "failed" | "blocked";
  reason?: string;
  urls: string[];
  issues: string[];
  checks: Array<{ label: string; status: string; detail?: string }>;
  /** Only URLs the backend can serve; local screenshot paths are never sent. */
  screenshots?: Array<{ url: string; label?: string }>;
  idempotencyKey?: string;
}

export interface PushCardData {
  taskId: string;
  pushId: string;
  branchName: string;
  commitSha: string;
  commitMessage: string;
  filesChanged: number;
  ahead?: number;
  behind?: number;
}
