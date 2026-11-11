/**
 * O3 + L7: provider holds.
 *
 * A task whose run fails because the LLM provider is offline, out of quota,
 * rate-limited (429) or refusing its credentials is not failed: it is put
 * on hold (status "paused", pausedBy "held", with a reason) and resumes on
 * its own with exponential backoff, or when the user presses Resume. The
 * watchdog and stale-lease recovery only look at `running` tasks, so a held
 * task is never killed while it waits.
 *
 * Pure: shared by the backend (completeTask) and the worker (its failure
 * path logs a hold instead of a failure). Written for Fhara.
 *
 * Lane git-init adds kind "repo": the project folder is not a git
 * repository or has no commits. It never resumes on its own; the user's
 * "Initialize git" (or Resume after fixing it) continues the task.
 */

import { classifyRepoHold } from "./repoReadiness";

export type ProviderHoldKind = "offline" | "rate_limit" | "quota" | "auth" | "repo";

export interface ProviderHold {
  kind: ProviderHoldKind;
  /** One line the task card shows ("The LLM provider is rate-limiting requests (429)"). */
  reason: string;
}

/** First retry after this long; doubles per consecutive hold. */
export const HOLD_BASE_DELAY_MS = 60_000;
/** Backoff cap (~30 min). */
export const HOLD_MAX_DELAY_MS = 30 * 60_000;

/** Delay before the `attempt`-th automatic resume (1-based): 1, 2, 4, 8, 16, 30, 30 … min. */
export function holdBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(attempt) ? attempt : 1));
  const delay = HOLD_BASE_DELAY_MS * 2 ** Math.min(n - 1, 20);
  return Math.min(HOLD_MAX_DELAY_MS, delay);
}

// An LLM call's own error text (llm.ts: "LLM request failed (429) for model …").
const LLM_HTTP = /\bLLM request failed \((\d{3})\)/i;
// Resolver: every candidate connection is excluded by the circuit breaker.
const LLM_ALL_EXCLUDED = /No LLM provider available[^.]*every candidate connection is temporarily excluded/i;
// Words that tie a generic error to the model provider.
const LLM_CONTEXT = /\b(?:LLM|model|provider|chat\/completions|opencode|openai|anthropic|openrouter|ollama|gemini)\b/i;
const QUOTA = /\b(?:insufficient_quota|exceeded your current quota|quota exceeded|out of credits|credit balance is too low|billing hard limit|payment required)\b/i;
const RATE_LIMIT = /\b(?:rate[ _-]?limit(?:ed)?|too many requests|rate_limit_exceeded)\b/i;
const AUTH = /\b(?:invalid[ _-]api[ _-]key|incorrect api key|unauthori[sz]ed|authentication (?:failed|error)|invalid_api_key|permission denied for model|api key (?:is )?(?:missing|invalid|expired))\b/i;
const OFFLINE = /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|service unavailable|bad gateway|gateway timeout|overloaded)\b/i;

function fromStatus(code: number, message: string): ProviderHold | null {
  if (code === 429) {
    return QUOTA.test(message)
      ? { kind: "quota", reason: "The LLM provider's quota is used up (429)" }
      : { kind: "rate_limit", reason: "The LLM provider is rate-limiting requests (429)" };
  }
  if (code === 402) return { kind: "quota", reason: "The LLM provider's quota or credit is used up (402)" };
  if (code === 401 || code === 403) return { kind: "auth", reason: `The LLM provider refused the credentials (${code})` };
  if (code === 502 || code === 503 || code === 504 || code === 529) return { kind: "offline", reason: `The LLM provider is unavailable (${code})` };
  return null;
}

/**
 * The hold a task failure message calls for, or null when it is an ordinary
 * failure. Only provider failures qualify: a generic network or auth error
 * must name the model provider, so a failing test run or a GitHub 401 still
 * fails the task.
 */
export function classifyProviderHold(message: string | undefined | null): ProviderHold | null {
  if (!message) return null;
  const text = String(message).slice(0, 4000);
  const http = LLM_HTTP.exec(text);
  if (http) {
    const hold = fromStatus(Number(http[1]), text);
    if (hold) return hold;
  }
  if (LLM_ALL_EXCLUDED.test(text)) return { kind: "offline", reason: "Every LLM provider connection is failing right now" };
  if (!LLM_CONTEXT.test(text)) return null;
  if (QUOTA.test(text)) return { kind: "quota", reason: "The LLM provider's quota is used up" };
  if (RATE_LIMIT.test(text)) return { kind: "rate_limit", reason: "The LLM provider is rate-limiting requests" };
  if (AUTH.test(text)) return { kind: "auth", reason: "The LLM provider refused the credentials" };
  if (OFFLINE.test(text)) return { kind: "offline", reason: "The LLM provider cannot be reached" };
  return null;
}

/** completeTask's hold for a failure: a repo-readiness hold first, else a provider hold, else null. */
export function classifyTaskHold(message: string | undefined | null): ProviderHold | null {
  return classifyRepoHold(message) ?? classifyProviderHold(message);
}

/** Hold state stored on the task (tasks.hold). */
export interface TaskHoldState {
  kind: ProviderHoldKind;
  reason: string;
  /** The provider error, capped. */
  detail?: string;
  /** Consecutive holds without a successful run in between (drives the backoff). */
  attempts: number;
  heldAt: number;
  /** When the automatic resume fires. */
  resumeAt: number;
}

/** The next hold state for a task held again (attempts carry over until the task settles). */
export function nextHoldState(previous: Pick<TaskHoldState, "attempts"> | undefined, hold: ProviderHold, now: number, detail?: string): TaskHoldState {
  const attempts = (previous?.attempts ?? 0) + 1;
  return {
    kind: hold.kind,
    reason: hold.reason,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
    attempts,
    heldAt: now,
    resumeAt: now + holdBackoffMs(attempts),
  };
}

/** Whether the watchdog may fail this task as stuck: only running tasks that are not on a provider hold. */
export function watchdogMayFail(task: { status: string; pausedBy?: string; hold?: unknown }): boolean {
  return task.status === "running" && task.pausedBy !== "held";
}

/** The task card's line for a held task: "On hold: <reason>. Retrying automatically in 4 min." */
export function holdNoticeText(hold: Pick<TaskHoldState, "reason" | "resumeAt" | "kind">, now: number): string {
  if (hold.kind === "repo") return hold.reason;
  const ms = hold.resumeAt - now;
  const when =
    ms <= 30_000 ? "Retrying automatically now." : `Retrying automatically in ${ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`}.`;
  const fix = hold.kind === "auth" ? " Check the provider key in Settings, then resume." : "";
  return `On hold: ${hold.reason}. ${when}${fix}`;
}
