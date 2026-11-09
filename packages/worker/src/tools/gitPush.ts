import { execFile } from "node:child_process";
import { buildChildEnv } from "@/api/convex/lib/childEnv";

/**
 * Plan 019: push a committed sha to a GitHub branch with a short-lived
 * credential.
 *
 * The token never touches argv, `.git/config`, the remote URL, or a log:
 * git receives it as an `http.<url>.extraheader` through the
 * GIT_CONFIG_COUNT/KEY/VALUE environment (git ≥ 2.31), which applies to
 * this one process only. Any error text is passed through `redactSecret`
 * before it leaves this module.
 */

export type ExecGit = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecGit: ExecGit = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        shell: false,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(String(stderr || error.message)) as Error & { stdout?: string };
          failure.stdout = String(stdout ?? "");
          reject(failure);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });

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
  // Drop any inherited GIT_CONFIG_* so indices cannot collide.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) env[key] = value;
  }
  return {
    ...env,
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
  const execGit = input.execGit ?? defaultExecGit;
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const timeoutMs = input.timeoutMs ?? 120_000;
  try {
    // The commit must exist locally (the task branch may already be merged
    // and deleted; the sha stays reachable from the merge commit).
    await execGit(["cat-file", "-e", `${input.commitSha}^{commit}`], {
      cwd: input.repoPath,
      env: buildChildEnv({ GIT_TERMINAL_PROMPT: "0" }),
      signal: input.signal,
      timeoutMs: 15_000,
    });
  } catch {
    throw new Error(`Commit ${input.commitSha.slice(0, 12)} is not in the local repository`);
  }
  try {
    await execGit(
      ["push", "--porcelain", remoteUrl, `${input.force ? "+" : ""}${input.commitSha}:refs/heads/${input.branchName}`],
      { cwd: input.repoPath, env: githubAuthEnv(input.token), signal: input.signal, timeoutMs }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git push failed: ${redactSecret(message, input.token).trim().slice(0, 800)}`);
  }
  return { remoteUrl };
}
