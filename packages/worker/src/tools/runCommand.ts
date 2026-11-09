import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";

const execFileAsync = promisify(execFile);

/**
 * Exact argv allowlist. Substring/prefix allowlisting is unsafe because
 * `npm run test; rm -rf /` or `git status --short` would pass a prefix check.
 * Every element must match exactly (after trimming).
 */
const ALLOWED_ARGV: Record<string, string[][]> = {
  npm: [["run", "test"], ["run", "build"], ["run", "typecheck"]],
  npx: [["tsc", "--noEmit"]],
  git: [
    ["status"],
    ["status", "--short"],
    ["status", "-sb"],
    ["branch", "--show-current"],
    ["diff"],
    ["diff", "--no-color"],
    ["diff", "--stat"],
    ["log", "--oneline", "-n", "20"],
    ["fetch"],
    ["pull"],
    ["pull", "--ff-only"],
    ["pull", "--rebase"],
  ],
  node: [["--version"]],
};

export function isCommandAllowed(command: string, args: string[]): boolean {
  const allowed = ALLOWED_ARGV[command];
  if (!allowed) return false;
  if (args.some((arg) => /[\u0000-\u001f]/.test(arg))) return false;
  return allowed.some(
    (candidate) =>
      candidate.length === args.length &&
      candidate.every((value, index) => value === args[index])
  );
}

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
