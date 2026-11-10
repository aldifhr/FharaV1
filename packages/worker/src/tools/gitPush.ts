import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { UNTRUSTED_GIT_CONFIG, untrustedGitEnv } from "@/vendor/threadbear/safeGit";

/**
 * Plan 019: push a committed sha to a GitHub branch with a short-lived
 * credential.
 *
 * The token never touches argv, `.git/config`, the remote URL, or a log:
 * git receives it as an `http.<url>.extraheader` through the
 * GIT_CONFIG_COUNT/KEY/VALUE environment (git ≥ 2.31), which applies to
 * this one process only. Any error text is passed through `redactSecret`
 * before it leaves this module.
 *
 * T1 hardening (threadbear safe-git, see vendor/threadbear/safeGit.ts):
 * every git call runs with an absolute, existing cwd, no inherited GIT_*
 * variable (a GIT_DIR from the worker's own env can not redirect the push),
 * the repo's fsmonitor/untracked-cache/hooks switched off (a pre-push hook
 * would otherwise run with the credential in its env), and a kill timeout
 * (SIGKILL) so a hung remote never holds the push lease forever.
 */

/** Per git call kill timeout (5 minutes). */
export const GIT_TIMEOUT_MS = 5 * 60_000;

/** `-c` settings put before every push-path git subcommand. */
export const PUSH_GIT_CONFIG: readonly string[] = [
  ...UNTRUSTED_GIT_CONFIG,
  "-c",
  `core.hooksPath=${os.devNull}`,
  "-c",
  "commit.gpgSign=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "push.recurseSubmodules=no",
];

export type ExecGit = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The cwd for a git call: absolute, normalized, and an existing directory.
 * A relative path would resolve against whatever the worker's cwd happens
 * to be; refuse it instead of pushing from the wrong checkout.
 */
