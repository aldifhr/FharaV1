import { v } from "convex/values";

/**
 * Permission modes (plans/020-permission-modes.md). Each task carries one;
 * the project stores the default for new tasks. Pure and shared by the
 * backend (which re-checks every auto-approval server-side), the worker and
 * the web UI.
 *
 * - supervised: every approval is asked (the pre-020 behaviour).
 * - auto_edits: file-change approvals (apply_changes, incl. verification
 *   and QA fixes) are approved automatically; risky ones still ask.
 * - full_access: every approval is approved automatically except
 *   push / PR, which always asks. D7: an agent command is first judged by
 *   the project's Reviewer (lib/autoReview.ts); a deny or an unreadable
 *   verdict shows the normal card. `run_unconfined` (D6) always asks.
 *
 * An automatic approval is still an approval row (status "approved",
 * decidedBy "auto") plus an audit row: the gate is recorded, not skipped.
 */
export const PERMISSION_MODES = ["supervised", "auto_edits", "full_access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const permissionModeValidator = v.union(
  v.literal("supervised"),
  v.literal("auto_edits"),
  v.literal("full_access")
);

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  supervised: "Supervised",
  auto_edits: "Auto-accept edits",
  full_access: "Full access",
};

export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  supervised: "Asks before applying any change",
  auto_edits: "Applies file edits; risky actions and push still ask",
  full_access: "Approves everything except push / PR; the Reviewer checks commands first",
};

/** Anything missing or unknown (pre-020 tasks) is supervised. */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : "supervised";
}

/**
 * The project's default for new tasks. Unset: a project on the legacy
 * `approvalMode: "auto"` switch maps to full access (closest match; it
 * already skipped every approval), anything else to supervised.
 */
export function projectDefaultPermissionMode(
  project: { defaultPermissionMode?: unknown; approvalMode?: unknown } | null | undefined
): PermissionMode {
  if (project?.defaultPermissionMode === undefined && project?.approvalMode === "auto") return "full_access";
  return normalizePermissionMode(project?.defaultPermissionMode);
}

export type ApprovalKind = "apply_changes" | "git_push" | "run_command" | "merge_pr";

/**
 * D7: whether an approval in this mode goes to the Reviewer before it is
 * auto-approved. Full access commands only: file changes keep the policy
 * dry-run gate, push / PR never auto-approve, and `run_unconfined` (D6) is
 * always a user card, never reviewed. With no Reviewer in the team the
 * pre-D7 behaviour stands (commandApprovals.ts).
 */
export function autoReviewApplies(mode: PermissionMode, kind: ApprovalKind | "run_unconfined"): boolean {
  return mode === "full_access" && kind === "run_command";
}

/**
 * Auto-accept edits asks again when a batch deletes more files than this.
 * There is no project delete policy yet; this is the conservative default.
 */
export const AUTO_ACCEPT_DELETE_LIMIT = 3;

export interface AutoApprovalRisk {
  /** Files the batch deletes. */
  deletes?: number;
  /** The policy dry-run flagged the batch (it was not a clean "allowed"). */
  policyFlagged?: boolean;
  /** A target lies outside the workspace root. */
  outsideWorkspace?: boolean;
}

export interface AutoApprovalDecision {
  auto: boolean;
  reason: string;
}

/**
 * Whether `mode` approves an approval of `kind` without asking. Push and
 * PR (git_push, merge_pr) always ask, in every mode. A policy flag or an
 * out-of-workspace target always asks too (the broker denies the latter
 * outright before this is reached).
 */
export function autoApprovalDecision(
  mode: PermissionMode,
  kind: ApprovalKind,
  risk: AutoApprovalRisk = {}
): AutoApprovalDecision {
  if (kind === "git_push" || kind === "merge_pr") {
    return { auto: false, reason: "Push and pull requests always ask" };
  }
  if (mode === "supervised") {
    return { auto: false, reason: "Supervised mode asks for every approval" };
  }
  if (risk.outsideWorkspace) {
    return { auto: false, reason: "A target is outside the workspace" };
  }
  if (risk.policyFlagged) {
    return { auto: false, reason: "The policy dry-run flagged this change" };
  }
  if (mode === "full_access") {
    return { auto: true, reason: "Full access" };
  }
  // auto_edits: file changes only.
  if (kind !== "apply_changes") {
    return { auto: false, reason: "Auto-accept edits only approves file changes" };
  }
  if ((risk.deletes ?? 0) > AUTO_ACCEPT_DELETE_LIMIT) {
    return {
      auto: false,
      reason: `Deletes ${risk.deletes} files (more than ${AUTO_ACCEPT_DELETE_LIMIT})`,
    };
  }
  return { auto: true, reason: "Auto-accept edits" };
}
