/**
 * Plan review (Plan Inspector) policy. Pure TypeScript shared by the backend
 * (project setting, approve/edit mutations), the worker (the pause after
 * plan.created) and the web settings menu.
 *
 * - off (default): plans run as soon as they are created.
 * - medium_plus: the run pauses for review when the classifier rates the
 *   request medium, high or ultra complexity.
 * - always: every fresh plan pauses for review.
 *
 * Permission modes (plan 020): Full access skips plan review unless the
 * project setting is "always".
 */
import { normalizePermissionMode } from "./permissionModes";

export const PLAN_REVIEW_SETTINGS = ["off", "medium_plus", "always"] as const;
export type PlanReviewSetting = (typeof PLAN_REVIEW_SETTINGS)[number];

export const PLAN_REVIEW_LABELS: Record<PlanReviewSetting, string> = {
  off: "Off",
  medium_plus: "Medium complexity and up",
  always: "Always",
};

export const PLAN_REVIEW_HINTS: Record<PlanReviewSetting, string> = {
  off: "Plans run as soon as they are made",
  medium_plus: "Pause for your review when a request is medium complexity or more",
  always: "Pause every new plan for your review",
};

export function normalizePlanReview(value: unknown): PlanReviewSetting {
  return typeof value === "string" && (PLAN_REVIEW_SETTINGS as readonly string[]).includes(value)
    ? (value as PlanReviewSetting)
    : "off";
}

const REVIEWED_COMPLEXITY = new Set(["medium", "high", "ultra"]);

export interface PlanReviewDecision {
  applies: boolean;
  /** Short machine reason, recorded on the task event. */
  reason: "setting_off" | "always" | "complexity" | "below_threshold" | "full_access";
}

/**
 * Whether a freshly created plan must wait for the user's review.
 * `permissionMode` is the task's mode (unset / unknown = supervised); only
 * Full access changes anything.
 */
export function planReviewApplies(input: {
  setting: unknown;
  complexity?: string | null;
  permissionMode?: unknown;
}): PlanReviewDecision {
  const setting = normalizePlanReview(input.setting);
  if (setting === "off") return { applies: false, reason: "setting_off" };
  if (setting === "always") return { applies: true, reason: "always" };
  if (normalizePermissionMode(input.permissionMode) === "full_access") return { applies: false, reason: "full_access" };
  return REVIEWED_COMPLEXITY.has(String(input.complexity ?? ""))
    ? { applies: true, reason: "complexity" }
    : { applies: false, reason: "below_threshold" };
}
