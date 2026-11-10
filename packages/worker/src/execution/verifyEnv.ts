import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Environment vs code classification for a failed verification step
 * (live test 4: a worktree without node_modules failed `tsc` with TS2688,
 * the verify-fix agent could change nothing, and the task looped).
 *
 * A failure is ENVIRONMENT when nothing a code fix could do would make it
 * pass: missing dependencies / type packages, a missing binary, a missing
 * file the runner itself needs. Every error the output names must be of
 * that kind; one real code error makes the whole failure a code failure.
 */
export type VerifyFailureClass = { kind: "env"; reason: string } | { kind: "code" };

/** TypeScript error codes that only ever mean "the environment lacks something". */
const TS_ENV_CODES = new Set([
  "TS2688", // Cannot find type definition file for 'node'
  "TS6053", // File '…/node_modules/…' not found (extends / types)
]);

const TS_ERROR_LINE = /^(.*?)(?:\(\d+,\d+\)|:\d+:\d+)?:?\s*-?\s*error\s+(TS\d+):\s*(.*)$/;
const MISSING_MODULE = /Cannot find (?:module|package) ['"]([^'"]+)['"]/;

const GENERIC_ENV: Array<{ pattern: RegExp; reason: (match: RegExpMatchArray) => string }> = [
  { pattern: /\bspawn\s+(\S+)\s+ENOENT\b/, reason: (m) => `\`${m[1]}\` could not be started (ENOENT)` },
  { pattern: /(?:^|\n)\s*(?:sh|bash|zsh)(?::\s*\d+)?:\s*(?:line \d+:\s*)?([\w./@-]+):\s*(?:command )?not found/i, reason: (m) => `\`${m[1]}\` is not installed (command not found)` },
  { pattern: /\b([\w./@-]+): command not found\b/, reason: (m) => `\`${m[1]}\` is not installed (command not found)` },
  { pattern: /'([\w./@-]+)' is not recognized as an internal or external command/, reason: (m) => `\`${m[1]}\` is not installed` },
  { pattern: /npm (?:ERR!|error) (?:code )?ENOENT/i, reason: () => "npm could not find a file it needs (ENOENT)" },
  { pattern: /ENOENT[^\n]*node_modules/, reason: () => "dependencies are not installed (node_modules missing)" },
  { pattern: /ERR_MODULE_NOT_FOUND[^\n]*node_modules|node_modules[^\n]*ERR_MODULE_NOT_FOUND/, reason: () => "dependencies are not installed (node_modules missing)" },
];

function isBareModule(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(specifier) && !specifier.startsWith("@/") && !specifier.startsWith("~/");
}

