import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { isCommandAllowed } from "@/utils/commandAllowlist";

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

export async function runCommand(
  workspaceRoot: string,
  command: string,
  args: string[] = [],
  options: { signal?: AbortSignal } = {}
): Promise<{ stdout: string; stderr: string }> {
  if (!isCommandAllowed(command, args)) {
    throw new Error(`Command blocked (not allowlisted): ${command} ${args.join(" ")}`);
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: shouldUseShell(command),
      windowsHide: true,
      env: buildChildEnv(),
      // Task cancellation (Phase 4): execFile kills the child when the
      // signal fires; the rejection lands in the catch below like any
      // other command failure.
      signal: options.signal,
    });
    return { stdout, stderr };
  } catch (err: any) {
    return {
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? err?.message ?? String(err),
    };
  }
}
