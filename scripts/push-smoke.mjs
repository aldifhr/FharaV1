#!/usr/bin/env node
/**
 * T1 live push smoke: proves the worker's real push path against GitHub
 * and cleans up after itself.
 *
 *   FHARA_SMOKE_REPO=owner/repo FHARA_SMOKE_GITHUB_TOKEN=... node scripts/push-smoke.mjs
 *   node scripts/push-smoke.mjs --repo owner/repo [--base main] [--out audit/push-smoke.json] [--proxy-auth]
 *
 * What it does, through the worker's own modules (tools/gitPush.ts,
 * tools/githubPr.ts, api/convex/lib/prChecks.ts):
 *  1. checks the push guard refuses the base branch and a force push;
 *  2. shallow-fetches the base branch into a temp repo and commits one file;
 *  3. pushes that commit to a throwaway branch `fhara-e2e-smoke-<ts>`;
 *  4. opens a draft PR into the base branch and reads its state and the
 *     head commit's check status;
 *  5. always: closes the PR, deletes the branch, verifies the branch is
 *     gone, and removes the temp repo.
 *
 * Token: FHARA_SMOKE_GITHUB_TOKEN, then GITHUB_TOKEN, then GH_TOKEN. With
 * --proxy-auth (or FHARA_SMOKE_PROXY_AUTH=1) a placeholder is sent and an
 * outbound credentials proxy (HTTPS_PROXY) is trusted to supply the real
 * one. The token is never printed. Exit 0 = pushed, PR handled, cleaned up.
 *
 * Plain `node` re-runs this file under tsx (so it can import the worker's
 * TypeScript with its path aliases).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envFlag } from "./envManifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

if (process.env.FHARA_PUSH_SMOKE_TSX !== "1") {
  const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const result = spawnSync(
    tsx,
    ["--tsconfig", path.join(root, "packages/worker/tsconfig.json"), fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, FHARA_PUSH_SMOKE_TSX: "1" }, shell: process.platform === "win32" }
  );
  process.exit(result.status ?? 1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const repoFull = arg("repo", process.env.FHARA_SMOKE_REPO);
if (!repoFull || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFull)) {
  console.error("push-smoke: set --repo owner/repo (or FHARA_SMOKE_REPO). Use a throwaway test repository.");
  process.exit(2);
}
const [owner, repo] = repoFull.split("/");
const proxyAuth = flag("proxy-auth") || envFlag(process.env, "FHARA_SMOKE_PROXY_AUTH");
const token =
  process.env.FHARA_SMOKE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (proxyAuth ? "proxy-supplied" : "");
if (!token) {
  console.error("push-smoke: no token (FHARA_SMOKE_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN, or --proxy-auth).");
  process.exit(2);
}
const outFile = arg("out", undefined);

const worker = (rel) => import(pathToFileURL(path.join(root, "packages/worker/src", rel)).href);
const { defaultExecGit, gitChildEnv, githubAuthEnv, pushCommitToGithub, redactSecret, assertPushAllowed } =
  await worker("tools/gitPush.ts");
const { openPullRequest } = await worker("tools/githubPr.ts");
const { proxyAwareFetch } = await worker("tools/proxyFetch.ts");
const { fetchCommitChecks } = await import(pathToFileURL(path.join(root, "apps/api/convex/lib/prChecks.ts")).href);

const fetchImpl = await proxyAwareFetch();
const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "fhara-push-smoke",
  "Content-Type": "application/json",
};
const gh = async (method, url, body) => {
  const response = await fetchImpl(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 204 / non-JSON
  }
  return { status: response.status, ok: response.ok, json };
};

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
const branch = `fhara-e2e-smoke-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
const result = { repo: repoFull, branch, startedAt, steps: [], ok: false };
const step = (name, ok, detail = {}) => {
  result.steps.push({ name, ok, ...detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
};
const safe = (text) => redactSecret(String(text ?? ""), token);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-push-smoke-"));
let prNumber;
let pushed = false;
try {
  // 1. Guard (no network).
  for (const [name, input] of [
    ["guard refuses base-branch push", { branchName: "main", baseBranch: "main" }],
    ["guard refuses force push", { branchName: branch, baseBranch: "main", force: true }],
  ]) {
    try {
      assertPushAllowed({ ...input, allowBaseBranch: false, allowForce: false });
      step(name, false, { error: "not refused" });
    } catch (error) {
      step(name, true, { reason: safe(error.message) });
    }
  }

  // 2. Base branch + one commit, in an absolute temp repo.
  const repoInfo = await gh("GET", api);
  if (!repoInfo.ok) throw new Error(`cannot read ${repoFull} (${repoInfo.status})`);
  const base = arg("base", repoInfo.json?.default_branch || "main");
  result.base = base;
  const git = (args, env = gitChildEnv(), timeoutMs = 120_000) => defaultExecGit(args, { cwd: tmp, env, timeoutMs });
  await git(["init", "-q"]);
  await git(
    ["fetch", "-q", "--depth=1", `https://github.com/${owner}/${repo}.git`, `refs/heads/${base}`],
    githubAuthEnv(token),
    5 * 60_000
  );
  await git(["checkout", "-q", "FETCH_HEAD"]);
  fs.writeFileSync(path.join(tmp, `${branch}.md`), `Fhara push smoke ${startedAt}. Safe to delete.\n`);
  await git(["add", "--", `${branch}.md`]);
  const identity = gitChildEnv({
    GIT_AUTHOR_NAME: "Fhara smoke",
    GIT_AUTHOR_EMAIL: "fhara-smoke@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Fhara smoke",
    GIT_COMMITTER_EMAIL: "fhara-smoke@users.noreply.github.com",
  });
  await git(["commit", "-q", "-m", `chore: fhara push smoke ${stamp}`], identity);
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  result.commitSha = sha;
  step("local commit on base", true, { base, sha: sha.slice(0, 12) });

  // 3. The worker's push.
  const t0 = Date.now();
  await pushCommitToGithub({ repoPath: tmp, owner, repo, commitSha: sha, branchName: branch, baseBranch: base, token });
  pushed = true;
  const ref = await gh("GET", `${api}/git/ref/heads/${encodeURIComponent(branch)}`);
  const remoteSha = ref.json?.object?.sha;
  step("push via pushCommitToGithub", ref.ok && remoteSha === sha, { ms: Date.now() - t0, remoteSha: remoteSha?.slice(0, 12) });
  if (!(ref.ok && remoteSha === sha)) throw new Error("pushed branch not visible on GitHub");

  // 4. Draft PR, its state, and the head commit's checks.
  if (!flag("no-pr")) {
    try {
      const pr = await openPullRequest({
        owner,
        repo,
        token,
        head: branch,
        base,
        title: `Fhara push smoke ${stamp} (auto-closed)`,
        body: "Opened by `scripts/push-smoke.mjs`. Closed and its branch deleted automatically.",
        fetchImpl,
      });
      prNumber = pr.number;
      result.pr = { number: pr.number, url: pr.url, state: pr.state };
      step("open draft PR", true, { number: pr.number, url: pr.url, state: pr.state });
      const read = await gh("GET", `${api}/pulls/${pr.number}`);
      step("read PR", read.ok, { state: read.json?.state, draft: read.json?.draft, headSha: read.json?.head?.sha?.slice(0, 12) });
      const { checks, summary } = await fetchCommitChecks({ owner, repo, sha, token, fetchImpl });
      result.checks = summary;
      step("read PR check status", true, { ...summary, names: checks.map((c) => `${c.name}:${c.status}`).slice(0, 10) });
    } catch (error) {
      result.prError = safe(error.message);
      step("open/read PR", false, { error: result.prError });
    }
  }
  result.ok = result.steps.every((s) => s.ok);
} catch (error) {
  result.error = safe(error instanceof Error ? error.message : error);
  step("smoke", false, { error: result.error });
} finally {
  // 5. Cleanup, always.
  if (prNumber !== undefined) {
    const closed = await gh("PATCH", `${api}/pulls/${prNumber}`, { state: "closed" }).catch((e) => ({ ok: false, status: safe(e.message) }));
    step("cleanup: close PR", closed.ok, { number: prNumber, state: closed.json?.state });
    result.cleanup = { ...(result.cleanup ?? {}), prClosed: closed.ok };
    if (!closed.ok) result.ok = false;
  }
  if (pushed) {
    const deleted = await gh("DELETE", `${api}/git/refs/heads/${encodeURIComponent(branch)}`).catch((e) => ({ ok: false, status: safe(e.message) }));
    const gone = await gh("GET", `${api}/git/ref/heads/${encodeURIComponent(branch)}`).catch(() => ({ status: 0 }));
    const ok = (deleted.ok || deleted.status === 422) && gone.status === 404;
    step("cleanup: delete branch", ok, { deleteStatus: deleted.status, verifyStatus: gone.status });
    result.cleanup = { ...(result.cleanup ?? {}), branchDeleted: ok };
    if (!ok) result.ok = false;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  if (outFile) {
    const target = path.resolve(root, outFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(result.ok ? "push-smoke: PASS" : "push-smoke: FAIL");
}
process.exit(result.ok ? 0 : 1);
