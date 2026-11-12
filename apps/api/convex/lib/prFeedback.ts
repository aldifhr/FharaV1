/**
 * Post-push feedback loop: pure helpers (no Convex functions here).
 *
 * After a task branch is pushed and its PR is open, GitHub tells us about
 * CI results, reviews, review comments and mergeability. This module turns
 * a verified webhook payload into a small typed signal, folds signals into
 * the PR facts stored on `taskPushes`, derives the board lane from those
 * facts (lanes are derived, never stored), decides which signals deserve a
 * fix task, and writes the fix prompt.
 *
 * Idea credit: the reaction loop, dedupe-by-signature and derived lanes
 * follow the design of agent-orchestrator (Apache-2.0). No code or text is
 * taken from it; this is an independent TypeScript implementation.
 */
import { cenvParse, cenvRaw } from "@fhara/config/convex";
import { fenceUntrusted, UNTRUSTED_NOTE, UNTRUSTED_REQUEST_NOTE } from "./untrustedContent";

export type CiState = "pending" | "passed" | "failed";
export type ReviewState = "none" | "approved" | "changes_requested" | "commented";
export type Mergeability = "unknown" | "mergeable" | "conflict";
export type PrState = "draft" | "open" | "merged" | "closed";
export type FixKind = "ci_failed" | "changes_requested" | "review_comments" | "merge_conflict";
export type PrLane = "in_review" | "changes_requested" | "ci_failed" | "ready_to_merge" | "merged";

export type CheckFact = {
  name: string;
  status: CiState;
  conclusion?: string;
  url?: string;
  checkRunId?: number;
};

export type ReviewComment = { id: number; path: string; line?: number; body: string; author?: string };

/** Bounds on everything copied out of a payload. */
export const TEXT_LIMIT = 2_000;
export const LOG_TAIL_CHARS = 6_000;
export const LOG_TAIL_LINES = 80;
const MAX_CHECKS = 30;
export const DEFAULT_FIX_MAX_ATTEMPTS = 3;

export type PrSignal =
  | {
      kind: "check_run";
      repoFullName: string;
      prNumbers: number[];
      headBranch?: string;
      headSha: string;
      check: CheckFact & { summary?: string; appSlug?: string };
    }
  | {
      kind: "review";
      repoFullName: string;
      prNumber: number;
      headSha?: string;
      review: { id: number; state: ReviewState | "dismissed"; body?: string; author?: string; url?: string };
    }
  | {
      kind: "review_comment";
      repoFullName: string;
      prNumber: number;
      reviewId?: number;
      comment: ReviewComment;
    }
  | { kind: "issue_comment"; repoFullName: string; prNumber: number; author?: string }
  | {
      kind: "pull_request";
      repoFullName: string;
      prNumber: number;
      action: string;
      state: PrState;
      headSha?: string;
      mergeable?: Mergeability;
    };

const str = (value: unknown, limit = TEXT_LIMIT): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A completed check's conclusion → our CI state. */
export function checkStatus(status: unknown, conclusion: unknown): CiState {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "passed";
  // failure, timed_out, cancelled, action_required, startup_failure, stale
  return "failed";
}

/** GitHub's mergeable / mergeable_state → our three states. */
export function mergeabilityOf(mergeable: unknown, mergeableState: unknown): Mergeability {
  if (mergeable === false || mergeableState === "dirty") return "conflict";
  if (mergeable === true) return "mergeable";
  return "unknown";
}

