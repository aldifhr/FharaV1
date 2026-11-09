import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A fresh empty directory under the OS temp dir. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a temp directory (recursive, missing is fine). */
export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface TempGitRepo {
  dir: string;
  /** Run git in the repo; returns stdout (utf-8). */
  git: (...args: string[]) => string;
  cleanup: () => void;
}

/**
 * A throwaway git repo with a deterministic identity. `files` are written
 * and committed as the initial commit ("init"); with no files the initial
 * commit is empty. Pass `commit: false` to leave the repo without commits.
 */
export function createTempGitRepo(
  options: {
    prefix?: string;
    files?: Record<string, string>;
    commit?: boolean;
    branch?: string;
  } = {}
): TempGitRepo {
  const dir = makeTempDir(options.prefix ?? "moagent-repo-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", ...(options.branch ? ["-b", options.branch] : []));
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  if (options.commit !== false) {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "init");
  }
  return { dir, git, cleanup: () => removeTempDir(dir) };
}
