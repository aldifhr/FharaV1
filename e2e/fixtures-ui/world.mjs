// "Verify the world, not the self-report" for the live worker flows: snapshot
// the throwaway repo before a flow, then check that nothing outside the paths
// the flow's plan may touch changed (modified, added or removed), instead of
// trusting what the task reports about itself.
//
// Pattern from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness,
// MIT License, Copyright (c) 2026 DeepSeek), docs/testing.md, "Verify the world,
// not the self-report". Written for Fhara; no code copied. The worker's unit
// tests use the same check from packages/worker/tests/helpers/assertUntouched.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORE = [".git", "node_modules", ".moagent-worktrees"];

/** Map of repo-relative path → sha256 for every file under `root`. */
export function snapshotTree(root, ignore = DEFAULT_IGNORE) {
  const out = new Map();
  const walk = (dir) => {
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

export function diffTrees(before, after) {
  const changes = [];
  for (const [p, hash] of before) {
    if (!after.has(p)) changes.push({ path: p, change: "removed" });
    else if (after.get(p) !== hash) changes.push({ path: p, change: "modified" });
  }
  for (const p of after.keys()) if (!before.has(p)) changes.push({ path: p, change: "added" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function isAllowedPath(file, allowedPaths) {
  return allowedPaths.some((raw) => {
    const allowed = String(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    return allowed === "" || allowed === "." || file === allowed || file.startsWith(`${allowed}/`);
  });
}

/** Changes under `root` since `before` that lie outside `allowedPaths`. */
export function changesOutside(before, root, allowedPaths, ignore = DEFAULT_IGNORE) {
  return diffTrees(before, snapshotTree(root, ignore)).filter((c) => !isAllowedPath(c.path, allowedPaths));
}

/**
 * The union of the `allowedPaths` of every subtask in every planner reply of
 * a mock script (following `extends`). A flow with no planned code change
 * allows nothing: the repo must come out byte-identical.
 */
export function allowedPathsOfScript(file, seen = new Set()) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return [];
  seen.add(abs);
  const script = JSON.parse(fs.readFileSync(abs, "utf8"));
  const out = new Set();
  for (const rule of script.rules ?? []) {
    for (const reply of [...(rule.reply !== undefined ? [rule.reply] : []), ...(rule.replies ?? [])]) {
      let plan;
      try {
        plan = JSON.parse(reply);
      } catch {
        continue;
      }
      for (const subtask of Array.isArray(plan?.subtasks) ? plan.subtasks : []) {
        for (const p of subtask.allowedPaths ?? []) out.add(p);
      }
    }
  }
  if (script.extends) for (const p of allowedPathsOfScript(path.resolve(path.dirname(abs), script.extends), seen)) out.add(p);
  return [...out].sort();
}
