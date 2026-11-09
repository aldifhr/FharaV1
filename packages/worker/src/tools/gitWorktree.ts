import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function commitWorktree(
  worktreePath: string,
  message: string,
  files?: string[]
): Promise<boolean> {
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    shell: false,
    windowsHide: true,
  });
  if (status.trim().length === 0) return false;
  await execFileAsync("git", files && files.length > 0 ? ["add", "--", ...files] : ["add", "-A"], {
    cwd: worktreePath,
    shell: false,
    windowsHide: true,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=MOAgent",
      "-c",
      "user.email=moagent@localhost",
      "commit",
      "-m",
      message,
    ],
    { cwd: worktreePath, shell: false, windowsHide: true }
  );
  return true;
}
