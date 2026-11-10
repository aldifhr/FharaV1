/**
 * Supervised auto-merge (O2): pure rules, no Convex functions here.
 *
 * Adapted from aliengiraffe/vigilante@a4f7826 internal/app/app.go:5211-5249
 * (`automergeWaitReason`: one plain sentence per reason a PR cannot merge
 * yet) and zvenoai/coder@1e1cc92 orchestrator/pr_monitor.py:860-902
 * (`_check_human_gate`: diff size and sensitive-path gate). Both Apache-2.0
 * (no named copyright holder). Changed by Fhara: ported to TypeScript; the
 * gate fails CLOSED (coder skips it when the file list cannot be read), a
 * check that errored blocks instead of being skipped, a PR with no checks
 * waits, the head must equal the commit the user approved for push, and the
 * result is a typed verdict (wait = Fhara retries on its own, blocked = it
 * needs the user) instead of a log string.
 */

export type MergeMethod = "squash" | "merge" | "rebase";

export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];
export const DEFAULT_MAX_DIFF_LINES = 400;
export const DEFAULT_SENSITIVE_GLOBS = [
  ".github/**",
  "**/.env*",
  "**/*.env",
  "**/*.pem",
  "**/*.key",
  "infra/**",
  "apps/api/convex/schema.ts",
] as const;
/** GitHub's pull files endpoint lists at most 3000 files. */
export const MAX_PR_FILES = 3000;

export interface AutoMergePolicy {
  maxDiffLines: number;
  sensitiveGlobs: string[];
  method: MergeMethod;
}

/** Knob values (Settings → Diffs & PR) → policy. Unset or invalid = defaults. */
export function autoMergePolicy(raw: { maxDiffLines?: string; sensitive?: string; method?: string }): AutoMergePolicy {
  const n = raw.maxDiffLines === undefined || raw.maxDiffLines.trim() === "" ? NaN : Number(raw.maxDiffLines);
  const maxDiffLines = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_MAX_DIFF_LINES;
  const sensitiveGlobs =
    raw.sensitive === undefined
      ? [...DEFAULT_SENSITIVE_GLOBS]
      : raw.sensitive
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 50);
  const method = (MERGE_METHODS as readonly string[]).includes(raw.method ?? "") ? (raw.method as MergeMethod) : "squash";
  return { maxDiffLines, sensitiveGlobs, method };
}

// ── Glob matching ───────────────────────────────────────────────────────

/** `**` any depth (including none), `*` within one segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path.replace(/^\.?\/+/, ""));
}

// ── Human gate (size + sensitive paths) ─────────────────────────────────

export type PrFile = { filename: string; additions: number; deletions: number; previousFilename?: string };

export type GateResult = { ok: true; lines: number; files: number } | { ok: false; code: "gate_size" | "gate_path" | "gate_unverified"; reason: string };

/**
 * Block when the diff is bigger than the limit or touches a sensitive path.
 * `files` is null when the list could not be read: that blocks (fail
 * closed). A list at GitHub's 3000-file cap may be truncated: also blocked.
 */
export function humanGate(files: PrFile[] | null, policy: Pick<AutoMergePolicy, "maxDiffLines" | "sensitiveGlobs">): GateResult {
  if (files === null) return { ok: false, code: "gate_unverified", reason: "Could not verify the diff (the file list did not load)" };
  if (files.length >= MAX_PR_FILES) return { ok: false, code: "gate_unverified", reason: `Could not verify the diff (${files.length}+ files)` };
  const lines = files.reduce((sum, f) => sum + Math.max(0, f.additions) + Math.max(0, f.deletions), 0);
  if (policy.maxDiffLines > 0 && lines > policy.maxDiffLines) {
    return { ok: false, code: "gate_size", reason: `Diff size ${lines} lines exceeds ${policy.maxDiffLines}` };
  }
  for (const file of files) {
    for (const path of [file.filename, file.previousFilename].filter((p): p is string => Boolean(p))) {
      const hit = policy.sensitiveGlobs.find((glob) => matchGlob(path, glob));
      if (hit) return { ok: false, code: "gate_path", reason: `Sensitive path matched: ${path} (${hit})` };
    }
  }
  return { ok: true, lines, files: files.length };
}

// ── Wait reasons ────────────────────────────────────────────────────────

export type CheckLike = { name: string; status: "pending" | "passed" | "failed"; conclusion?: string };

