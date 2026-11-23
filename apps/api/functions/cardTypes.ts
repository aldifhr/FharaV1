/**
 * Plan 019: data carried by structured chat cards (`messages.card`).
 *
 * Type-only module shared by the backend, the worker (which builds the
 * verification / QA payloads) and the web renderer. `messages.card.data`
 * is stored as `v.any()`, so these interfaces are the contract — keep
 * every field optional-safe on the reader side (old rows predate fields).
 */

export type CardKind = "assignment" | "push" | "qa" | "verification" | "changes" | "plan" | "side_effect" | "options";

/** Options review card (show_options): the card reads the review row live. */
export interface OptionsCardData {
  taskId: string;
  reviewId: string;
}

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
  /** Test counts parsed from the runner output, only when it printed them. */
  counts?: { passed: number; total: number };
}

export interface VerificationCardData {
  taskId: string;
  /**
   * 0 for the phase's first run, n for the run after the phase's n-th
   * verification fix. Counted per phase (see `phase`).
   */
  iteration: number;
  /**
   * Verification phase: 0 = after the initial apply, k = after the k-th
   * QA fix round. Absent on legacy cards (treated as 0).
   */
  phase?: number;
  outcome: "passed" | "failed" | "inconclusive";
  checks: VerificationCardCheck[];
  durationMs?: number;
  /** Bounded tail of the failing step's output (already truncated). */
  logTail?: string;
  idempotencyKey?: string;
  /**
   * GOAT G9: the card posted after Done. `agentOutcome` is what the run's
   * own verification reported; `hostCheck` is the project's check script
   * run by the host. Both absent on the in-run verification cards.
   */
  agentOutcome?: "passed" | "failed" | "inconclusive";
  hostCheck?: HostCheckCardData;
}

/** The project's check script as the host ran it. `not_configured` is never a pass. */
export interface HostCheckCardData {
  status: "passed" | "failed" | "timed_out" | "not_configured" | "blocked" | "error";
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  /** Last 40 lines, at most 4,000 characters, redacted. */
  tail?: string;
  detail?: string;
}

/** One line of the QA checklist (a viewport in visual mode). */
export interface QaCardRow {
  /** Display label, e.g. "1440 px, desktop" or "structural check". */
  label: string;
  /** Viewport width in px, for "checking <url> at 375 px". */
  width?: number;
  status: "pending" | "running" | "passed" | "failed" | "not_run";
  detail?: string;
}

export interface QaCardData {
  taskId: string;
  iteration: number;
  /** "running" while the browser checks are in flight (card updated live). */
  outcome: "running" | "passed" | "failed" | "blocked";
  rows?: QaCardRow[];
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
  additions?: number;
  deletions?: number;
  ahead?: number;
  behind?: number;
}

export interface ChangesCardFile {
  path: string;
  changeType: "new" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

/** "Changed N files" card; the diffs themselves are read from fileChanges. */
export interface ChangesCardData {
  taskId: string;
  subtaskKey?: string;
  files: ChangesCardFile[];
  additions: number;
  deletions: number;
  idempotencyKey?: string;
}

/**
 * Plan Inspector card. Only the task id is stored: the card reads the live
 * plan, estimate and review approval (`planReview.forTask`), so an edit or
 * a decision shows on the same card.
 */
export interface PlanCardData {
  taskId: string;
}

/**
 * L6: a side effect Fhara could not confirm after a crash. Only the effect
 * id is stored; the card reads the live ledger row (`sideEffects.get`) so a
 * click (Check / Mark done / Retry) shows on the same card.
 */
export interface SideEffectCardData {
  effectId: string;
  kind: "push" | "pr_create" | "apply" | "restore";
  /** Plain words, e.g. "push of fhara/t/x@abc1234 to acme/app". */
  label: string;
}
