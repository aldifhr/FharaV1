"use node";

/**
 * Read-only repo snapshot for chat replies (Plan 015 complement): gives
 * chat agents structural context (folder tree + key files) so structural
 * questions can be answered from evidence, not guesses. Confined to the
 * project workspace, no writes, no secrets, bounded size.
 */
const SNAPSHOT_SEGMENTS = new Set([
  "node_modules", ".git", ".next", "dist", "out", ".qa", ".turbo",
  "coverage", "build", ".convex", "_generated", ".openmausbot", ".vscode",
]);

function isSafeSnapshotPath(workspaceRoot: string, rel: string): boolean {
  if (!rel) return false;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments.some((s) => s === ".." || s.startsWith("."))) return false;
  const base = workspaceRoot.replace(/[\\/]+$/, "");
  const full = `${base}/${rel.replace(/\\/g, "/")}`;
  return full.startsWith(base + "/") || full === base;
}

export async function readRepoSnapshot(workspaceRoot: string): Promise<string> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(workspaceRoot);
  } catch {
    return "";
  }
  const lines: string[] = [];
  let total = 0;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 3 || total > 200) return;
    let entries: string[];
    try {
      entries = await fs.readdir(rel ? `${workspaceRoot}/${rel}` : workspaceRoot);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (total > 200) break;
      if (SNAPSHOT_SEGMENTS.has(name)) continue;
      const child = rel ? `${rel}/${name}` : name;
      if (!isSafeSnapshotPath(workspaceRoot, child)) continue;
      total += 1;
      const stat = await fs.stat(`${workspaceRoot}/${child}`).catch(() => null);
      const indent = "  ".repeat(depth);
      if (stat?.isDirectory()) {
        lines.push(`${indent}${name}/`);
        if (depth < 3) await walk(child, depth + 1);
      } else {
        lines.push(`${indent}${name}${stat ? ` (${stat.size}b)` : ""}`);
      }
    }
  }
  await walk("", 0);
  const keyFiles = ["package.json", "tsconfig.json", ".env.example", "README.md"];
  const heads: string[] = [];
  for (const keyFile of keyFiles) {
    try {
      const raw = await fs.readFile(`${workspaceRoot}/${keyFile}`, "utf8");
      heads.push(`--- ${keyFile} ---\n${raw.slice(0, 1200)}`);
    } catch {}
  }
  const tree = lines.slice(0, 200).join("\n");
  const rest = lines.length > 200 ? `\n… (${lines.length - 200} more)` : "";
  return `Workspace snapshot (${workspaceRoot}):\n${tree}${rest}\n\n${heads.join("\n\n")}`.trim();
}
