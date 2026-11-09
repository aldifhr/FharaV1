export interface QaCheck {
  label: string;
  status: "passed" | "failed" | "inconclusive";
  details?: string;
  /**
   * Workspace-relative source file the failure points at (derived from a
   * console error's stack / source location), so the fix agent gets a
   * file hint instead of an empty path.
   */
  filePath?: string;
  /**
   * Console errors classified as pre-existing (hydration-mismatch warnings
   * or errors whose stack names no file this task changed). They never fail
   * the check; they are surfaced as a warning.
   */
  preExisting?: string[];
}

export interface QaReport {
  /**
   * `blocked` = the QA ENVIRONMENT could not run the check (no browser
   * binary, no node_modules, no dev script, npm missing). It is never a
   * code defect and must not be routed to an implementer fix.
   */
  verdict: "passed" | "failed" | "inconclusive" | "blocked";
  checks: QaCheck[];
  failures: string[];
  inconclusive: string[];
  /** Why QA was blocked (environment), when verdict is "blocked". */
  blockedReason?: string;
}

/** A QA node's verdict, as recorded per QA subtask key. */
export type QaVerdict = QaReport["verdict"];

/** One recorded QA check (label + status) as the runner keeps it. */
export interface QaCheckRecord {
  label: string;
  status: string;
  details?: string;
  filePath?: string;
  preExisting?: string[];
}
