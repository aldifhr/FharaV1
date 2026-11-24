import { mergeabilityOf } from "./prFeedback";
import { fetchCommitChecks } from "./prChecks";

/** GitHub REST pull → our four-state PR status. */
export function mapPrState(pull: {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
}): "draft" | "open" | "merged" | "closed" {
  if (pull.merged || pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  if (pull.draft) return "draft";
  return "open";
}

async function fetchPull(target: { owner: string; repo: string; prNumber: number; token: string }) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return (await response.json()) as {
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    draft?: boolean;
    title?: string;
    mergeable?: boolean | null;
    mergeable_state?: string;
    head?: { sha?: string };
  };
}

/** recordPrState args for a fetched pull. */
function pullFacts(pull: Awaited<ReturnType<typeof fetchPull>>) {
  return {
    state: mapPrState(pull),
    title: pull.title,
    ...(typeof pull.head?.sha === "string" ? { headSha: pull.head.sha } : {}),
    mergeable: mergeabilityOf(pull.mergeable, pull.mergeable_state),
  };
}

/**
 * The PR facts plus the head commit's checks. A checks failure never fails
 * the refresh: the PR state is still recorded, the checks are left as is.
 */
export async function pullFactsWithChecks(target: { owner: string; repo: string; prNumber: number; token: string }) {
  const facts = pullFacts(await fetchPull(target));
  if (!facts.headSha) return facts;
  try {
    const { checks } = await fetchCommitChecks({ ...target, sha: facts.headSha });
    return { ...facts, checks };
  } catch {
    return facts;
  }
}
