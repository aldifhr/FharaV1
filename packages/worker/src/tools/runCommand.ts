import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WHITELIST: Record<string, string[]> = {
  npm: ["run", "test", "run build", "run typecheck"],
  npx: ["tsc"],
  git: ["status", "diff", "log"],
  node: ["--version"],
};

function isAllowed(command: string, args: string[]): boolean {
  const allowedPrefixes = WHITELIST[command];
  if (!allowedPrefixes) return false;
  const joined = args.join(" ");
  return allowedPrefixes.some((p) => joined === p || joined.startsWith(p + " ") || joined.startsWith(p));
}

export async function runCommand(
  workspaceRoot: string,
  command: string,
  args: string[] = []
): Promise<{ stdout: string; stderr: string }> {
  if (!isAllowed(command, args)) {
    throw new Error(`Command blocked (not whitelisted): ${command} ${args.join(" ")}`);
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workspaceRoot,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err: any) {
    return {
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? err?.message ?? String(err),
    };
  }
}
