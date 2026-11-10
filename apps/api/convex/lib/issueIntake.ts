/**
 * O4 issue → draft task intake: pure rules (no Convex functions here).
 *
 * The author filter (only issues the connected GitHub user opened) follows
 * VocanicZ/Harness@edcf03d scripts/issuelib.py:492-517 (MIT, © 2026
 * VocanicZ). The label lifecycle shown on the issue follows
 * aliengiraffe/vigilante@a4f7826 internal/app/app.go:78-90, and the
 * "already done?" evidence collection follows
 * zvenoai/coder@1e1cc92 orchestrator/preflight_checker.py:87-130 (collect
 * every source, no short-circuit; any evidence → hold for the user). Both
 * Apache-2.0, no named copyright holder. Changed by Fhara: TypeScript, the
 * sources are GitHub's issue timeline and comments plus Fhara's own earlier
 * tasks for the issue, and a found result never blocks: it only asks the
 * user to confirm Start.
 */

export const DEFAULT_INTAKE_LABEL = "fhara";
export const LABEL_PREFIX = "fhara:";
export type IssueStatusLabel = "fhara:draft" | "fhara:running" | "fhara:ready-for-review" | "fhara:failed" | "fhara:done";
export const STATUS_LABELS: readonly IssueStatusLabel[] = ["fhara:draft", "fhara:running", "fhara:ready-for-review", "fhara:failed", "fhara:done"];

const TITLE_LIMIT = 200;
const BODY_LIMIT = 3_000;

export type IssueSignal = {
  action: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  url?: string;
  /** The label this delivery added (action "labeled"). */
  addedLabel?: string;
};

const str = (value: unknown, limit: number): string => (typeof value === "string" ? value.slice(0, limit) : "");

/** A verified `issues` delivery → signal, or null (PRs, unknown shapes). Never throws. */
export function parseIssueSignal(event: string, body: Record<string, any>): IssueSignal | null {
  try {
    if (event !== "issues") return null;
    const issue = body?.issue;
    const repoFullName = str(body?.repository?.full_name, 200);
    if (!issue || !repoFullName || issue.pull_request) return null;
    const number = typeof issue.number === "number" ? issue.number : NaN;
    if (!Number.isInteger(number) || number <= 0) return null;
    const labels = Array.isArray(issue.labels)
      ? issue.labels.map((l: any) => (typeof l === "string" ? l : str(l?.name, 100))).filter(Boolean).slice(0, 50)
      : [];
    return {
      action: str(body.action, 40) || "unknown",
      repoFullName,
      number,
      title: str(issue.title, TITLE_LIMIT).trim(),
      body: str(issue.body, BODY_LIMIT),
      author: str(issue.user?.login, 100),
      labels,
      state: issue.state === "closed" ? "closed" : "open",
      url: str(issue.html_url, 500) || undefined,
      addedLabel: body.action === "labeled" ? str(body.label?.name, 100) || undefined : undefined,
    };
  } catch {
    return null;
  }
}

export type IntakeDecision = { ok: true } | { ok: false; reason: "action" | "label" | "author" | "no_login" | "closed" };

/**
 * Take the issue only when it was opened or labelled, carries the intake
 * label, is open, and was written by the connected GitHub login (case-
 * insensitive). Issue text is untrusted, so the author check is mandatory.
 */
export function intakeDecision(signal: IssueSignal, opts: { label: string; selfLogin?: string | null }): IntakeDecision {
  if (!["opened", "labeled", "reopened"].includes(signal.action)) return { ok: false, reason: "action" };
  const label = opts.label.toLowerCase();
  if (!signal.labels.some((l) => l.toLowerCase() === label)) return { ok: false, reason: "label" };
  if (signal.action === "labeled" && signal.addedLabel && signal.addedLabel.toLowerCase() !== label) return { ok: false, reason: "label" };
  if (signal.state !== "open") return { ok: false, reason: "closed" };
  if (!opts.selfLogin) return { ok: false, reason: "no_login" };
  if (signal.author.toLowerCase() !== opts.selfLogin.toLowerCase()) return { ok: false, reason: "author" };
  return { ok: true };
}

