import { isTransientLlmError } from "@/effects/llmCall";

/**
 * P1b phase 4 (scheduler purification): the ONLY place that decides what
 * happens to a node that did not run to completion. The scheduler and
 * runNodes report plain facts as a `RetryObservation` and perform the
 * `RetryDecision` they get back:
 *
 *   - `failed`               the scheduler, a node settled failed
 *   - `stalled`              the scheduler, the no-progress watchdog fired
 *   - `prerequisite_missing` runNodes, a subset node's dependency never ran
 *   - `unroutable`           runNodes, no agent can serve the capability
 *   - `runtime_unavailable`  runNodes, OpenCode is selected but unavailable
 *
 * Pure: facts in, decision out. Timers, leases, abort grace and events
 * stay in the caller. A fact the decision may need but the caller has not
 * read yet (`halted`, `budgetLeft`) is left unset; the engine then answers
 * `check` naming it, so the caller consults its hooks in exactly the order
 * and on exactly the paths it always did. Behaviour is unchanged from the
 * inline code it replaced; tests/schedulerRetry.golden.test.ts,
 * tests/runNodesObservations.golden.test.ts and the L8 scenarios in
 * tests/decisionEngine.golden.test.ts pin it.
 *
 * Rounds are not retries: a stage loop's fix round is decided by
 * `decideFixOwner` / `fixRoundsExhausted` (fixOwner.ts) and a re-plan by
 * `decideReplan` (replan.ts). A retry here re-runs the SAME node inside its
 * own round and never reads or spends a round, so a failed fix node can
 * never buy its loop an extra round.
 */

/** Error class a failed node reports. */
export type FailureClass = "permanent" | "transient" | "budget" | "escalation" | "unknown";

/** Facts the scheduler reads lazily, on the engine's request. */
interface LazyFacts {
  /** A halt is latched or requested (nothing new may start). Unset = not read yet. */
  halted?: boolean;
  /** The task can still pay for another attempt (deadline / LLM budget). Unset = not read yet. */
  budgetLeft?: boolean;
}

export interface FailedObservation extends LazyFacts {
  kind: "failed";
  nodeKey: string;
  errorClass: FailureClass;
  /** The attempt that just failed (1-based). */
  attempt: number;
  /** Retries allowed after the first attempt (`hooks.retries`). */
  maxAttempts: number;
  /** The run was cancelled. */
  cancelled: boolean;
  /** Base backoff; attempt n waits n × this before attempt n + 1. */
  retryDelayMs: number;
}

export interface StalledObservation extends LazyFacts {
  kind: "stalled";
  nodeKey: string;
  /** Stalls of this node so far, this one included. */
  attempt: number;
  /** Stall retries allowed (`hooks.stallRetries`). */
  maxAttempts: number;
  cancelled: boolean;
  /** The watchdog's error (carried into the escalation). */
  error: string;
}

export interface PrerequisiteMissingObservation {
  kind: "prerequisite_missing";
  nodeKey: string;
  /** Dependencies outside the subset that are neither stage-managed nor completed. */
  missing: string[];
}

export interface UnroutableObservation {
  kind: "unroutable";
  nodeKey: string;
  capability: string;
  /** Why no agent serves it (`unroutedReason`). */
  reason: string;
}

export interface RuntimeUnavailableObservation {
  kind: "runtime_unavailable";
  nodeKey: string;
  runtime: "native-provider";
  /** The gate's reason, when it gave one. */
  reason?: string;
}

export type RetryObservation =
  | FailedObservation
  | StalledObservation
  | PrerequisiteMissingObservation
  | UnroutableObservation
  | RuntimeUnavailableObservation;

export type RetryDecision =
  /** Re-queue the same node; the caller waits `afterMs` (when > 0) first. */
  | { kind: "retry"; afterMs: number }
  /** Settle the node failed. `error` replaces the outcome's error when set. `exhausted`: the retries ran out. */
  | { kind: "block"; reason: "permanent" | "halted" | "budget" | "exhausted" | "prerequisite" | "unroutable"; error?: string; exhausted?: boolean }
  /** Stall retries are spent or vetoed: fail the node with this escalation error. */
  | { kind: "escalate"; error: string }
  /** Run the node on another runtime (silently, as before), logging `reason`. */
  | { kind: "fallback"; runtime: "api"; reason: string }
  /** Nothing blocks the node: run it. */
  | { kind: "execute" }
  /** The decision needs this lazy fact: read it and decide again. */
  | { kind: "check"; fact: keyof LazyFacts };

