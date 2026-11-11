"use node";

/**
 * Read-only repo snapshot for chat replies (Plan 015 complement): gives
 * chat agents structural context (folder tree + key files) so structural
 * questions can be answered from evidence, not guesses. Confined to the
 * project workspace, no writes, no secrets, bounded size.
 */
import { applyInstructionBudget, formatInstructionChain, INSTRUCTION_FILE, type InstructionSource } from "../projectInstructions";

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

/**
 * D4: the project instruction chain for chat (root AGENTS.md, then the
 * user-global ~/.fhara/AGENTS.md; chat has no allowedPaths), read with the
 * same budget rules as the worker (lib/projectInstructions.ts).
 */
export async function readChatInstructions(workspaceRoot: string, userGlobalPath?: string | null): Promise<string> {
  const fs = await import("node:fs/promises");
  const sources: InstructionSource[] = [];
  const read = async (file: string) => {
    try {
      return (await fs.readFile(file, "utf8")).slice(0, 64 * 1024);
    } catch {
      return null;
    }
  };
  const base = workspaceRoot.replace(/[\\/]+$/, "");
  const root = await fs.realpath(`${base}/${INSTRUCTION_FILE}`).catch(() => null);
  const baseReal = await fs.realpath(base).catch(() => base);
  const rootText = root && root === `${baseReal}/${INSTRUCTION_FILE}` ? await read(root) : null;
  if (rootText !== null) sources.push({ scope: "root", path: INSTRUCTION_FILE, depth: 0, text: rootText });
  const userPath = userGlobalPath === undefined ? `${(await import("node:os")).homedir()}/.fhara/${INSTRUCTION_FILE}` : userGlobalPath;
  const userText = userPath ? await read(userPath) : null;
  if (userText !== null) sources.push({ scope: "user", path: `~/.fhara/${INSTRUCTION_FILE}`, depth: 0, text: userText });
  return formatInstructionChain(applyInstructionBudget(sources));
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
  const instructions = await readChatInstructions(workspaceRoot);
  return `Workspace snapshot (${workspaceRoot}):\n${tree}${rest}\n\n${heads.join("\n\n")}${instructions ? `\n\n${instructions}` : ""}`.trim();
}
