/**
 * Agent Sandbox model (frontend only).
 *
 * A sandbox experiment is a *task* created through the existing
 * `tasks.createFromCommand` path, but with the sandbox guardrails framing
 * it: the title is prefixed `[Sandbox]`, the command opens with an
 * isolation instruction, and the approval mode is the one picked in the
 * form (supervised by default). The worker still owns execution — this file
 * only shapes the brief and the preview.
 *
 * Honest limits (shown in the UI, not hidden): the sandbox does not get a
 * separate production database or network namespace; isolation here means
 * worktree-scoped changes, the approval gate of the chosen mode, and
 * nothing being pushed without an explicit approval. The guardrails below
 * are instructions in the brief — the enforced gate is the permission mode
 * the backend re-checks on every approval.
 */
import {
  PERMISSION_MODE_LABELS,
  type PermissionMode,
} from "@/api/convex/lib/permissionModes";

export interface SandboxConfig {
  name: string;
  projectId: string;
  instruction: string;
  /** Fail the experiment if it touches production paths. */
  guardProduction: boolean;
  /** Never push anything outside the worktree. */
  guardPush: boolean;
  /** Approval mode of the dispatched task (plan 020). */
  permissionMode: PermissionMode;
  /** Advisory time box in minutes (shown in the brief only). */
  timeboxMinutes: number;
}

export const SANDBOX_PREFIX = "[Sandbox]";

export function defaultSandboxConfig(projectId = ""): SandboxConfig {
  return {
    name: "",
    projectId,
    instruction: "",
    guardProduction: true,
    guardPush: true,
    permissionMode: "supervised",
    timeboxMinutes: 30,
  };
}

/** What the chosen mode means for the run, in one line. */
export function sandboxModeSummary(mode: PermissionMode): string {
  switch (mode) {
    case "full_access":
      return "Full access — every approval is automatic except push / PR, which always ask.";
    case "auto_edits":
      return "Auto-accept edits — file changes are applied automatically; risky actions and push still ask.";
    default:
      return "Supervised — every file change and command is asked before it runs.";
  }
}

/** The task command the sandbox will dispatch. */
export function sandboxCommand(config: SandboxConfig): string {
  const guards: string[] = [];
  if (config.guardProduction) guards.push("do not touch production code paths or secrets");
  if (config.guardPush) guards.push("never push to a remote or open a PR");
  return (
    `Sandbox experiment "${config.name.trim() || "Untitled experiment"}" (isolated from production, ${PERMISSION_MODE_LABELS[config.permissionMode]} mode).\n` +
    `Instruction: ${config.instruction.trim()}\n` +
    `Guardrails: ${guards.length ? guards.join("; ") + "." : "none."} ` +
    `Advisory time box: ${config.timeboxMinutes} minutes.\n` +
    sandboxAcceptanceLine(config.permissionMode)
  );
}

/**
 * When the experiment's changes leave the worktree. The worker merges only
 * after acceptance: the user's approval, or, in a mode that auto-accepts
 * edits, once the run's acceptance checks pass. Push / PR always ask.
 * (The old line, "until a human approves it", was false in Auto-accept
 * edits mode.) Keep "Instruction:" / "Guardrails:" above: the worker reads
 * only the instruction (classifier.unwrapSandboxBrief).
 */
export function sandboxAcceptanceLine(mode: PermissionMode): string {
  if (mode === "auto_edits" || mode === "full_access") {
    return "Changes stay in this worktree until the run passes its acceptance checks; then they are merged automatically. Push / PR still need a human.";
  }
  return "Everything you change stays in this worktree until a human approves it.";
}

export function validateSandbox(config: SandboxConfig): string[] {
  const issues: string[] = [];
  if (!config.projectId) issues.push("Pick a project.");
  if (!config.instruction.trim()) issues.push("Describe what the experiment should try.");
  if (!config.name.trim()) issues.push("Give the experiment a name.");
  if (sandboxCommand(config).length > 4000) {
    issues.push("Instruction is too long — the dispatched command would exceed 4000 characters.");
  }
  return issues;
}

/** Who an approval row names: "Auto" for a permission-mode approval, else "You". */
export function approvalDeciderLabel(decidedBy?: "user" | "auto" | null): "Auto" | "You" {
  return decidedBy === "auto" ? "Auto" : "You";
}
