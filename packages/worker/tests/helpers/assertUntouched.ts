/**
 * "Verify the world, not the self-report": snapshot a worktree before a
 * flow, then check after it that every file outside the paths the flow may
 * touch is byte-identical (nothing changed, added or removed there).
 *
 * Pattern from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness,
 * MIT License, Copyright (c) 2026 DeepSeek), docs/testing.md, "Verify the
 * world, not the self-report" ("Assert untouched files are byte-identical").
 * Written for Fhara; no code copied. The e2e flows use the same check from
 * e2e/fixtures-ui/world.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Path → sha256 of every regular file (and symlink target text) under a root. */
export type TreeSnapshot = Map<string, string>;

/** Never part of the world a flow is judged on. */
const DEFAULT_IGNORE = [".git", "node_modules", ".moagent-worktrees"];

export function snapshotTree(root: string, ignore: readonly string[] = DEFAULT_IGNORE): TreeSnapshot {
  const out: TreeSnapshot = new Map();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (ignore.some((i) => rel === i || rel.startsWith(`${i}/`))) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(abs)}`);
      else if (entry.isFile()) out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

export interface TreeChange {
  path: string;
  change: "modified" | "added" | "removed";
}

export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeChange[] {
  const changes: TreeChange[] = [];
  for (const [p, hash] of before) {
    if (!after.has(p)) changes.push({ path: p, change: "removed" });
    else if (after.get(p) !== hash) changes.push({ path: p, change: "modified" });
  }
  for (const p of after.keys()) if (!before.has(p)) changes.push({ path: p, change: "added" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether `file` lies inside one of `allowedPaths` (a file or a directory, repo-relative). */
export function isAllowedPath(file: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((raw) => {
    const allowed = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    return allowed === "" || allowed === "." || file === allowed || file.startsWith(`${allowed}/`);
  });
}

/** Changes outside `allowedPaths` since `before` (empty = the world outside is untouched). */
export function changesOutside(before: TreeSnapshot, root: string, allowedPaths: readonly string[], ignore?: readonly string[]): TreeChange[] {
  return diffTrees(before, snapshotTree(root, ignore)).filter((c) => !isAllowedPath(c.path, allowedPaths));
}

/** Throws, listing every offending path, when anything outside `allowedPaths` changed since `before`. */
export function assertUntouched(before: TreeSnapshot, root: string, allowedPaths: readonly string[], ignore?: readonly string[]): void {
  const outside = changesOutside(before, root, allowedPaths, ignore);
  if (!outside.length) return;
  throw new Error(`files outside [${allowedPaths.join(", ")}] changed: ${outside.map((c) => `${c.path} (${c.change})`).join(", ")}`);
}
