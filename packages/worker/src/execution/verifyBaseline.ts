// Pattern ported from SWE-agent (https://github.com/SWE-agent/SWE-agent, commit 3ea751c),
// tools/edit_anthropic/bin/str_replace_editor (pre_edit_lint / post_edit_lint,
// format_flake8_output(previous_errors_string=...): keep only errors that are new).
// SPDX-License-Identifier: MIT. Copyright (c) 2024 John Yang, Carlos E. Jimenez, et al.
// Rewritten in TypeScript for whole verification commands. See THIRD_PARTY_NOTICES.md.
import { wenv } from "@fhara/config/worker";
import { execFile } from "node:child_process";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Pre-change baseline for verification (multi-repo adoption R1, pattern
 * from SWE-agent's pre/post lint diff: only errors that are NEW after the
 * edit count).
 *
 * When a verification step fails, the same command is re-run once in a
 * temporary `git worktree` that holds the tree as it was before the task:
 * HEAD (nothing is committed while a task runs, in the user's tree and in
 * a task worktree alike), plus the workspace's own uncommitted edits to
 * files the task did NOT change. The task's files come from HEAD (absent
 * when the task created them). A failure counts as pre-existing only when
 * every failure it names also shows up there.
 *
 * Results are cached per repository HEAD + tree state + command + cwd, so
 * a verify loop pays for each baseline command once.
 */

/** ORCHESTRATOR_VERIFY_BASELINE=0 turns the baseline run off (heuristic only). */
export function baselineEnabled(env?: NodeJS.ProcessEnv): boolean {
  return wenv("ORCHESTRATOR_VERIFY_BASELINE", env);
}

export interface BaselineRun {
  code: number | null;
  output: string;
}

export interface BaselineTree {
  /** Repository top level of the workspace. */
  repoRoot: string;
  /** The workspace directory inside the baseline tree. */
  workspaceDir: string;
  /** Cache key for the tree state (HEAD + overlay). */
  stateKey: string;
  /** Map a directory of the real workspace to the same directory in the baseline tree. */
  dirFor(realDir: string): string;
  /** Rewrite baseline-tree paths in an output to the real workspace's paths. */
  normalizeOutput(output: string): string;
  cleanup(): Promise<void>;
}

const MAX_OVERLAY_FILES = 2_000;
const RESULT_CACHE_LIMIT = 64;
const resultCache = new Map<string, BaselineRun>();

function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8", env: buildChildEnv({ GIT_TERMINAL_PROMPT: "0" }) },
      (error, stdout) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      }
    );
  });
}

function toPosix(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Paths in `git status --porcelain=v1 -z` output: [path, deleted]. */
export function parsePorcelainZ(raw: string): Array<{ path: string; deleted: boolean }> {
  const entries: Array<{ path: string; deleted: boolean }> = [];
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    entries.push({ path: file, deleted: x === "D" || y === "D" });
    // Renames / copies carry the source path as the next NUL field: the
    // source is gone from the working tree.
    if (x === "R" || x === "C") {
      const source = parts[i + 1];
      i += 1;
      if (source && x === "R") entries.push({ path: source, deleted: true });
    }
  }
  return entries;
}

/**
 * Create the baseline tree for `workspacePath`, or null when the workspace
 * is not inside a git repository with a HEAD commit (the caller falls back
 * to the file-name heuristic). Never throws.
 */