function prStateOf(pull: Record<string, any>): PrState {
  if (pull.merged || pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  if (pull.draft) return "draft";
  return "open";
}

/**
 * Verified webhook (event header + parsed body) → signal, or null when the
 * delivery says nothing about a PR we could own. Never throws.
 */
export function parsePrSignal(event: string, body: Record<string, any>): PrSignal | null {
  const repoFullName = str(body?.repository?.full_name, 200);
  if (!repoFullName) return null;
  try {
    switch (event) {
      case "check_run": {
        const run = body.check_run ?? {};
        if (body.action !== "completed" && body.action !== "created" && body.action !== "rerequested") return null;
        const headSha = str(run.head_sha, 64);
        const name = str(run.name, 200);
        if (!headSha || !name) return null;
        const prNumbers = Array.isArray(run.pull_requests)
          ? run.pull_requests.map((pr: any) => num(pr?.number)).filter((n: unknown): n is number => n !== undefined)
          : [];
        return {
          kind: "check_run",
          repoFullName,
          prNumbers,
          headBranch: str(run.check_suite?.head_branch, 250),
          headSha,
          check: {
            name,
            status: checkStatus(run.status, run.conclusion),
            conclusion: str(run.conclusion, 40),
            url: str(run.html_url ?? run.details_url, 500),
            checkRunId: num(run.id),
            summary: str([run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join("\n"), TEXT_LIMIT),
            appSlug: str(run.app?.slug, 100),
          },
        };
      }
      case "pull_request_review": {
        if (body.action !== "submitted" && body.action !== "dismissed") return null;
        const prNumber = num(body.pull_request?.number);
        const review = body.review ?? {};
        const id = num(review.id);
        if (prNumber === undefined || id === undefined) return null;
        const raw = String(review.state ?? "").toLowerCase();
        const state: ReviewState | "dismissed" =
          body.action === "dismissed" || raw === "dismissed"
            ? "dismissed"
            : raw === "approved"
              ? "approved"
              : raw === "changes_requested"
                ? "changes_requested"
                : "commented";
        return {
          kind: "review",
          repoFullName,
          prNumber,
          headSha: str(body.pull_request?.head?.sha, 64),
          review: { id, state, body: str(review.body), author: str(review.user?.login, 100), url: str(review.html_url, 500) },
        };
      }
      case "pull_request_review_comment": {
        if (body.action !== "created") return null;
        const prNumber = num(body.pull_request?.number);
        const comment = body.comment ?? {};
        const id = num(comment.id);
        const path = str(comment.path, 500);
        if (prNumber === undefined || id === undefined || !path) return null;
        return {
          kind: "review_comment",
          repoFullName,
          prNumber,
          reviewId: num(comment.pull_request_review_id),
          comment: {
            id,
            path,
            line: num(comment.line) ?? num(comment.original_line),
            body: str(comment.body) ?? "",
            author: str(comment.user?.login, 100),
          },
        };
      }
      case "issue_comment": {
        if (body.action !== "created" || !body.issue?.pull_request) return null;
        const prNumber = num(body.issue?.number);
        if (prNumber === undefined) return null;
        return { kind: "issue_comment", repoFullName, prNumber, author: str(body.comment?.user?.login, 100) };
      }
      case "pull_request": {
        const pull = body.pull_request ?? {};
        const prNumber = num(pull.number);
        if (prNumber === undefined) return null;
        return {
          kind: "pull_request",
          repoFullName,
          prNumber,
          action: str(body.action, 40) ?? "unknown",
          state: prStateOf(pull),
          headSha: str(pull.head?.sha, 64),
          mergeable: mergeabilityOf(pull.mergeable, pull.mergeable_state),
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** CI rollup: any failure wins, then anything pending; none = no CI. */
export function ciRollup(checks: CheckFact[]): CiState | undefined {
  if (checks.length === 0) return undefined;
  if (checks.some((c) => c.status === "failed")) return "failed";
  if (checks.some((c) => c.status === "pending")) return "pending";
  return "passed";
}

/**
 * Fold one check into the head commit's check list. A new head sha starts
 * a fresh list (old results describe a commit that is no longer the PR).
 */
export function foldCheck(
  prev: { headSha?: string; ciChecks?: CheckFact[] },
  headSha: string,
  check: CheckFact
): { headSha: string; ciChecks: CheckFact[]; ciState: CiState | undefined } {
  // Commits cannot be ordered here: the newest delivery wins, which is the
  // usual case (a push, then its checks).
  const base = prev.headSha === headSha ? (prev.ciChecks ?? []) : [];
  const next = base.filter((c) => c.name !== check.name);
  next.push({
    name: check.name,
    status: check.status,
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
    ...(check.url ? { url: check.url } : {}),
    ...(check.checkRunId !== undefined ? { checkRunId: check.checkRunId } : {}),
  });
  const ciChecks = next.slice(-MAX_CHECKS);
  return { headSha, ciChecks, ciState: ciRollup(ciChecks) };
}

/** Latest review decision. A plain comment never clears approve/changes. */
export function foldReview(prev: ReviewState | undefined, state: ReviewState | "dismissed"): ReviewState {
  if (state === "dismissed") return "none";
  if (state === "commented") return prev && prev !== "none" ? prev : "commented";
  return state;
}

export type PrFacts = {
  prState?: PrState;
  ciState?: CiState;
  reviewState?: ReviewState;
  mergeable?: Mergeability;
};

/**
 * Board lane for a pushed task, from its PR facts. Null = no PR, or a PR
 * that was closed without merging (the task goes back to its normal lane).
 * A merge conflict shows in "Changes requested": the branch must change
 * before it can merge, which is what that lane means.
 */
export function derivePrLane(facts: PrFacts): PrLane | null {
  if (!facts.prState) return null;
  if (facts.prState === "merged") return "merged";
  if (facts.prState === "closed") return null;
  if (facts.ciState === "failed") return "ci_failed";
  if (facts.reviewState === "changes_requested" || facts.mergeable === "conflict") return "changes_requested";
  const ciOk = facts.ciState === "passed" || facts.ciState === undefined;
  if (ciOk && facts.mergeable === "mergeable" && (facts.ciState === "passed" || facts.reviewState === "approved")) {
    return "ready_to_merge";
  }
  return "in_review";
}

export const PR_LANES: ReadonlyArray<{ key: PrLane; label: string }> = [
  { key: "in_review", label: "In review" },
  { key: "changes_requested", label: "Changes requested" },
  { key: "ci_failed", label: "CI failed" },
  { key: "ready_to_merge", label: "Ready to merge" },
  { key: "merged", label: "Merged" },
];

export type ReactionPlan = { kind: FixKind; signature: string; headSha?: string; context: Record<string, unknown> };

/**
 * Which fix a signal asks for. The signature is the dedupe key: one CI fix
 * per head commit, one fix per review (its comments share the review id),
 * one conflict fix per head commit (a new commit re-arms it).
 */
export function planReaction(signal: PrSignal, facts: { headSha?: string; mergeable?: Mergeability }): ReactionPlan | null {
  switch (signal.kind) {
    case "check_run":
      if (signal.check.status !== "failed") return null;
      return {
        kind: "ci_failed",
        signature: `ci:${signal.headSha}`,
        headSha: signal.headSha,
        context: {
          checks: [
            {
              name: signal.check.name,
              conclusion: signal.check.conclusion,
              url: signal.check.url,
              checkRunId: signal.check.checkRunId,
              summary: signal.check.summary,
              appSlug: signal.check.appSlug,
            },
          ],
        },
      };
    case "review":
      if (signal.review.state !== "changes_requested") return null;
      return {
        kind: "changes_requested",
        signature: `review:${signal.review.id}`,
        headSha: signal.headSha,
        context: { reviewId: signal.review.id, body: signal.review.body, author: signal.review.author, url: signal.review.url },
      };
    case "review_comment":
      return {
        kind: "review_comments",
        signature: signal.reviewId !== undefined ? `review:${signal.reviewId}` : `comment:${signal.comment.id}`,
        context: { reviewId: signal.reviewId, comments: [signal.comment] },
      };
    case "pull_request": {
      if (signal.state !== "open" && signal.state !== "draft") return null;
      if (signal.mergeable !== "conflict") return null;
      const sha = signal.headSha ?? facts.headSha;
      return { kind: "merge_conflict", signature: `conflict:${sha ?? "unknown"}`, headSha: sha, context: {} };
    }
    default:
      return null;
  }
}

/** FHARA_PR_FIX_MAX_ATTEMPTS, default 3, clamped to 0..20. */
export function fixMaxAttempts(raw: string | undefined = cenvRaw("FHARA_PR_FIX_MAX_ATTEMPTS")): number {
  return cenvParse("FHARA_PR_FIX_MAX_ATTEMPTS", raw);
}

/** Last lines of a CI log, bounded by lines and characters. */
export function logTail(text: string, lines = LOG_TAIL_LINES, chars = LOG_TAIL_CHARS): string {
  // Strip GitHub Actions timestamps ("2026-11-09T10:00:00.1234567Z ").
  const rows = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, ""));
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  let tail = rows.slice(-lines).join("\n");
  if (tail.length > chars) tail = tail.slice(tail.length - chars);
  return tail;
}

/** A fence longer than any backtick run inside the text. */
export function fenced(text: string, lang = "text"): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

export type FixDetails = {
  checks?: Array<{ name: string; conclusion?: string; url?: string; logTail?: string; summary?: string }>;
  review?: { author?: string; body?: string; url?: string };
  comments?: ReviewComment[];
  baseBranch?: string;
};

const KIND_TITLE: Record<FixKind, string> = {
  ci_failed: "Fix CI",
  changes_requested: "Address review",
  review_comments: "Address review comments",
  merge_conflict: "Resolve merge conflict",
};

export function fixTaskTitle(kind: FixKind, prNumber: number, ownerTitle: string): string {
  return `${KIND_TITLE[kind]} on PR #${prNumber}: ${ownerTitle}`.slice(0, 200);
}

/** The fix task's command (what the planner and implementer read). */
export function buildFixPrompt(input: {
  kind: FixKind;
  repoFullName: string;
  prNumber: number;
  branchName: string;
  headSha?: string;
  ownerTitle: string;
  attempt: number;
  maxAttempts: number;
  details: FixDetails;
}): string {
  const out: string[] = [];
  const sha = input.headSha ? ` (commit ${input.headSha.slice(0, 12)})` : "";
  out.push(`${KIND_TITLE[input.kind]} for pull request #${input.prNumber} in ${input.repoFullName}${sha}.`);
  out.push(`The PR belongs to the earlier task "${input.ownerTitle}". Its branch is ${input.branchName}, and this task works in that same worktree.`);
  out.push(`This is fix attempt ${input.attempt} of ${input.maxAttempts} for this PR.`, "");

  if (input.kind === "ci_failed") {
    const checks = input.details.checks ?? [];
    out.push("Failing checks:");
    if (checks.length === 0) out.push("- (the check list could not be read; run the project's tests and build to find the failure)");
    checks.forEach((check, index) => {
      out.push(`${index + 1}. ${check.name}${check.conclusion ? ` (${check.conclusion})` : ""}${check.url ? ` ${check.url}` : ""}`);
      if (check.logTail) out.push("   Log tail:", fenceUntrusted("ci-log", fenced(check.logTail), ""));
      else if (check.summary) out.push("   Check output:", fenceUntrusted("ci-log", fenced(check.summary), ""));
      else out.push("   No log was available. Reproduce it locally.");
    });
    if (checks.some((check) => check.logTail || check.summary)) out.push(UNTRUSTED_NOTE);
  } else if (input.kind === "changes_requested" || input.kind === "review_comments") {
    const review = input.details.review;
    if (review?.body) {
      out.push(`Review${review.author ? ` by ${review.author}` : ""}${review.url ? ` (${review.url})` : ""}:`, fenceUntrusted("pr-review", fenced(review.body, "markdown"), ""));
    }
    const comments = input.details.comments ?? [];
    if (comments.length > 0) {
      out.push("Review comments, each tied to a file and line:");
      comments.forEach((comment, index) => {
        const where = `${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}`;
        out.push(`${index + 1}. ${where}${comment.author ? ` (${comment.author})` : ""}`, fenceUntrusted("pr-review-comment", fenced(comment.body, "markdown"), ""));
      });
    }
    // N6: review text is third-party (any reviewer), fenced and read as the request only.
    if (review?.body || comments.length > 0) out.push(UNTRUSTED_REQUEST_NOTE);
    if (!review?.body && comments.length === 0) out.push("The reviewer asked for changes without details. Read the PR conversation before editing.");
  } else {
    out.push(
      `The branch no longer merges cleanly into ${input.details.baseBranch ?? "the base branch"}.`,
      "Bring the base branch into this branch, resolve every conflict keeping both sides' intent, and make sure the project still builds and its tests pass."
    );
  }

  out.push(
    "",
    "Rules for this fix:",
    "- Stay on the existing branch and worktree. Do not create a branch or open another PR.",
    "- Make the smallest change that resolves the items above, and leave unrelated code alone.",
    "- Do not push. The user approves the push of the fix commit, which updates the same PR."
  );
  return out.join("\n");
}

/** Statuses after which a task will not run again on its own. */
export const TERMINAL_TASK = new Set(["done", "failed", "rejected", "cancelled"]);

export type NotificationKind =
  | "ready_to_merge"
  | "ci_failed"
  | "changes_requested"
  | "merge_conflict"
  | "fix_cap_reached"
  | "fix_failed"
  | "auto_merge_blocked";

/**
 * O2: auto-merge codes the other notifications already cover (a fix may
 * be on its way, or "CI failed" / "Changes requested" say it).
 */
const AUTO_MERGE_COVERED = new Set(["checks_failed", "changes_requested", "dirty", "merged", "closed"]);

export type DesiredNotification = { kind: NotificationKind; title: string };

/**
 * The "needs you" notifications a PR should have right now. Recomputed on
 * every PR fact or task state change; anything not in the list resolves.
 * CI / review / conflict ask for the user only when Fhara will not fix
 * them itself (reactions off, the cap reached, or the worktree gone).
 */
export function desiredNotifications(input: {
  prNumber: number;
  facts: PrFacts;
  reactionsEnabled: boolean;
  capReached: boolean;
  worktreeAvailable: boolean;
  fixActive: boolean;
  latestFixFailed: boolean;
  /** O2: the project's auto-merge switch and the PR's newest auto-merge state. */
  autoMerge?: { enabled: boolean; state?: string; code?: string; reason?: string };
}): DesiredNotification[] {
  const { facts, prNumber } = input;
  if (facts.prState !== "open" && facts.prState !== "draft") return [];
  const pr = `PR #${prNumber}`;
  const out: DesiredNotification[] = [];
  const auto = input.autoMerge?.enabled ? input.autoMerge : null;
  const autoBlocked =
    auto !== null && (auto.state === "blocked" || auto.state === "failed") && !AUTO_MERGE_COVERED.has(auto.code ?? "");
  // With auto-merge on, a green PR is Fhara's to merge: no "ready" ping,
  // unless a gate stopped it (then the gate's reason is the notification).
  if (autoBlocked) out.push({ kind: "auto_merge_blocked", title: `${pr} needs your merge: ${auto!.reason ?? "auto-merge stopped"}`.slice(0, 200) });
  else if (!auto && derivePrLane(facts) === "ready_to_merge") out.push({ kind: "ready_to_merge", title: `${pr} is ready to merge` });
  const fhara = input.reactionsEnabled && !input.capReached && input.worktreeAvailable;
  const ciFailed = facts.ciState === "failed";
  const changes = facts.reviewState === "changes_requested";
  const conflict = facts.mergeable === "conflict";
  if (!fhara && !input.fixActive) {
    if (ciFailed) out.push({ kind: "ci_failed", title: `CI failed on ${pr}` });
    if (changes) out.push({ kind: "changes_requested", title: `Changes requested on ${pr}` });
    if (conflict) out.push({ kind: "merge_conflict", title: `${pr} has a merge conflict` });
  }
  if (input.reactionsEnabled && input.capReached && !input.fixActive && (ciFailed || changes || conflict)) {
    out.push({ kind: "fix_cap_reached", title: `${pr}: Fhara used all its fix attempts` });
  }
  if (input.latestFixFailed && !input.fixActive) out.push({ kind: "fix_failed", title: `The last fix for ${pr} failed` });
  return out;
}

// ---------------------------------------------------------------------------
// Review rounds (Paradev A3): the user's line comments on a task's changes,
// sent back as one fix task.
// ---------------------------------------------------------------------------

export type LineCommentSide = "additions" | "deletions" | "mixed";

export type LineComment = {
  path: string;
  startLine: number;
  endLine: number;
  /** Which side of the diff the range covers; unset renders no side note. */
  side?: LineCommentSide;
  body: string;
};

// Portions adapted from Paradev, formerly Superset (https://github.com/paradevai/paradev, cloned from github.com/superset-sh/superset @ ce98da26),
// apps/desktop/src/renderer/hooks/host-service/useSendToTerminalAgent/useSendToTerminalAgent.ts (formatAgentPromptWithFileContext).
// MIT License, Copyright (c) 2025-2026 Superset Inc.
// See THIRD_PARTY_NOTICES.md.
// Changed by Fhara: takes one flat comment object and trims the body.
/** One comment as the agent reads it: `In a.ts:L3-L5 (deleted lines): <comment>`. */
export function formatLineComment(comment: LineComment): string {
  const range = comment.startLine === comment.endLine ? `L${comment.startLine}` : `L${comment.startLine}-L${comment.endLine}`;
  const sideSuffix =
    comment.side === "deletions" ? " (deleted lines)" : comment.side === "mixed" ? " (across deletions and additions)" : "";
  return `In ${comment.path}:${range}${sideSuffix}: ${comment.body.trim()}`;
}

/** File order, then line order: the order a reader walks the diff. */
export function sortLineComments<T extends LineComment>(comments: T[]): T[] {
  return [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine);
}

export function reviewFixTitle(round: number, ownerTitle: string): string {
  return `Review round ${round}: ${ownerTitle}`.slice(0, 200);
}

/**
 * The review round as one prompt: the comments, plus the branch and the
 * rules a fix task works by when the owner is known.
 */
export function buildReviewRoundPrompt(input: {
  round: number;
  comments: LineComment[];
  ownerTitle?: string;
  branchName?: string;
}): string {
  const out: string[] = [];
  const count = input.comments.length;
  out.push(`Review round ${input.round}: ${count} comment${count === 1 ? "" : "s"} on your changes. Address each one.`);
  if (input.ownerTitle && input.branchName) {
    out.push(`The changes belong to the earlier task "${input.ownerTitle}". Its branch is ${input.branchName}, and this task works in that same worktree.`);
  }
  out.push("");
  // N6: the comment text is fenced, so it states what to change but cannot pose as rules.
  const list = sortLineComments(input.comments).map((comment, index) => `${index + 1}. ${formatLineComment(comment)}`);
  out.push(fenceUntrusted("review-round", list.join("\n"), UNTRUSTED_REQUEST_NOTE));
  if (input.branchName) {
    out.push(
      "",
      "Rules for this round:",
      "- Stay on the existing branch and worktree. Do not create a branch or open a PR.",
      "- Change only what the comments ask for, and leave unrelated code alone.",
      "- Do not push. The user approves the push of the commit."
    );
  }
  return out.join("\n");
}
