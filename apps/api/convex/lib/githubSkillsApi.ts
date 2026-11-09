/**
 * GitHub REST reads for the skills import. Works unauthenticated against
 * public repos; a token (from an existing GitHub integration) is only used
 * to lift rate limits and reach private repos, and is dropped on a 401 so
 * a stale token never blocks a public import. The token goes in the
 * Authorization header only and is never returned or logged.
 */

import {
  findSkillFiles,
  githubFileUrls,
  GITHUB_SKILL_SCAN_MAX,
  type GithubSkillUrl,
} from "./githubSkills";

const API = "https://api.github.com";

export class GithubImportError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "rate_limited" | "no_skills" | "bad_request" | "upstream"
  ) {
    super(message);
    this.name = "GithubImportError";
  }
}

type Fetched = { status: number; headers: Headers; body: string };

export class GithubClient {
  private token: string | undefined;
  readonly authenticated: () => boolean;

  constructor(token?: string) {
    this.token = token || undefined;
    this.authenticated = () => Boolean(this.token);
  }

  private async raw(url: string, accept: string): Promise<Fetched> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "Fhara-skills-import",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token && url.startsWith(API)) headers.Authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch {
      throw new GithubImportError("Could not reach GitHub. Check the network and try again.", "upstream");
    }
    if (res.status === 401 && headers.Authorization) {
      // Stale integration token: fall back to anonymous for public repos.
      this.token = undefined;
      return this.raw(url, accept);
    }
    return { status: res.status, headers: res.headers, body: await res.text() };
  }

  private fail(res: Fetched, what: string): never {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || /rate limit/i.test(res.body)))) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(res.headers.get("retry-after"));
      const when = Number.isFinite(reset) && reset > 0
        ? ` Try again after ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC.`
        : Number.isFinite(retryAfter) && retryAfter > 0
          ? ` Try again in ${Math.ceil(retryAfter / 60)} min.`
          : " Try again in a few minutes.";
      const hint = this.token ? "" : " Connecting GitHub in a project's settings raises the limit.";
      throw new GithubImportError(`GitHub rate limit reached.${when}${hint}`, "rate_limited");
    }
    if (res.status === 404) {
      throw new GithubImportError(
        this.token
          ? `${what} not found, or the connected GitHub account cannot see it.`
          : `${what} not found. It may be private: connect GitHub in a project's settings to import from private repositories.`,
        "not_found"
      );
    }
    if (res.status === 403) {
      throw new GithubImportError(`GitHub refused access to ${what.toLowerCase()}.`, "not_found");
    }
    throw new GithubImportError(`GitHub returned ${res.status} for ${what.toLowerCase()}.`, "upstream");
  }

  async json<T>(path: string, what: string, opts: { allow404?: boolean } = {}): Promise<T | null> {
    const res = await this.raw(`${API}${path}`, "application/vnd.github+json");
    if (res.status === 404 && opts.allow404) return null;
    if (res.status < 200 || res.status >= 300) this.fail(res, what);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new GithubImportError(`GitHub sent an unreadable response for ${what.toLowerCase()}.`, "upstream");
    }
  }

  /** File text at a commit: raw.githubusercontent for public repos, contents API for private. */
  async fileText(owner: string, repo: string, sha: string, path: string, isPrivate: boolean): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = isPrivate
      ? await this.raw(`${API}/repos/${owner}/${repo}/contents/${encoded}?ref=${sha}`, "application/vnd.github.raw")
      : await this.raw(githubFileUrls(owner, repo, sha, path).raw, "text/plain");
    if (res.status < 200 || res.status >= 300) this.fail(res, path);
    return res.body;
  }
}

export type ResolvedRepo = {
  owner: string;
  repo: string;
  fullName: string;
  isPrivate: boolean;
  ref: string;
  sha: string;
  license?: { spdxId: string; url?: string };
  /** Every SKILL.md in the repo at `sha` (not limited to the URL's folder). */
  allSkillPaths: Set<string>;
  /** SKILL.md files under the URL's folder, capped at GITHUB_SKILL_SCAN_MAX. */
  files: Array<{ path: string; size?: number }>;
  total: number;
  treeTruncated: boolean;
};

/** Repo metadata, commit sha, license and the SKILL.md list for a parsed URL. */
export async function resolveGithubRepo(client: GithubClient, url: GithubSkillUrl): Promise<ResolvedRepo> {
  const meta = await client.json<{ full_name: string; default_branch: string; private: boolean }>(
    `/repos/${url.owner}/${url.repo}`,
    "Repository"
  );
  const fullName = meta!.full_name;
  const [owner, repo] = fullName.split("/");
  const ref = url.ref ?? meta!.default_branch;
  const commit = await client.json<{ sha: string }>(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    `Branch or commit "${ref}"`
  );
  const sha = commit!.sha;
  const [license, tree] = await Promise.all([
    client.json<{ license?: { spdx_id?: string } | null; html_url?: string }>(
      `/repos/${owner}/${repo}/license`,
      "License",
      { allow404: true }
    ),
    client.json<{ tree?: Array<{ path?: string; type?: string; size?: number }>; truncated?: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
      "Repository tree"
    ),
  ]);
  const entries = tree?.tree ?? [];
  const all = findSkillFiles(entries, "", Number.POSITIVE_INFINITY);
  const scoped = findSkillFiles(entries, url.path, GITHUB_SKILL_SCAN_MAX);
  if (url.path && url.kind !== "blob" && !entries.some((e) => e.path === url.path && e.type === "tree")) {
    throw new GithubImportError(`Folder "${url.path}" not found in ${fullName}@${ref}.`, "not_found");
  }
  if (scoped.total === 0) {
    throw new GithubImportError(
      url.kind === "blob"
        ? `${url.path} not found in ${fullName}@${ref}.`
        : `No SKILL.md found in ${fullName}${url.path ? `/${url.path}` : ""}.`,
      url.kind === "blob" ? "not_found" : "no_skills"
    );
  }
  const spdx = license?.license?.spdx_id;
  return {
    owner,
    repo,
    fullName,
    isPrivate: meta!.private,
    ref,
    sha,
    ...(spdx && spdx !== "NOASSERTION"
      ? { license: { spdxId: spdx, ...(license?.html_url ? { url: license.html_url } : {}) } }
      : spdx === "NOASSERTION"
        ? { license: { spdxId: "Other", ...(license?.html_url ? { url: license.html_url } : {}) } }
        : {}),
    allSkillPaths: new Set(all.files.map((f) => f.path)),
    files: scoped.files,
    total: scoped.total,
    treeTruncated: Boolean(tree?.truncated),
  };
}

/** Run `fn` over `items` with at most `limit` in flight, results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