export interface MergeFacts {
  prNumber: number;
  state: "draft" | "open" | "merged" | "closed";
  /** The PR head on GitHub right now. */
  headSha?: string;
  /** The commit the user approved for push (newest pushed row). */
  approvedSha?: string;
  reviewState?: "none" | "approved" | "changes_requested" | "commented";
  /** Checks on the head commit; null = they could not be read. */
  checks: CheckLike[] | null;
  /** GitHub REST `mergeable_state` (clean, blocked, behind, dirty, draft, has_hooks, unknown, unstable). */
  mergeableState?: string;
  mergeable?: "unknown" | "mergeable" | "conflict";
  /** A fix task is running, or its commit still waits for push. */
  fixInFlight?: boolean;
  /** A PR reaction (CI / review fix) is queued but not handed out. */
  reactionPending?: boolean;
  /** O8 dependency check: failed = a high finding. */
  dependencyCheck?: "passed" | "failed" | "skipped";
}

export type MergeVerdict =
  | { kind: "ready" }
  | { kind: "wait"; code: string; reason: string }
  | { kind: "blocked"; code: string; reason: string };

const wait = (code: string, reason: string): MergeVerdict => ({ kind: "wait", code, reason });
const blocked = (code: string, reason: string): MergeVerdict => ({ kind: "blocked", code, reason });

/**
 * Why this PR cannot merge yet, in order. "wait" clears on its own (checks
 * running, GitHub still computing); "blocked" needs the user (a failed or
 * errored check, changes requested, a conflict, a foreign commit).
 */
export function mergeVerdict(f: MergeFacts): MergeVerdict {
  const pr = `PR #${f.prNumber}`;
  if (f.state === "merged") return blocked("merged", `${pr} is already merged`);
  if (f.state === "closed") return blocked("closed", `${pr} is closed`);
  if (f.state === "draft" || f.mergeableState === "draft") {
    return blocked("draft", `${pr} is a draft. Mark it ready for review, or turn off draft pull requests`);
  }
  if (!f.headSha || !f.approvedSha) return wait("head_unknown", `Waiting for ${pr}'s head commit`);
  if (f.headSha !== f.approvedSha) {
    return blocked("head_mismatch", `${pr} has commits you did not approve (head ${f.headSha.slice(0, 7)}, approved ${f.approvedSha.slice(0, 7)})`);
  }
  if (f.fixInFlight) return wait("fix_in_flight", `A fix for ${pr} is still in progress`);
  if (f.reactionPending) return wait("reaction_pending", `A fix for new feedback on ${pr} is queued`);
  if (f.reviewState === "changes_requested") return blocked("changes_requested", `Changes were requested on ${pr}`);
  if (f.checks === null) return blocked("checks_unverified", `Could not read the checks on ${pr}`);
  if (f.checks.length === 0) return wait("checks_none", `No checks have reported on ${pr} yet`);
  const failed = f.checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    const names = failed.slice(0, 3).map((c) => `${c.name}${c.conclusion ? ` (${c.conclusion})` : ""}`);
    return blocked("checks_failed", `Check ${names.join(", ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""} did not pass`);
  }
  const pending = f.checks.filter((c) => c.status === "pending");
  if (pending.length > 0) return wait("checks_pending", `Waiting for ${pending.length} check${pending.length === 1 ? "" : "s"} on ${pr}`);
  if (f.dependencyCheck === "failed") return blocked("dependency_check", `The dependency check found a high-risk change on ${pr}`);
  if (f.mergeable === "conflict") return blocked("dirty", `${pr} has merge conflicts`);
  switch ((f.mergeableState ?? "unknown").toLowerCase()) {
    case "clean":
      return { kind: "ready" };
    case "dirty":
      return blocked("dirty", `${pr} has merge conflicts`);
    case "behind":
      return blocked("behind", `${pr}'s branch is behind the base branch`);
    case "blocked":
      return blocked("gh_blocked", `GitHub blocks merging ${pr} (required reviews or branch protection)`);
    case "has_hooks":
      return wait("has_hooks", `Waiting for GitHub's pre-merge hooks on ${pr}`);
    case "unstable":
      return blocked("unstable", `A non-required check on ${pr} is failing`);
    default:
      return wait("mergeability_unknown", `Waiting for GitHub to compute whether ${pr} can merge`);
  }
}

/**
 * Cheap pre-check from the stored facts (no GitHub call): worth spending
 * an attempt only when nothing stored already says "not yet".
 */
export function storedFactsReady(f: {
  prState?: string;
  ciState?: string;
  reviewState?: string;
  mergeable?: string;
  headSha?: string;
  approvedSha?: string;
}): boolean {
  return (
    f.prState === "open" &&
    f.ciState === "passed" &&
    f.reviewState !== "changes_requested" &&
    f.mergeable !== "conflict" &&
    Boolean(f.headSha) &&
    f.headSha === f.approvedSha
  );
}

/** The chat / Inbox line for a merge Fhara made on its own. */
export function mergedLine(prNumber: number, gate: { lines: number; files: number }, checks: number): string {
  return `Merged PR #${prNumber} automatically: ${checks} check${checks === 1 ? "" : "s"} passed, ${gate.lines} line${gate.lines === 1 ? "" : "s"} in ${gate.files} file${gate.files === 1 ? "" : "s"}.`;
}
