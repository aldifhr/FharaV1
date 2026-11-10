/**
 * T1: read a commit's CI status from GitHub for the push card.
 *
 * Two REST sources, merged into one bounded `CheckFact[]`:
 *  - `GET /repos/{o}/{r}/commits/{sha}/check-runs` (GitHub Actions jobs and
 *    any other Checks API app),
 *  - `GET /repos/{o}/{r}/commits/{sha}/status` (legacy commit statuses:
 *    external CI, Vercel previews, ...).
 * The rollup follows threadbear's `ciVerdict` (runner/src/upstream.ts):
 * any completed failure wins, then anything still running, and no checks
 * at all is "none". Pure apart from the injected fetch; safe in Convex
 * actions and in the worker. The token is only ever sent as a header.
 */

import type { CheckFact, CiState } from "./prFeedback";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Same cap as the webhook fold (prFeedback MAX_CHECKS). */
export const MAX_POLLED_CHECKS = 30;

/** Conclusions that count as a pass (threadbear ciVerdict: success, neutral, skipped). */
const PASSING = new Set(["success", "neutral", "skipped"]);

export type CheckSummary = {
  state: "pending" | "success" | "failure" | "none";
  total: number;
  failed: number;
  pending: number;
  url?: string;
};

type CheckRunJson = {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
};

type StatusJson = { context?: string; state?: string; target_url?: string | null };

/** One check run → a check fact. */
export function checkRunFact(run: CheckRunJson): CheckFact | null {
  if (!run.name) return null;
  const done = run.status === "completed";
  const conclusion = run.conclusion ?? undefined;
  const status: CiState = !done ? "pending" : PASSING.has(conclusion ?? "") ? "passed" : "failed";
  const url = run.html_url || run.details_url || undefined;
  return {
    name: run.name.slice(0, 200),
    status,
    ...(conclusion ? { conclusion: conclusion.slice(0, 40) } : {}),
    ...(url ? { url } : {}),
    ...(typeof run.id === "number" ? { checkRunId: run.id } : {}),
  };
}

/** One commit status → a check fact. */
export function commitStatusFact(status: StatusJson): CheckFact | null {
  if (!status.context) return null;
  const state = status.state ?? "pending";
  const mapped: CiState = state === "success" ? "passed" : state === "pending" ? "pending" : "failed";
  return {
    name: status.context.slice(0, 200),
    status: mapped,
    ...(state !== "pending" ? { conclusion: state } : {}),
    ...(status.target_url ? { url: status.target_url } : {}),
  };
}

/** Rollup for the card. */
export function summarizeChecks(checks: readonly CheckFact[], url?: string): CheckSummary {
  const failed = checks.filter((c) => c.status === "failed").length;
  const pending = checks.filter((c) => c.status === "pending").length;
  const state: CheckSummary["state"] =
    checks.length === 0 ? "none" : failed > 0 ? "failure" : pending > 0 ? "pending" : "success";
  return { state, total: checks.length, failed, pending, ...(url ? { url } : {}) };
}

/** Same name from two sources: keep one, the worse status wins. */
function mergeFacts(facts: CheckFact[]): CheckFact[] {
  const rank: Record<CiState, number> = { failed: 2, pending: 1, passed: 0 };
  const byName = new Map<string, CheckFact>();
  for (const fact of facts) {
    const had = byName.get(fact.name);
    if (!had || rank[fact.status] > rank[had.status]) byName.set(fact.name, fact);
  }
  // Failures first so the cap never hides one.
  return [...byName.values()].sort((a, b) => rank[b.status] - rank[a.status]).slice(0, MAX_POLLED_CHECKS);
}

/**
 * Fetch and merge the check runs and commit statuses on `sha`. A 404 on
 * either source counts as "no checks there"; any other error throws with
 * the HTTP status only (no token, no body echo).
 */
export async function fetchCommitChecks(input: {
  owner: string;
  repo: string;
  sha: string;
  token: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ checks: CheckFact[]; summary: CheckSummary }> {
  if (!/^[0-9a-f]{7,64}$/i.test(input.sha)) throw new Error("Invalid commit sha");
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const repoApi = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fhara",
  };
  const get = async <T>(path: string): Promise<T | null> => {
    const response = await fetchImpl(`${repoApi}${path}`, { headers, signal: input.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub checks request failed (${response.status})`);
    return (await response.json()) as T;
  };
  const [runs, statuses] = await Promise.all([
    get<{ check_runs?: CheckRunJson[] }>(`/commits/${input.sha}/check-runs?per_page=100&filter=latest`),
    get<{ statuses?: StatusJson[] }>(`/commits/${input.sha}/status?per_page=100`),
  ]);
  const facts: CheckFact[] = [];
  for (const run of runs?.check_runs ?? []) {
    const fact = checkRunFact(run);
    if (fact) facts.push(fact);
  }
  for (const status of statuses?.statuses ?? []) {
    const fact = commitStatusFact(status);
    if (fact) facts.push(fact);
  }
  const checks = mergeFacts(facts);
  const url = `https://github.com/${input.owner}/${input.repo}/commit/${input.sha}/checks`;
  return { checks, summary: summarizeChecks(checks, url) };
}