/** The intake label of a project (trimmed, lowercased; default `fhara`). */
export function intakeLabel(raw: string | undefined): string {
  const label = (raw ?? "").trim().toLowerCase();
  return label && label.length <= 50 && !label.startsWith(LABEL_PREFIX) ? label : DEFAULT_INTAKE_LABEL;
}

/** The draft task's command: the issue as the request, plus where it came from. */
export function draftCommand(issue: { repoFullName: string; number: number; title: string; body: string }): string {
  const body = issue.body.trim();
  const out = [issue.title.trim() || `Issue #${issue.number}`];
  if (body) out.push("", body);
  out.push("", `(From GitHub issue ${issue.repoFullName}#${issue.number}. The pull request should close it.)`);
  return out.join("\n").slice(0, 4000);
}

// ── Preflight: "already done?" ──────────────────────────────────────────

export type TimelineEvent = {
  event?: string;
  commit_id?: string | null;
  source?: { issue?: { number?: number; title?: string; pull_request?: { merged_at?: string | null } } };
};
export type IssueComment = { body?: string; user?: { login?: string } };

const DONE_PHRASES = /\b(already (done|fixed|implemented|merged|resolved)|this (is|was) (done|fixed|resolved)|fixed (in|by) (#\d+|[0-9a-f]{7,40}))\b/i;

/**
 * Collect every piece of evidence that the issue is already handled. Any
 * evidence → `looksDone` (Start then asks the user to confirm).
 */
export function preflightEvidence(input: {
  issueState: "open" | "closed";
  timeline: TimelineEvent[] | null;
  comments: IssueComment[] | null;
  earlierTasks: Array<{ title: string; status: string }>;
}): { looksDone: boolean; evidence: string[] } {
  const evidence: string[] = [];
  if (input.issueState === "closed") evidence.push("The issue is closed");
  for (const ev of input.timeline ?? []) {
    if (ev.event === "cross-referenced" && ev.source?.issue?.pull_request?.merged_at) {
      evidence.push(`Merged PR #${ev.source.issue.number}${ev.source.issue.title ? ` "${ev.source.issue.title.slice(0, 80)}"` : ""} references it`);
    }
    if (ev.event === "closed" && ev.commit_id) evidence.push(`Closed by commit ${ev.commit_id.slice(0, 7)}`);
    if (ev.event === "referenced" && ev.commit_id) evidence.push(`Commit ${ev.commit_id.slice(0, 7)} references it`);
  }
  for (const c of input.comments ?? []) {
    if (c.body && DONE_PHRASES.test(c.body)) {
      evidence.push(`A comment${c.user?.login ? ` by ${c.user.login}` : ""} says it is done: "${c.body.trim().slice(0, 80)}"`);
      break;
    }
  }
  const done = input.earlierTasks.filter((t) => t.status === "done");
  if (done.length > 0) evidence.push(`Fhara already finished a task for it ("${done[0].title.slice(0, 80)}")`);
  const unique = [...new Set(evidence)].slice(0, 8);
  return { looksDone: unique.length > 0, evidence: unique };
}

/** Which status label a task state maps to on the issue. */
export function statusLabelForTask(status: string, prMerged = false): IssueStatusLabel | null {
  if (prMerged) return "fhara:done";
  if (status === "queued" || status === "running" || status === "needs_approval" || status === "waiting_input" || status === "paused") {
    return "fhara:running";
  }
  if (status === "done") return "fhara:ready-for-review";
  if (status === "failed" || status === "rejected" || status === "cancelled") return "fhara:failed";
  return null;
}

/** Labels to remove and add so the issue carries exactly `next` among Fhara's status labels. */
export function labelDiff(current: string[], next: IssueStatusLabel): { remove: string[]; add: string[] } {
  const lower = current.map((l) => l.toLowerCase());
  return {
    remove: current.filter((l) => (STATUS_LABELS as readonly string[]).includes(l.toLowerCase()) && l.toLowerCase() !== next),
    add: lower.includes(next) ? [] : [next],
  };
}
