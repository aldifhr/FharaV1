import { wenv } from "@fhara/config/worker";
import { redactSecret } from "./gitPush";
import { proxyAwareFetch, type FetchLike } from "./proxyFetch";
import { settingEnv } from "@/api/convex/lib/appSettings";
import { withAccessLog, type CommandRecorder } from "@/utils/accessLog";

/**
 * Plan 019: open (or find) the pull request for a pushed task branch via
 * the GitHub REST API. Draft first; repositories that do not support draft
 * PRs get a regular PR. An existing PR for the same head is reused, so a
 * retried request never opens a duplicate.
 */

export type { FetchLike };

export interface PullRequestResult {
  number: number;
  url: string;
  title: string;
  state: "draft" | "open" | "merged" | "closed";
}

interface PullJson {
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
}

function toResult(pull: PullJson): PullRequestResult {
  return {
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open",
  };
}

/**
 * The pull request (any state) whose head is `owner:head`, or null when
 * GitHub lists none. Throws when GitHub cannot be asked (L6: an unknown is
 * never read as "no PR").
 */
export async function findPullRequestByHead(input: {
  owner: string;
  repo: string;
  token: string;
  head: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<PullRequestResult | null> {
  const fetchImpl = input.fetchImpl ?? (await proxyAwareFetch());
  const api = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const query = new URLSearchParams({ head: `${input.owner}:${input.head}`, state: "all", per_page: "1" });
  const response = await fetchImpl(`${api}/pulls?${query}`, {
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: input.signal,
  });
  if (!response.ok) throw new Error(redactSecret(`Listing pull requests failed (${response.status})`, input.token));
  const pulls = (await response.json()) as PullJson[];
  return pulls[0] ? toResult(pulls[0]) : null;
}

export async function openPullRequest(input: {
  owner: string;
  repo: string;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /** O5: one sanitized access-log entry per write call (else the process sink). */
  onCommand?: CommandRecorder;
}): Promise<PullRequestResult> {
  // Default honors HTTPS_PROXY/NO_PROXY (Node's global fetch does not).
  const fetchImpl = input.fetchImpl ?? (await proxyAwareFetch());
  const api = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const fail = async (response: Response, what: string): Promise<never> => {
    let detail = "";
    try {
      const json = (await response.json()) as { message?: string; errors?: Array<{ message?: string }> };
      detail = [json.message, ...(json.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ");
    } catch {
      // Body was not JSON.
    }
    throw new Error(redactSecret(`${what} failed (${response.status})${detail ? `: ${detail}` : ""}`, input.token));
  };

  const findExisting = async (): Promise<PullRequestResult | null> => {
    try {
      return await findPullRequestByHead({ ...input, fetchImpl });
    } catch {
      return null;
    }
  };

  const create = async (draft: boolean) =>
    await withAccessLog(
      {
        tool: "github-api",
        args: ["POST", `/repos/${input.owner}/${input.repo}/pulls`, `draft=${draft}`],
        knownSecrets: [input.token],
        recorder: input.onCommand,
        exitCode: (response: Response) => (response.ok ? 0 : response.status),
      },
      () => createCall(draft)
    );
  const createCall = async (draft: boolean) =>
    await fetchImpl(`${api}/pulls`, {
      method: "POST",
      headers,
      signal: input.signal,
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft,
        maintainer_can_modify: true,
      }),
    });

  // Settings → Diffs & PR: "Open pull requests as drafts" (FHARA_PR_DRAFT,
  // default on). A repository without draft support falls back to ready.
  const draft = wenv("FHARA_PR_DRAFT", settingEnv);
  let response = await create(draft);
  if (response.status === 422) {
    const text = await response.clone().text();
    if (/already exists/i.test(text)) {
      const existing = await findExisting();
      if (existing) return existing;
    }
    if (draft && /draft/i.test(text)) {
      response = await create(false);
    }
  }
  if (!response.ok) await fail(response, "Opening the pull request");
  return toResult((await response.json()) as PullJson);
}
