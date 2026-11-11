/**
 * OS command sandbox (bwrap, Linux).
 *
 * Every agent command goes through one of two spawn functions
 * (`execCommandProcess` in runCommand.ts, `spawnPtyProcess` in runPty.ts);
 * both ask `wrapCommand` here for the argv to start. In `workspace-write`
 * (the default) the whole filesystem is mounted read-only, the task's
 * worktree (plus its git common dir and SANDBOX_EXTRA_WRITE_ROOTS) is bound
 * writable, `/tmp` is a private tmpfs and the PID namespace is private.
 *
 * Support is probed once per process and cached: `full` (the whole
 * profile works), `partial` (mounts work but no private PID namespace or
 * /proc, e.g. inside some containers) or `off` (no usable bwrap). When the
 * mode is not `off` and support is `off`, commands are NOT run unconfined:
 * the wrapper reports SANDBOX_UNAVAILABLE and the caller asks the user
 * (approval kind `run_unconfined`) before a rerun without the sandbox. A
 * write the profile refuses ("Read-only file system") is detected from the
 * output and offered the same way.
 *
 * The bwrap mount profile in `bwrapProfileArgs` is adapted from DeepSeek
 * Harness (https://github.com/deepseek-ai/deepseek-harness, MIT, Copyright
 * (c) 2026 DeepSeek), commit e8f7b93a, packages/sandbox/sandbox-local/src/profiles.ts
 * (`bwrapProfileArgs`) and the denial dialect / probe in src/index.ts.
 * Modified by Fhara: plain policy object instead of the package types, a
 * `partial` profile without the PID namespace, `--chdir`, and the git
 * common dir of a linked worktree added to the writable roots. See
 * THIRD_PARTY_NOTICES.md ("DeepSeek Harness").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { wenv, wenvRaw, type EnvSource } from "@fhara/config/worker";
import { buildChildEnv } from "@/api/convex/lib/childEnv";

export type SandboxMode = "workspace-write" | "read-only" | "off";
export type SandboxSupport = "full" | "partial" | "off";

export interface SandboxPolicy {
  mode: Exclude<SandboxMode, "off">;
  /** Writable roots (absolute, existing); ignored in read-only. */
  writableRoots: string[];
}

/** Startup / status code when a non-off mode has no usable bwrap. */
export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

/** Case-insensitive output substrings that mean the profile refused a write. */
export const SANDBOX_DENIAL_SIGNATURES: readonly string[] = ["read-only file system"];

/**
 * Build the bwrap profile arguments for one policy (before `--` and the
 * command argv). `partial` drops the private PID namespace and /proc.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, support: Exclude<SandboxSupport, "off"> = "full"): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev"];
  if (support === "full") args.push("--unshare-pid", "--proc", "/proc");
  args.push("--die-with-parent");
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp");
    for (const root of policy.writableRoots) args.push("--bind", root, root);
  }
  return args;
}

export interface ModeResolution {
  mode: SandboxMode;
  /** True when SANDBOX_MODE was set (not the schema default). */
  explicit: boolean;
  /** Why an unset mode resolved to off (non-Linux host). */
  note?: string;
}

/**
 * The configured mode. Unset means `workspace-write` on Linux (bwrap's
 * platform); on other platforms an unset mode is `off` with a note, since
 * bwrap does not exist there. `off` on Linux must be set explicitly.
 */
export function resolveSandboxMode(env?: EnvSource, platform: NodeJS.Platform = process.platform): ModeResolution {
  const raw = wenvRaw("SANDBOX_MODE", env)?.trim();
  const explicit = Boolean(raw);
  const mode = wenv("SANDBOX_MODE", env) as SandboxMode;
  if (!explicit && platform !== "linux") {
    return { mode: "off", explicit, note: `no bwrap on ${platform}` };
  }
  return { mode, explicit };
}

type ProbeRunner = (args: string[]) => boolean;

const defaultProbe: ProbeRunner = (args) => {
  try {
    const probe = spawnSync("bwrap", [...args, "--", "true"], { stdio: "ignore", timeout: 5_000, env: buildChildEnv() });
    return probe.status === 0;
  } catch {
    return false;
  }
};

let cachedSupport: SandboxSupport | undefined;
let probeOverride: ProbeRunner | undefined;

/** Probe bwrap once per process (cached): full, partial or off. */
export function probeSandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
  if (cachedSupport) return cachedSupport;
  const run = probeOverride ?? defaultProbe;
  const policy: SandboxPolicy = { mode: "read-only", writableRoots: [] };
  if (platform !== "linux" && !probeOverride) cachedSupport = "off";
  else if (run(bwrapProfileArgs(policy, "full"))) cachedSupport = "full";
  else if (run(bwrapProfileArgs(policy, "partial"))) cachedSupport = "partial";
  else cachedSupport = "off";
  return cachedSupport;
}

