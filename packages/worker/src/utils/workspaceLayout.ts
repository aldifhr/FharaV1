import { promises as fs } from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", "coverage", ".cache"]);

/**
 * Real workspace-relative paths (directories end with "/"), two levels
 * deep, for the planner prompt. Without it the planner guessed allowedPaths
 * from its prompt example ("apps/web") and the executor then refused
 * legitimate files such as a root styles.css (e2e ULTRA). Best effort:
 * an unreadable workspace yields an empty list.
 */
export async function listWorkspaceLayout(root: string, maxEntries = 120): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (SKIP.has(entry.name)) continue;
      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/");
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        if (depth < 2) await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  await walk(root, 1);
  return out;
}