function normalize(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Classify a failed verification step from its output and exit code.
 * `changedFiles` are the task's workspace-relative changed files: a
 * missing-module error raised FROM a changed file is the change's own
 * doing (an import of an uninstalled package), so it stays a code failure.
 */
export function classifyVerifyFailure(input: {
  output: string;
  code: number | null;
  changedFiles?: string[];
}): VerifyFailureClass {
  const output = input.output ?? "";
  const changed = new Set((input.changedFiles ?? []).map(normalize));
  const lines = output.split(/\r?\n/);

  const tsErrors = lines
    .map((line) => TS_ERROR_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  if (tsErrors.length > 0) {
    const reasons: string[] = [];
    for (const match of tsErrors) {
      const file = normalize(match[1] ?? "");
      const code = match[2];
      const message = match[3] ?? "";
      if (TS_ENV_CODES.has(code)) {
        reasons.push(`${code}: ${message.trim()}`);
        continue;
      }
      if (code === "TS2307" || code === "TS7016") {
        const module = MISSING_MODULE.exec(message)?.[1] ?? /module ['"]([^'"]+)['"]/.exec(message)?.[1];
        const fromChanged = file !== "" && changed.has(file);
        if (module && isBareModule(module) && (!fromChanged || module.startsWith("@types/"))) {
          reasons.push(`${code}: ${message.trim()}`);
          continue;
        }
      }
      return { kind: "code" };
    }
    return { kind: "env", reason: summarize(reasons) };
  }

  for (const rule of GENERIC_ENV) {
    const match = output.match(rule.pattern);
    if (match) return { kind: "env", reason: rule.reason(match) };
  }
  // Node runtime "Cannot find module 'vitest'" (a dependency, not a file of the change).
  const runtimeMissing = lines
    .map((line) => MISSING_MODULE.exec(line)?.[1])
    .filter((specifier): specifier is string => typeof specifier === "string");
  if (runtimeMissing.length > 0 && runtimeMissing.every(isBareModule)) {
    return { kind: "env", reason: `dependency not installed: ${[...new Set(runtimeMissing)].slice(0, 3).join(", ")}` };
  }
  if (input.code === 127) return { kind: "env", reason: "command not found (exit code 127)" };
  return { kind: "code" };
}

function summarize(reasons: string[]): string {
  const unique = [...new Set(reasons)];
  return `${unique.slice(0, 3).join("; ")}${unique.length > 3 ? ` (+${unique.length - 3} more)` : ""}`;
}

/**
 * The main checkout of a git worktree (`.git` is a file "gitdir:
 * <main>/.git/worktrees/<name>"), or null when `dir` is not a linked
 * worktree.
 */
export async function mainCheckoutOf(dir: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(path.join(dir, ".git"));
    if (!stat.isFile()) return null;
    const raw = await fs.readFile(path.join(dir, ".git"), "utf-8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(raw)?.[1]?.trim();
    if (!gitdir) return null;
    const absolute = path.resolve(dir, gitdir);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const index = absolute.lastIndexOf(marker);
    if (index === -1) return null;
    return absolute.slice(0, index);
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Give a task worktree the main checkout's dependencies before verification
 * runs: for the worktree root and each package directory given, when the
 * worktree has a package.json but no node_modules and the main checkout has
 * one at the same relative path, symlink it. Returns the linked directories
 * (workspace-relative, "." for the root). Never throws: a failed link just
 * leaves verification to report the environment failure.
 */
export async function ensureWorktreeDependencies(workspacePath: string, packageDirs: string[] = []): Promise<string[]> {
  const root = path.resolve(workspacePath);
  const main = await mainCheckoutOf(root);
  if (!main || path.resolve(main) === root) return [];
  const linked: string[] = [];
  const dirs = [...new Set([root, ...packageDirs.map((dir) => path.resolve(root, dir))])];
  for (const dir of dirs) {
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    const rel = path.relative(root, dir);
    const target = path.join(dir, "node_modules");
    const source = path.join(main, rel, "node_modules");
    try {
      if (!(await exists(path.join(dir, "package.json")))) continue;
      // lstat: a dangling symlink still counts as "present", leave it alone.
      const present = await fs.lstat(target).then(() => true, () => false);
      if (present || !(await exists(source))) continue;
      await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      linked.push(rel === "" ? "." : rel.replace(/\\/g, "/"));
    } catch {
      // Best effort.
    }
  }
  return linked;
}

/**
 * The run-state verification status for a set of checks: any failure is
 * "failed"; otherwise an environment-skipped check makes it "skipped_env"
 * (with the reasons as details, so acceptance and approval show them);
 * all passed is "passed"; anything else "skipped". Shared by the verify loop and finalize.
 */
export function verificationStatus(
  checks: Array<{ name: string; status: string; details?: string; environment?: string }>
): { status: "passed" | "failed" | "skipped" | "skipped_env"; details?: string } {
  const failed = checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    return { status: "failed", details: failed.map((c) => `${c.name}: ${c.details ?? ""}`).join("; ") || undefined };
  }
  const env = checks.filter((c) => c.environment);
  if (env.length > 0) {
    return { status: "skipped_env", details: env.map((c) => `${c.name}: ${c.environment}`).join("; ") };
  }
  const allPassed = checks.length > 0 && checks.every((c) => c.status === "passed");
  return { status: allPassed ? "passed" : "skipped" };
}