/** Test hook: forget the cached probe and optionally inject a verdict runner. */
export function resetSandboxProbeForTest(runner?: ProbeRunner): void {
  cachedSupport = undefined;
  probeOverride = runner;
}

export interface SandboxStatus {
  mode: SandboxMode;
  support: SandboxSupport;
  /** Commands will run inside bwrap. */
  active: boolean;
  /** SANDBOX_UNAVAILABLE when a non-off mode has no usable bwrap. */
  code?: typeof SANDBOX_UNAVAILABLE;
  /** One short line for logs, the status line and Devices. */
  note: string;
}

export function sandboxStatus(env?: EnvSource, platform: NodeJS.Platform = process.platform): SandboxStatus {
  const { mode, note } = resolveSandboxMode(env, platform);
  if (mode === "off") return { mode, support: "off", active: false, note: note ? `sandbox off (${note})` : "sandbox off" };
  const support = probeSandboxSupport(platform);
  if (support === "off") {
    return {
      mode,
      support,
      active: false,
      code: SANDBOX_UNAVAILABLE,
      note: `${SANDBOX_UNAVAILABLE}: bwrap is not usable; commands ask before running unconfined (set SANDBOX_MODE=off to opt out)`,
    };
  }
  return { mode, support, active: true, note: `sandbox ${mode}${support === "partial" ? " (partial: no private PID namespace)" : ""}` };
}

/** Short capability tag for the worker heartbeat (Devices shows it). */
export function sandboxCapability(status: SandboxStatus): string {
  if (status.code) return "sandbox:unavailable";
  return status.active ? `sandbox:${status.mode}${status.support === "partial" ? ":partial" : ""}` : "sandbox:off";
}

function realOrNull(target: string): string | null {
  try {
    return statSync(target).isDirectory() ? realpathSync(target) : null;
  } catch {
    return null;
  }
}

/** The common git dir of a linked worktree (`.git` is a `gitdir:` file), so commits can write it. */
function worktreeGitCommonDir(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return null;
    const gitDir = path.resolve(root, match[1]!.trim());
    const commonFile = path.join(gitDir, "commondir");
    const common = existsSync(commonFile) ? path.resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    return realOrNull(common);
  } catch {
    return null;
  }
}

/** Writable roots for one command: the worktree, its git common dir, extra roots (absolute, existing, deduplicated). */
export function writableRootsFor(workspaceRoot: string, env?: EnvSource): string[] {
  const roots = new Set<string>();
  const root = realOrNull(workspaceRoot);
  if (root) {
    roots.add(root);
    const common = worktreeGitCommonDir(root);
    if (common) roots.add(common);
  }
  const extra = String(wenv("SANDBOX_EXTRA_WRITE_ROOTS", env) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && path.isAbsolute(entry));
  for (const entry of extra) {
    const real = realOrNull(entry);
    if (real) roots.add(real);
  }
  return [...roots];
}

export type WrappedCommand =
  | { kind: "sandboxed"; command: string; args: string[]; status: SandboxStatus }
  | { kind: "unconfined"; command: string; args: string[]; status: SandboxStatus; reason: "off" | "approved" }
  | { kind: "unavailable"; status: SandboxStatus; message: string };

/**
 * The argv to spawn for one command. `unconfined` is only passed after the
 * user approved a `run_unconfined` card.
 */
export function wrapCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { unconfined?: boolean; env?: EnvSource } = {}
): WrappedCommand {
  const status = sandboxStatus(options.env);
  if (options.unconfined) return { kind: "unconfined", command, args, status, reason: "approved" };
  if (status.mode === "off") return { kind: "unconfined", command, args, status, reason: "off" };
  if (!status.active) {
    return {
      kind: "unavailable",
      status,
      message: `${SANDBOX_UNAVAILABLE}: bwrap is not usable on this worker, so the command was not run (set SANDBOX_MODE=off to run commands without the sandbox)`,
    };
  }
  const policy: SandboxPolicy = { mode: status.mode as SandboxPolicy["mode"], writableRoots: writableRootsFor(cwd, options.env) };
  const profile = bwrapProfileArgs(policy, status.support === "partial" ? "partial" : "full");
  return { kind: "sandboxed", command: "bwrap", args: [...profile, "--chdir", cwd, "--", command, ...args], status };
}

/** True when command output carries a sandbox denial signature. */
export function isSandboxDenial(text: string): boolean {
  const lower = text.toLowerCase();
  return SANDBOX_DENIAL_SIGNATURES.some((signature) => lower.includes(signature));
}

/** Thrown by the spawn functions when a non-off mode has no usable bwrap. */
export class SandboxUnavailableError extends Error {
  readonly code = SANDBOX_UNAVAILABLE;
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}