export async function createBaselineTree(params: {
  workspacePath: string;
  changedFiles: string[];
  /** Workspace-relative package dirs whose node_modules the baseline needs. */
  packageDirs?: string[];
}): Promise<BaselineTree | null> {
  const workspacePath = path.resolve(params.workspacePath);
  const top = await git(workspacePath, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return null;
  const repoRoot = path.resolve(top.stdout.trim());
  const head = await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || !head.stdout.trim()) return null;
  const headSha = head.stdout.trim();
  const workspaceRel = path.relative(repoRoot, workspacePath);
  if (workspaceRel.startsWith("..")) return null;

  // Task files, repository-relative.
  const taskFiles = new Set(
    params.changedFiles.map((file) => toPosix(path.relative(repoRoot, path.resolve(workspacePath, file))))
  );

  const status = await git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const overlay = status.code === 0
    ? parsePorcelainZ(status.stdout).filter(
        (entry) => !taskFiles.has(toPosix(entry.path)) && !toPosix(entry.path).split("/").includes("node_modules")
      )
    : [];
  if (overlay.length > MAX_OVERLAY_FILES) return null;

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-baseline-"));
  const treeDir = path.join(parent, "tree");
  const added = await git(repoRoot, ["worktree", "add", "--detach", "--quiet", treeDir, headSha], 120_000);
  if (added.code !== 0) {
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }

  const stateHash = createHash("sha1").update(headSha);
  try {
    for (const entry of overlay) {
      const rel = toPosix(entry.path);
      const target = path.join(treeDir, rel);
      if (entry.deleted) {
        await fs.rm(target, { force: true }).catch(() => undefined);
        stateHash.update(`D:${rel}\n`);
        continue;
      }
      const source = path.join(repoRoot, rel);
      try {
        const stat = await fs.lstat(source);
        if (!stat.isFile()) continue;
        const content = await fs.readFile(source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
        stateHash.update(`M:${rel}:`).update(createHash("sha1").update(content).digest("hex")).update("\n");
      } catch {
        // A file that vanished mid-copy: leave HEAD's version.
      }
    }
    // The task's own files stay as HEAD has them (a created file is absent).
    for (const rel of [...taskFiles].sort()) stateHash.update(`T:${rel}\n`);

    const workspaceDir = path.join(treeDir, workspaceRel);
    await linkDependencies(workspacePath, workspaceDir, params.packageDirs ?? []);

    const realTree = await fs.realpath(treeDir).catch(() => treeDir);
    const realWorkspace = await fs.realpath(workspacePath).catch(() => workspacePath);
    const realBaselineWorkspace = path.join(realTree, workspaceRel);

    return {
      repoRoot,
      workspaceDir,
      stateKey: stateHash.digest("hex"),
      dirFor(realDir: string) {
        const rel = path.relative(workspacePath, path.resolve(realDir));
        return rel.startsWith("..") ? workspaceDir : path.join(workspaceDir, rel);
      },
      normalizeOutput(output: string) {
        let text = output;
        for (const [from, to] of [
          [realBaselineWorkspace, realWorkspace],
          [workspaceDir, workspacePath],
        ] as const) {
          if (from && from !== to) text = text.split(from).join(to);
        }
        return text;
      },
      async cleanup() {
        await git(repoRoot, ["worktree", "remove", "--force", treeDir]).catch(() => undefined);
        await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
        await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
      },
    };
  } catch {
    await git(repoRoot, ["worktree", "remove", "--force", treeDir]).catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/** Symlink the workspace's node_modules (root + package dirs) into the baseline tree. */
async function linkDependencies(workspacePath: string, baselineDir: string, packageDirs: string[]): Promise<void> {
  const rels = [...new Set(["", ...packageDirs.map((dir) => path.relative(workspacePath, path.resolve(workspacePath, dir)))])];
  for (const rel of rels) {
    if (rel.startsWith("..")) continue;
    const source = path.join(workspacePath, rel, "node_modules");
    const target = path.join(baselineDir, rel, "node_modules");
    try {
      const real = await fs.realpath(source);
      const present = await fs.lstat(target).then(() => true, () => false);
      if (present) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(real, target, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // No node_modules there: the baseline run reports whatever it reports.
    }
  }
}

/** Cached baseline result for a command, if any. */
export function cachedBaseline(key: string): BaselineRun | undefined {
  return resultCache.get(key);
}

export function storeBaseline(key: string, run: BaselineRun): void {
  if (resultCache.size >= RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, run);
}

/** Cheap key for the baseline cache without creating a tree (HEAD + status + task files). */
export async function baselineCacheKey(params: {
  workspacePath: string;
  changedFiles: string[];
  command: string;
  cwd: string;
}): Promise<string | null> {
  const workspacePath = path.resolve(params.workspacePath);
  const head = await git(workspacePath, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || !head.stdout.trim()) return null;
  const status = await git(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return null;
  const task = new Set(params.changedFiles.map(toPosix));
  // Untracked/modified files outside the task change the baseline; their
  // content is not hashed here (mtime-free), so the key also carries the
  // status line itself. Good enough within one task's verify loop.
  const hash = createHash("sha1")
    .update(path.resolve(workspacePath))
    .update("\0")
    .update(head.stdout.trim())
    .update("\0")
    .update(status.stdout)
    .update("\0")
    .update([...task].sort().join("\n"))
    .update("\0")
    .update(params.command)
    .update("\0")
    .update(path.relative(workspacePath, path.resolve(params.cwd)));
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Failure signatures: what a failing check names, without line numbers
// (a change shifts lines) and without durations.
// ---------------------------------------------------------------------------

const SOURCE_EXT = "(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|css|scss)";
const TS_LINE = new RegExp(`^\\s*(.+?\\.${SOURCE_EXT})(?:\\((\\d+),(\\d+)\\)|:(\\d+):(\\d+))\\s*[:-]?\\s*-?\\s*error\\s+(TS\\d+):\\s*(.*)$`);
const LOC_LINE = new RegExp(`^\\s*(.+?\\.${SOURCE_EXT}):(\\d+)(?::(\\d+))?:?\\s+(.*\\S)\\s*$`);
const ESLINT_HEADER = new RegExp(`^((?:[A-Za-z]:)?[\\\\/]?(?:[^\\s:]+[\\\\/])*[^\\s:]+\\.${SOURCE_EXT})$`);
const ESLINT_ISSUE = /^\s+\d+:\d+\s+(error)\s+(.*?)\s{2,}(\S+)\s*$/;
const TEST_FAIL = /^\s*(?:FAIL|×|✗|✕|✖)\s+(.+?)\s*$/;
const JEST_BULLET = /^\s*●\s+(.+?)\s*$/;
const TAP_NOT_OK = /^\s*not ok\s+\d+\s+-?\s*(.+?)\s*$/;
const PYTEST_FAILED = /^\s*(?:FAILED|ERROR)\s+(\S+)/;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function stripTimings(text: string): string {
  return text
    .replace(/\s*\(?\d+(?:\.\d+)?\s*m?s\)?\s*$/g, "")
    .replace(/\s+\d+(?:\.\d+)?\s*m?s\b/g, "")
    .trim();
}

function relFile(raw: string, root: string, cwd: string): string {
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  const rel = path.relative(root, absolute);
  return toPosix(rel.startsWith("..") ? raw : rel);
}

/**
 * Line-number-free signatures of the failures a check output names: tsc
 * diagnostics, ESLint (stylish and unix/compact), `file:line:col` errors,
 * vitest/jest/TAP/pytest failed tests. Duplicates are kept (a multiset).
 */
export function failureSignatures(output: string, root: string, cwd: string = root): string[] {
  const signatures: string[] = [];
  let eslintFile: string | null = null;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) {
      eslintFile = null;
      continue;
    }
    const ts = TS_LINE.exec(line);
    if (ts) {
      signatures.push(`ts|${relFile(ts[1], root, cwd)}|${ts[6]}|${ts[7].trim()}`);
      continue;
    }
    const header = ESLINT_HEADER.exec(line.trim());
    if (header && !/^\s/.test(line)) {
      eslintFile = relFile(header[1], root, cwd);
      continue;
    }
    if (eslintFile) {
      const issue = ESLINT_ISSUE.exec(line);
      if (issue) {
        signatures.push(`eslint|${eslintFile}|${issue[3]}|${issue[2].trim()}`);
        continue;
      }
    }
    const test = TEST_FAIL.exec(line) ?? JEST_BULLET.exec(line) ?? TAP_NOT_OK.exec(line);
    if (test) {
      const name = stripTimings(test[1]);
      if (name) signatures.push(`test|${name}`);
      continue;
    }
    const py = PYTEST_FAILED.exec(line);
    if (py) {
      signatures.push(`test|${py[1]}`);
      continue;
    }
    const loc = LOC_LINE.exec(line);
    if (loc && /\berror\b|\[Error/i.test(loc[4])) {
      signatures.push(`loc|${relFile(loc[1], root, cwd)}|${loc[4].replace(/\s+/g, " ").trim()}`);
    }
  }
  return signatures;
}

/** Signatures in `after` that `before` does not account for (multiset difference). */
export function newFailures(after: string[], before: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const signature of before) remaining.set(signature, (remaining.get(signature) ?? 0) + 1);
  const fresh: string[] = [];
  for (const signature of after) {
    const left = remaining.get(signature) ?? 0;
    if (left > 0) remaining.set(signature, left - 1);
    else fresh.push(signature);
  }
  return fresh;
}

function normalizedTail(output: string, root: string): string {
  return stripAnsi(output)
    .split(root)
    .join("<root>")
    .split(/\r?\n/)
    .map((line) => line.replace(/\d+(?:\.\d+)?\s*m?s\b/g, "").replace(/\(\d+,\d+\)|:\d+:\d+/g, "").trim())
    .filter((line) => line && !/^\s*>\s/.test(line))
    .slice(-40)
    .join("\n");
}

export type BaselineVerdict =
  | { verdict: "pre_existing"; matched: number }
  | { verdict: "new"; newFailures: string[] }
  | { verdict: "unknown" };

/**
 * Compare a failed step's output with the same command on the baseline
 * tree (baseline output already normalized to the workspace's paths).
 *  - baseline passed → every failure is new;
 *  - named failures all reproduce → pre-existing;
 *  - nothing nameable: identical normalized output → pre-existing, else unknown
 *    (the caller keeps the failure).
 */
export function compareWithBaseline(params: {
  after: BaselineRun;
  before: BaselineRun;
  root: string;
  cwd: string;
}): BaselineVerdict {
  const { after, before, root, cwd } = params;
  const afterSigs = failureSignatures(after.output, root, cwd);
  if (before.code === 0) return { verdict: "new", newFailures: afterSigs };
  if (afterSigs.length > 0) {
    const beforeSigs = failureSignatures(before.output, root, cwd);
    const fresh = newFailures(afterSigs, beforeSigs);
    return fresh.length === 0 ? { verdict: "pre_existing", matched: afterSigs.length } : { verdict: "new", newFailures: fresh };
  }
  if (before.code === after.code && normalizedTail(after.output, root) === normalizedTail(before.output, root)) {
    return { verdict: "pre_existing", matched: 0 };
  }
  return { verdict: "unknown" };
}

/** Human-readable form of a signature for a check's details. */
export function describeSignature(signature: string): string {
  const [kind, ...rest] = signature.split("|");
  if (kind === "ts" && rest.length >= 3) return `${rest[0]}: ${rest[1]} ${rest.slice(2).join("|")}`;
  if (kind === "eslint" && rest.length >= 3) return `${rest[0]}: ${rest.slice(2).join("|")} (${rest[1]})`;
  if (kind === "loc" && rest.length >= 2) return `${rest[0]}: ${rest.slice(1).join("|")}`;
  if (kind === "test") return `failed test: ${rest.join("|")}`;
  return signature;
}