export function assertGitCwd(cwd: string): string {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error(`git cwd must be an absolute path (got ${JSON.stringify(cwd)})`);
  const resolved = path.resolve(cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`git cwd does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`git cwd is not a directory: ${resolved}`);
  return resolved;
}

/** Plain-words reason for a failed git call (timeout, abort, or git's own text). */
export function describeGitFailure(
  args: readonly string[],
  error: { killed?: boolean; signal?: string | null; code?: unknown; name?: string; message?: string },
  stderr: string,
  timeoutMs: number
): string {
  const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c" && args[i - 1] !== "-C") ?? "git";
  if (error.name === "AbortError") return `git ${sub} was cancelled`;
  if (error.killed || error.signal === "SIGKILL" || error.signal === "SIGTERM") {
    return `git ${sub} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`;
  }
  if (error.code === "ENOENT") return "git is not installed or not on PATH";
  const text = (stderr || error.message || "").trim();
  return text || `git ${sub} failed (exit ${String(error.code ?? "?")})`;
}

export const defaultExecGit: ExecGit = (args, options) =>
  new Promise((resolve, reject) => {
    let cwd: string;
    try {
      cwd = assertGitCwd(options.cwd);
    } catch (error) {
      reject(error);
      return;
    }
    execFile(
      "git",
      [...PUSH_GIT_CONFIG, ...args],
      {
        cwd,
        // Never inherit GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_PARAMETERS from
        // the worker; the caller's own GIT_CONFIG_* (auth) is kept.
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        shell: false,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(
            describeGitFailure(args, error as Parameters<typeof describeGitFailure>[1], String(stderr ?? ""), options.timeoutMs)
          ) as Error & { stdout?: string };
          failure.stdout = String(stdout ?? "");
          reject(failure);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });

/** A child env for git with every inherited GIT_* variable removed. */
export function gitChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...untrustedGitEnv(buildChildEnv()), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extra };
}

/** Plain-words hint for common push rejections. */
export function pushFailureHint(message: string): string | undefined {
  if (/timed out after/i.test(message)) return "GitHub did not answer in time; try again";
  if (/non-fast-forward|fetch first|\[rejected\]|stale info/i.test(message)) {
    return "the remote branch has commits this push does not; force push is disabled";
  }
  if (/protected branch|GH006/i.test(message)) return "the branch is protected on GitHub";
  if (/\b403\b|permission .*denied|not allowed to push|write access/i.test(message)) {
    return "the GitHub connection has no push access to this repository";
  }
  if (/\b401\b|authentication failed|could not read Username|invalid credentials/i.test(message)) {
    return "GitHub refused the credential; reconnect GitHub";
  }
  if (/repository not found|\b404\b/i.test(message)) return "the repository was not found or the connection cannot see it";
  if (/could not resolve host|unable to access|connection (refused|reset|timed out)/i.test(message)) {
    return "github.com could not be reached";
  }
  return undefined;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
// Conservative ref check (subset of git check-ref-format).
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

export function redactSecret(text: string, token: string): string {
  if (!text) return text;
  let out = text;
  const forms = [token, Buffer.from(`x-access-token:${token}`).toString("base64")];
  for (const form of forms) {
    if (form) out = out.split(form).join("***");
  }
  // Belt and braces: anything shaped like a GitHub token.
  return out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
}

/** Environment for one authenticated git call against github.com. */
export function githubAuthEnv(token: string, base: NodeJS.ProcessEnv = buildChildEnv()): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  // Drop every inherited GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*,
  // GIT_CONFIG_PARAMETERS, GIT_SSH_COMMAND...) so nothing can redirect the
  // push or add config after ours.
  const env = untrustedGitEnv(base);
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    // No credential helper may prompt or persist anything for this call.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}

export interface PushInput {
  repoPath: string;
  owner: string;
  repo: string;
  commitSha: string;
  branchName: string;
  token: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  execGit?: ExecGit;
  /**
   * The repository's base branch (the PR target). A push whose target is
   * the base branch, or main/master, is refused unless `allowBaseBranch`
   * (or FHARA_ALLOW_BASE_BRANCH_PUSH=true) says otherwise.
   */
  baseBranch?: string;
  allowBaseBranch?: boolean;
  /** Force-push (`+sha:ref`). Refused unless `allowForce` (or FHARA_ALLOW_FORCE_PUSH=true). */
  force?: boolean;
  allowForce?: boolean;
}

/** Branch names a task push may never target without an explicit override. */
const ALWAYS_PROTECTED = new Set(["main", "master"]);

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] ?? "").trim());
}

/**
 * Push guard: task pushes go to their own task branch. Pushing straight to
 * the base branch (or main/master) and force-pushing both need an explicit
 * allow, per call or by env. Throws with the reason; returns nothing.
 */
export function assertPushAllowed(input: {
  branchName: string;
  baseBranch?: string;
  allowBaseBranch?: boolean;
  force?: boolean;
  allowForce?: boolean;
}): void {
  const target = input.branchName.replace(/^refs\/heads\//, "");
  const base = input.baseBranch?.replace(/^refs\/heads\//, "").trim();
  const protectedTarget = ALWAYS_PROTECTED.has(target) || (base !== undefined && base !== "" && target === base);
  if (protectedTarget && !(input.allowBaseBranch ?? envFlag("FHARA_ALLOW_BASE_BRANCH_PUSH"))) {
    throw new Error(
      `Push blocked: "${target}" is the base branch; task pushes go to their own branch (set FHARA_ALLOW_BASE_BRANCH_PUSH=true to allow)`
    );
  }
  if (input.force && !(input.allowForce ?? envFlag("FHARA_ALLOW_FORCE_PUSH"))) {
    throw new Error("Push blocked: force push is not allowed (set FHARA_ALLOW_FORCE_PUSH=true to allow)");
  }
}

export async function pushCommitToGithub(input: PushInput): Promise<{ remoteUrl: string }> {
  if (!NAME.test(input.owner) || !NAME.test(input.repo)) throw new Error("Invalid GitHub repository");
  if (!SHA.test(input.commitSha)) throw new Error("Invalid commit sha");
  if (!BRANCH.test(input.branchName)) throw new Error(`Invalid branch name: ${input.branchName}`);
  assertPushAllowed(input);
  // Absolute cwd only (checked again by defaultExecGit for direct callers).
  if (!input.repoPath || !path.isAbsolute(input.repoPath)) {
    throw new Error(`Push refused: repository path must be absolute (got ${JSON.stringify(input.repoPath)})`);
  }
  const repoPath = path.resolve(input.repoPath);
  const execGit = input.execGit ?? defaultExecGit;
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? GIT_TIMEOUT_MS, 1_000), GIT_TIMEOUT_MS);
  try {
    // The commit must exist locally (the task branch may already be merged
    // and deleted; the sha stays reachable from the merge commit).
    await execGit(["cat-file", "-e", `${input.commitSha}^{commit}`], {
      cwd: repoPath,
      env: gitChildEnv(),
      signal: input.signal,
      timeoutMs: 15_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/absolute path|does not exist|not a directory|not installed|timed out|cancelled/.test(message)) {
      throw new Error(`Push failed before contacting GitHub: ${message}`);
    }
    throw new Error(`Commit ${input.commitSha.slice(0, 12)} is not in the local repository at ${repoPath}`);
  }
  try {
    await execGit(
      ["push", "--porcelain", remoteUrl, `${input.force ? "+" : ""}${input.commitSha}:refs/heads/${input.branchName}`],
      { cwd: repoPath, env: githubAuthEnv(input.token), signal: input.signal, timeoutMs }
    );
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), input.token).trim();
    const hint = pushFailureHint(message);
    throw new Error(
      `git push failed for ${input.branchName} → ${input.owner}/${input.repo}${hint ? ` (${hint})` : ""}: ${message.slice(0, 800)}`
    );
  }
  return { remoteUrl };
}
