import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
    ["diff"],
    ["diff", "--no-color"],
    ["diff", "--stat"],
    ["log", "--oneline", "-n", "20"],
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

export async function runCommand(
  workspaceRoot: string,
  command: string,
  args: string[] = []
): Promise<{ stdout: string; stderr: string }> {
  if (!isCommandAllowed(command, args)) {
    throw new Error(`Command blocked (not allowlisted): ${command} ${args.join(" ")}`);
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err: any) {
    return {
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? err?.message ?? String(err),
    };
  }
}