/** The one retry decision for an observation. */
export function decideRetry(observation: RetryObservation): RetryDecision {
  switch (observation.kind) {
    case "failed": {
      // Permanent failures (invalid plan, forbidden path, no agent for the
      // capability, unparseable final JSON, permanent LLM 4xx, escalation)
      // settle as failed: replaying the same subtask cannot change them.
      if (!isRetryableClass(observation.errorClass)) return { kind: "block", reason: "permanent" };
      // A halt latched by this very outcome means the retry would never
      // start; the node keeps its own error (e2e ULTRA).
      if (observation.halted === undefined) return { kind: "check", fact: "halted" };
      if (observation.halted) return { kind: "block", reason: "halted" };
      if (observation.attempt <= observation.maxAttempts && !observation.cancelled) {
        // Even a classifiable retry is vetoed when the task can no longer pay for it.
        if (observation.budgetLeft === undefined) return { kind: "check", fact: "budgetLeft" };
        if (!observation.budgetLeft) return { kind: "block", reason: "budget" };
        return { kind: "retry", afterMs: observation.retryDelayMs * observation.attempt };
      }
      return { kind: "block", reason: "exhausted", exhausted: true };
    }
    case "stalled": {
      // Retried `maxAttempts` times regardless of the generic retry budget,
      // then escalated — never a generic timeout.
      const escalate: RetryDecision = {
        kind: "escalate",
        error: `Escalated (agent_stalled): ${observation.error} on ${observation.attempt} attempt(s); not retried again`,
      };
      if (observation.attempt > observation.maxAttempts || observation.cancelled) return escalate;
      if (observation.halted === undefined) return { kind: "check", fact: "halted" };
      if (observation.halted) return escalate;
      if (observation.budgetLeft === undefined) return { kind: "check", fact: "budgetLeft" };
      return observation.budgetLeft ? { kind: "retry", afterMs: 0 } : escalate;
    }
    case "prerequisite_missing":
      // Fail the subset closed instead of running on incomplete work.
      return observation.missing.length > 0
        ? { kind: "block", reason: "prerequisite", error: `Prerequisite for "${observation.nodeKey}" has not completed` }
        : { kind: "execute" };
    case "unroutable":
      // Plan 040 (D8): no fallback owner; BLOCKED with the reason.
      return { kind: "block", reason: "unroutable", error: `Blocked: ${observation.reason}` };
    case "runtime_unavailable":
      // Never run OpenCode in the user's real checkout (or without a CLI):
      // the node runs on the built-in API runtime instead.
      return { kind: "fallback", runtime: "api", reason: observation.reason ?? "OpenCode is unavailable" };
  }
}

/** Classes the scheduler may retry (the historical retry-while-attempts-remain set). */
export function isRetryableClass(errorClass: FailureClass): boolean {
  return errorClass === "transient" || errorClass === "unknown";
}

// ---------------------------------------------------------------------------
// The failure classification, moved from scheduler/dagScheduler.ts (which
// re-exports `isPermanentSubtaskError` and `shouldRetrySubtask`).
// ---------------------------------------------------------------------------

/** An executor escalation (plan 022): permanent, reported as its own class. */
const ESCALATED = /^Escalated \(/;

/**
 * Subtask failure patterns that can never succeed on a blind retry: the
 * inputs are deterministic (plan shape, path policy, capability routing,
 * the model's final unparseable answer), so replaying the same subtask
 * would fail identically while burning time and tokens. Patterns mirror
 * the actual error strings produced by planValidator, the governance path
 * guard, capability routing, and the executor's final-JSON parsing.
 */
const PERMANENT_SUBTASK_ERROR_PATTERNS: readonly RegExp[] = [
  // Forbidden / protected paths (governance validateFilePath, executor guards)
  /refusing to modify protected path/i,
  /outside declared ownership/i,
  /file[- ]path[- ]forbidden/i,
  /forbidden path/i,
  // No agent can serve the requested capability (routing is deterministic)
  /no enabled agent (can serve|for) capability/i,
  /no agent (available|found) for capability/i,
  // The model's final answer could not be parsed as the required JSON
  /did not return valid [^.]*json/i,
  /unparseable/i,
  /invalid json/i,
  /failed to parse [^.]*json/i,
  // A failed QA verdict on unchanged code: the QA loop owns the fix round;
  // a blind retry only re-ran the same browser check (two identical
  // "QA verdict: failed" messages on different ports).
  // Every deterministic QA check failure (structural/viewport checks,
  // console errors, overlay, empty body, 4xx) re-runs identically, so it
  // goes straight to qa.failed / the fix round. Environment-flaky signals
  // stay retryable: a QA harness exception ("qa-run: ..."), a 5xx while
  // the dev server is still compiling, navigation timeouts, net::ERR_*.
  /^QA failed: (?!qa-run:)(?![\s\S]*(?:Page returned HTTP 5\d\d|Timeout \d+ms exceeded|timed out|net::ERR_))/,
  // Plan 022: an executor escalation waits for a CTO / user decision;
  // replaying the same subtask would only escalate again.
  ESCALATED,
  /role is read-only/i,
  // Plan 040: a role permission refusal is final for that agent.
  /^Refused: the .* role /,
  // Plan validation failures (planValidator messages)
  /^plan\.(goal|subtasks) /i,
  /plan has \d+ subtasks; limit is/i,
  /duplicate subtask key/i,
  /depends on unknown subtask/i,
  /depends on itself/i,
  /dependency cycle detected/i,
  /subtask .*: (kind must be one of|capability is required)/i,
  /subtask\[\d+\] (must be an object|key is invalid)/i,
];

export function isPermanentSubtaskError(error: string): boolean {
  return PERMANENT_SUBTASK_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * The class of a failed subtask's error. Permanent patterns (an executor
 * escalation is reported as `escalation`) never retry; failures that came
 * out of the LLM layer keep the LLM transient/permanent classification
 * from effects/llmCall (429/5xx/network retry, other 4xx do not);
 * everything else is `unknown` and keeps the historical
 * retry-while-attempts-remain behaviour. `budget` is never produced from
 * the error text: the budget veto is the `budgetLeft` fact.
 */
export function classifyFailure(error: string): FailureClass {
  if (isPermanentSubtaskError(error)) return ESCALATED.test(error) ? "escalation" : "permanent";
  if (/LLM request failed/i.test(error)) {
    return isTransientLlmError(new Error(error)) ? "transient" : "permanent";
  }
  return "unknown";
}

/** Whether a failed subtask outcome is worth retrying (its class is retryable). */
export function shouldRetrySubtask(error: string): boolean {
  return isRetryableClass(classifyFailure(error));
}
