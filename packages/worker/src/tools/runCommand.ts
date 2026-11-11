import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { isCommandAllowed } from "@/utils/commandAllowlist";
import { redactText } from "@/utils/redact";
import { shellGuardDecisionForArgv } from "@/utils/shellGuard";
import { isSandboxDenial, SandboxUnavailableError, sandboxStatus, wrapCommand } from "@/tools/osSandbox";

const execFileAsync = promisify(execFile);

// The allowlist lives in utils/commandAllowlist (one source of truth shared
// with the shell agent's prompt and the classifier).
export { ALLOWED_ARGV, allowedCommandLines, isCommandAllowed } from "@/utils/commandAllowlist";

/**
 * Commands whose executables are shell shims (`.cmd`/`.bat`) on Windows and
 * therefore cannot be spawned directly via `execFile` without a shell.
 * `git` and `node` ship as real executables, so they run without a shell on
 * every platform. `npm`/`npx` are shims on Windows only — they need `shell: true`.
 */
const SHELL_REQUIRED_COMMANDS = new Set(["npm", "npx"]);

export function shouldUseShell(command: string): boolean {
  return SHELL_REQUIRED_COMMANDS.has(command);
}

/**
 * The one place a non-PTY command process is started. D6: the argv goes
 * through the bwrap sandbox (tools/osSandbox.ts) unless the mode is off or
 * the user approved an unconfined rerun; a non-off mode without bwrap
 * rejects with SandboxUnavailableError instead of running unconfined.
 */
export function execCommandProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  options: { unconfined?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  const wrapped = wrapCommand(command, args, cwd, { unconfined: options.unconfined });
  if (wrapped.kind === "unavailable") return Promise.reject(new SandboxUnavailableError(wrapped.message));
  return execFileAsync(wrapped.command, wrapped.args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    // bwrap execs the real binary itself; a shell would re-split the argv.
    shell: wrapped.kind === "sandboxed" ? false : shouldUseShell(command),
    windowsHide: true,
    env: buildChildEnv(),
    // Task cancellation (Phase 4): execFile kills the child when the
    // signal fires; the rejection lands in runCommand's catch like any
    // other command failure.
    signal,
  });
}

/** Set when the sandbox refused the command: a denied write, or no usable bwrap. */
export type SandboxRefusal = "denied" | "unavailable";

export async function runCommand(
  workspaceRoot: string,
  command: string,
  args: string[] = [],
  options: { signal?: AbortSignal; unconfined?: boolean } = {}
): Promise<{ stdout: string; stderr: string; sandbox?: SandboxRefusal }> {
  if (!isCommandAllowed(command, args)) {
    throw new Error(`Command blocked (not allowlisted): ${command} ${args.join(" ")}`);
  }
  // L2: never run a command that dumps the environment or a credential file.
  const guard = shellGuardDecisionForArgv(command, args);
  if (guard) {
    throw new Error(`Command blocked by rule ${guard.rule} (${guard.reason}): ${command} ${args.join(" ")}`);
  }
  try {
    const { stdout, stderr } = await execCommandProcess(command, args, workspaceRoot, options.signal, { unconfined: options.unconfined });
    // L2: output leaves the worker (chat, events): mask secrets first.
    return { stdout: redactText(stdout), stderr: redactText(stderr) };
  } catch (err: any) {
    const stdout = String(err?.stdout ?? "");
    const stderr = String(err?.stderr ?? err?.message ?? String(err));
    const sandbox: SandboxRefusal | undefined =
      err instanceof SandboxUnavailableError
        ? "unavailable"
        : !options.unconfined && sandboxStatus().active && isSandboxDenial(`${stdout}\n${stderr}`)
          ? "denied"
          : undefined;
    return { stdout: redactText(stdout), stderr: redactText(stderr), ...(sandbox ? { sandbox } : {}) };
  }
}
