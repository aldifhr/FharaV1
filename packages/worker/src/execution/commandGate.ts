/**
 * The executor's view of the command approval gate (chat UX, Feature 2):
 * the outcome shape the runner's in-process wait returns, and the text the
 * agent gets back when a command did not run. Lives in the execution layer
 * so the executor does not import the runner (layering rule).
 */

export interface CommandApprovalOutcome {
  allowed: boolean;
  /** "auto" (rule / Full access), "allow", "always", "deny", "paused", "cancelled", "timeout", "error", "recorded" (G4: already ran before a cut-off). */
  via: "auto" | "allow" | "always" | "deny" | "paused" | "cancelled" | "timeout" | "error" | "recorded";
  reason: string;
  /** The user's note (typed with a decision, or "user replied instead: …"). */
  note?: string;
}

/** The text the agent gets back when a command did not run. */
export function commandDeniedOutput(line: string, outcome: CommandApprovalOutcome): string {
  const why =
    outcome.via === "deny"
      ? "the user denied it"
      : outcome.via === "timeout"
        ? "no one approved it in time"
        : outcome.via === "paused"
          ? "the task was paused"
          : outcome.via === "error"
            ? `the approval could not be recorded (${outcome.reason})`
            : outcome.reason.toLowerCase();
  return [`Command not run: ${line}`, `Reason: ${why}.`, outcome.note ? `User note: ${outcome.note}` : ""]
    .filter(Boolean)
    .join("\n");
}

// ── L2: shell guard (lives in utils/shellGuard so tools/ can use it) ────

export {
  SHELL_GUARD_RULES,
  isSecretFilePath,
  shellGuardDecision,
  shellGuardDecisionForArgv,
  shellGuardOutput,
  type ShellGuardDecision,
} from "@/utils/shellGuard";
